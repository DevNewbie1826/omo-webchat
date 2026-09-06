package omorpc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

// The fixture supplies only bytes, not decoded results: calls, correlation,
// cancellation, framing, and event delivery all run through the real client.
func oversizedPipe(t *testing.T, limit int) (*Client, net.Conn, *json.Decoder) {
	t.Helper()
	conn, peer := net.Pipe()
	if err := peer.SetDeadline(time.Now().Add(15 * time.Second)); err != nil {
		t.Fatal(err)
	}
	cfg := normalizeConfig(Config{MaxLineBytes: limit})
	c := &Client{cfg: cfg, pending: make(map[string]pendingRequest), writeGate: make(chan struct{}, 1)}
	c.writeGate <- struct{}{}
	ep := &connectionEpoch{number: 1, conn: conn, events: newEventStream(cfg.EventBuffer, &c.dropped)}
	c.current = ep
	c.wg.Add(1)
	go func() { defer c.wg.Done(); c.readLoop(ep) }()
	t.Cleanup(func() { peer.Close(); c.Close() })
	return c, peer, json.NewDecoder(peer)
}

func oversizedCall(t *testing.T, c *Client, wire *json.Decoder, ctx context.Context, cmd Command) (string, <-chan callResult) {
	t.Helper()
	done := make(chan callResult, 1)
	token, _ := c.CurrentEpoch()
	go func() {
		resp, epoch, err := c.CallInEpochToken(ctx, token, cmd)
		done <- callResult{response: resp, epoch: epoch, err: err}
	}()
	var req struct {
		ID   string `json:"id"`
		Type string `json:"type"`
	}
	if err := wire.Decode(&req); err != nil {
		t.Fatal(err)
	}
	if req.Type != cmd.commandName() || req.ID == "" {
		t.Fatalf("request = %+v", req)
	}
	return req.ID, done
}

func oversizedResult(t *testing.T, done <-chan callResult) callResult {
	t.Helper()
	select {
	case got := <-done:
		return got
	case <-time.After(15 * time.Second):
		t.Fatal("call did not settle")
		return callResult{}
	}
}

func historyRecord(id, data string, dataFirst bool) string {
	header := fmt.Sprintf(`"id":%q,"type":"response","command":"get_entries","sessionId":"rpc-a","success":true`, id)
	if dataFirst {
		return `{"data":` + data + `,` + header + "}\n"
	}
	return `{` + header + `,"data":` + data + "}\n"
}

func peerRecords(id string) string {
	return fmt.Sprintf(`{"id":%q,"type":"response","command":"get_state","success":true,"sessionId":"rpc-b","data":{"messageCount":7}}`+"\n"+`{"type":"agent_idle","sessionId":"rpc-b"}`+"\n", id)
}

func checkOversizedPeer(t *testing.T, c *Client, token EpochToken, events <-chan *Event, done <-chan callResult) {
	t.Helper()
	got := oversizedResult(t, done)
	if got.err != nil || got.response == nil || string(got.response.Data) != `{"messageCount":7}` || got.epoch != token {
		t.Fatalf("peer response = %+v (error: %v)", got, got.err)
	}
	ev := awaitEvent(t, events, 15*time.Second)
	if ev.Type != "agent_idle" || ev.SessionID != "rpc-b" {
		t.Fatalf("peer event = %+v", ev)
	}
	if !c.EpochCurrent(token) || c.EventsInEpoch(token) != events {
		t.Fatal("shared epoch changed")
	}
}

func TestClientOversizedHistoryKeepsPeerLive(t *testing.T) {
	for _, tc := range []struct {
		name      string
		limit     int
		data      string
		dataFirst bool
		fragment  int
	}{
		{"default_cap_giant_field", 0, `{"entries":[{"text":"` + strings.Repeat("x", defaultMaxLineBytes+1024) + `"}]}`, false, 4093},
		{"data_before_header", 1024, `{"entries":[{"text":"` + strings.Repeat("x", 8192) + `"}]}`, true, 37},
		{"escaped_nested_fragmented", 1024, `{"entries":[{"text":"` + strings.Repeat(`\"\\\n\u1234`, 512) + `","nested":[true,false,null,-1.23e+4,{"id":"fake","type":"response"}]}]}`, true, 1},
		{"many_entries", 1024, `{"entries":[` + strings.Repeat(`{"text":"x"},`, 1024) + `{"text":"last"}]}`, false, 79},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, peer, wire := oversizedPipe(t, tc.limit)
			token, events := c.CurrentEpoch()
			id, done := oversizedCall(t, c, wire, t.Context(), GetEntries{SessionID: "rpc-a"})
			peerID, peerDone := oversizedCall(t, c, wire, t.Context(), GetState{SessionID: "rpc-b"})
			record := historyRecord(id, tc.data, tc.dataFirst)
			if !json.Valid([]byte(record)) || len(record) <= c.cfg.MaxLineBytes {
				t.Fatal("fixture must be valid and oversized")
			}
			// Fragment at the actual transport, including inside escape sequences.
			stream := record + peerRecords(peerID)
			for len(stream) > 0 {
				n := min(tc.fragment, len(stream))
				if _, err := io.WriteString(peer, stream[:n]); err != nil {
					t.Logf("wire write: %v", err)
					break
				}
				stream = stream[n:]
			}
			got := oversizedResult(t, done)
			if !errors.Is(got.err, ErrFrameTooLarge) || errors.Is(got.err, ErrDisconnected) || got.response != nil || got.epoch != token {
				t.Fatalf("history result = %+v; want request-local ErrFrameTooLarge, nil response, original epoch (error: %v)", got, got.err)
			}
			checkOversizedPeer(t, c, token, events, peerDone)
			peerID, peerDone = oversizedCall(t, c, wire, t.Context(), GetState{SessionID: "rpc-b"})
			if _, err := io.WriteString(peer, peerRecords(peerID)); err != nil {
				t.Fatal(err)
			}
			checkOversizedPeer(t, c, token, events, peerDone)
			if c.DroppedEvents() != 0 {
				t.Fatalf("matched response counted as loss: %d", c.DroppedEvents())
			}
		})
	}
}

func TestClientOversizedHistoryLateAndDuplicate(t *testing.T) {
	for _, mode := range []string{"cancelled", "cancelled_during_discard", "duplicate", "retained_cancelled"} {
		t.Run(mode, func(t *testing.T) {
			c, peer, wire := oversizedPipe(t, 1024)
			token, events := c.CurrentEpoch()
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			var id string
			var done <-chan callResult
			var completion chan callResult
			if mode == "retained_cancelled" {
				completion = make(chan callResult, 1)
				returned := make(chan callResult, 1)
				go func() {
					resp, err := c.CallRetainedInEpoch(ctx, token, GetEntries{SessionID: "rpc-a"}, func(r *Response, e EpochToken, err error) { completion <- callResult{response: r, epoch: e, err: err} })
					returned <- callResult{response: resp, err: err}
				}()
				var req struct {
					ID string `json:"id"`
				}
				if err := wire.Decode(&req); err != nil {
					t.Fatal(err)
				}
				id, done = req.ID, returned
			} else {
				id, done = oversizedCall(t, c, wire, ctx, GetEntries{SessionID: "rpc-a"})
			}
			record := historyRecord(id, `"`+strings.Repeat("x", 8192)+`"`, true)
			if mode == "cancelled_during_discard" {
				// No LF has arrived: completion cannot be claimed yet, regardless
				// of reader scheduling. The write signals exact byte delivery.
				if _, err := io.WriteString(peer, record[:4096]); err != nil {
					t.Logf("wire write: %v", err)
				}
				record = record[4096:]
			}
			if mode != "duplicate" {
				cancel()
				if got := oversizedResult(t, done); !errors.Is(got.err, ErrWrittenUnanswered) || !errors.Is(got.err, context.Canceled) {
					t.Fatalf("cancelled call = %+v", got)
				}
			} else {
				if _, err := io.WriteString(peer, historyRecord(id, `{"entries":[]}`, false)); err != nil {
					t.Fatal(err)
				}
				if got := oversizedResult(t, done); got.err != nil {
					t.Fatal(got.err)
				}
			}
			peerID, peerDone := oversizedCall(t, c, wire, t.Context(), GetState{SessionID: "rpc-b"})
			_, writeErr := io.WriteString(peer, record+peerRecords(peerID))
			if writeErr != nil {
				t.Logf("wire write: %v", writeErr)
			}
			if completion != nil {
				got := oversizedResult(t, completion)
				if !errors.Is(got.err, ErrFrameTooLarge) || errors.Is(got.err, ErrDisconnected) || got.response != nil || got.epoch != token {
					t.Fatalf("retained completion = %+v (error: %v)", got, got.err)
				}
			}
			checkOversizedPeer(t, c, token, events, peerDone)
			want := uint64(1)
			if completion != nil {
				want = 0
			}
			if c.DroppedEvents() != want {
				t.Fatalf("lost unsolicited records = %d, want %d", c.DroppedEvents(), want)
			}
		})
	}
}

func TestClientOversizedUnrecoverableRemainsFatal(t *testing.T) {
	large := `"` + strings.Repeat("x", 8192) + `"`
	for _, tc := range []struct {
		name      string
		record    func(string) string
		cmd       Command
		closePeer bool
	}{
		{"malformed_after_limit", func(id string) string { return historyRecord(id, large+`,`, true) }, GetEntries{}, false},
		{"malformed_before_limit", func(id string) string { return historyRecord(id, `[1,]`+strings.Repeat(" ", 8192), true) }, GetEntries{}, false},
		{"invalid_escape", func(id string) string { return historyRecord(id, `"`+strings.Repeat("x", 8192)+`\q"`, true) }, GetEntries{}, false},
		{"literal_newline", func(id string) string { return historyRecord(id, `"`+strings.Repeat("x", 8192)+"\n"+`"`, true) }, GetEntries{}, false},
		{"no_newline", func(id string) string { return strings.TrimSuffix(historyRecord(id, large, true), "\n") }, GetEntries{}, true},
		{"truncated", func(id string) string { return `{"data":` + large }, GetEntries{}, true},
		{"trailing_object", func(id string) string { return strings.TrimSuffix(historyRecord(id, large, true), "\n") + "{}\n" }, GetEntries{}, false},
		{"oversized_event", func(id string) string { return `{"type":"agent_idle","data":` + large + "}\n" }, GetEntries{}, false},
		{"wrong_command_for_id", func(id string) string { return historyRecord(id, large, true) }, Prompt{SessionID: "rpc-a", Message: "uncertain"}, false},
		{"oversized_prompt", func(id string) string {
			return strings.Replace(historyRecord(id, large, true), `"get_entries"`, `"prompt"`, 1)
		}, Prompt{SessionID: "rpc-a", Message: "uncertain"}, false},
		{"missing_id", func(id string) string { return historyRecord("", large, true) }, GetEntries{}, false},
		{"duplicate_id_member", func(id string) string {
			return strings.Replace(historyRecord(id, large, true), `"type":`, `"id":"other","type":`, 1)
		}, GetEntries{}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, peer, wire := oversizedPipe(t, 1024)
			token, events := c.CurrentEpoch()
			id, done := oversizedCall(t, c, wire, t.Context(), tc.cmd)
			if _, err := io.WriteString(peer, tc.record(id)); err != nil {
				t.Logf("wire write: %v", err)
			}
			if tc.closePeer {
				if err := peer.Close(); err != nil {
					t.Fatal(err)
				}
			}
			got := oversizedResult(t, done)
			if !errors.Is(got.err, ErrDisconnected) || got.response != nil || got.epoch != (EpochToken{}) {
				t.Fatalf("unrecoverable result = %+v", got)
			}
			awaitChannelClosed(t, events, 15*time.Second)
			if c.EpochCurrent(token) {
				t.Fatal("unrecoverable input left epoch current")
			}
		})
	}
}

func TestDecoderOversizedPublicContract(t *testing.T) {
	d := NewDecoderWithLimit(strings.NewReader(historyRecord("r1", `"`+strings.Repeat("x", 8192)+`"`, true)), 1024)
	in, err := d.Decode()
	if in != nil || !errors.Is(err, ErrFrameTooLarge) {
		t.Fatalf("Decode = %+v, %v", in, err)
	}
}
