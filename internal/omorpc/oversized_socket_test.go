package omorpc

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"
)

// Public API + real isolated socket + handshake, with two opened routes. The
// daemon's history handler is gated while synthetic response bytes are injected.
func TestClientOversizedHistorySocket(t *testing.T) {
	d := newMockDaemon(t)
	release := d.BlockHandler(CmdGetEntries)
	defer release()
	c := dialForTest(t, d, Config{})
	a := mustOpenSession(t, c, t.TempDir())
	b := mustOpenSession(t, c, t.TempDir())
	token, events := c.CurrentEpoch()
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	done := make(chan callResult, 1)
	go func() {
		r, e, err := c.CallInEpochToken(ctx, token, GetEntries{SessionID: a.SessionID, Since: "disk-leaf"})
		done <- callResult{response: r, epoch: e, err: err}
	}()
	d.awaitRequest(t, CmdGetEntries, testAwaitTimeout)
	req := d.lastRequest(CmdGetEntries)
	d.Emit(map[string]any{"id": req["id"], "command": CmdGetEntries, "type": "response", "success": true, "sessionId": a.SessionID, "data": map[string]any{"entries": []any{map[string]any{"text": strings.Repeat("x", 12<<20)}}}})
	got := oversizedResult(t, done)
	if !errors.Is(got.err, ErrFrameTooLarge) || errors.Is(got.err, ErrDisconnected) || got.response != nil || got.epoch != token {
		t.Fatalf("history: %v, epoch=%+v", got.err, got.epoch)
	}
	resp, epoch, err := c.CallInEpochToken(ctx, token, Prompt{SessionID: b.SessionID, Message: "peer-still-live"})
	if err != nil || resp == nil || !resp.Success || string(resp.Data) != `{"accepted":true}` || resp.SessionID != b.SessionID || epoch != token {
		t.Fatalf("peer: %+v, %v", resp, err)
	}
	d.Emit(map[string]any{"type": "agent_idle", "sessionId": b.SessionID})
	ev := awaitEvent(t, events, testAwaitTimeout)
	if ev.Type != "agent_idle" || ev.SessionID != b.SessionID || !c.EpochCurrent(token) || d.Handshakes() != 1 {
		t.Fatalf("peer not live: %+v, handshakes=%d", ev, d.Handshakes())
	}
}

func TestClientOversizedHandshakeRemainsFatal(t *testing.T) {
	d := newMockDaemon(t)
	ctx, cancel := context.WithTimeout(t.Context(), testAwaitTimeout)
	defer cancel()
	c, err := DialWithConfig(ctx, d.SocketPath(), Config{MaxLineBytes: 64})
	if c != nil {
		c.Close()
		t.Fatal("oversized handshake established a client")
	}
	if !errors.Is(err, ErrDisconnected) {
		t.Fatalf("handshake = %v", err)
	}
}

func TestClientOversizedUnknownHistoryDoesNotSettlePrompt(t *testing.T) {
	c, peer, wire := oversizedPipe(t, 1024)
	token, events := c.CurrentEpoch()
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	_, prompt := oversizedCall(t, c, wire, ctx, Prompt{SessionID: "rpc-a", Message: "uncertain"})
	peerID, peerDone := oversizedCall(t, c, wire, t.Context(), GetState{SessionID: "rpc-b"})
	if _, err := io.WriteString(peer, historyRecord("unknown-id", `"`+strings.Repeat("x", 8192)+`"`, true)+peerRecords(peerID)); err != nil {
		t.Logf("wire write: %v", err)
	}
	checkOversizedPeer(t, c, token, events, peerDone)
	cancel()
	got := oversizedResult(t, prompt)
	if !errors.Is(got.err, ErrWrittenUnanswered) || !errors.Is(got.err, context.Canceled) || got.response != nil {
		t.Fatalf("prompt no longer uncertain: %v", got.err)
	}
	if c.DroppedEvents() != 1 {
		t.Fatalf("unknown response losses = %d", c.DroppedEvents())
	}
}

func TestClientOversizedHistoryOnlySettlesMatchingID(t *testing.T) {
	c, peer, wire := oversizedPipe(t, 1024)
	token, _ := c.CurrentEpoch()
	firstID, first := oversizedCall(t, c, wire, t.Context(), GetEntries{SessionID: "rpc-a"})
	secondID, second := oversizedCall(t, c, wire, t.Context(), GetEntries{SessionID: "rpc-b"})
	if _, err := io.WriteString(peer, historyRecord(secondID, `"`+strings.Repeat("x", 8192)+`"`, true)+historyRecord(firstID, `{"entries":[]}`, false)); err != nil {
		t.Logf("wire write: %v", err)
	}
	large := oversizedResult(t, second)
	small := oversizedResult(t, first)
	if !errors.Is(large.err, ErrFrameTooLarge) || large.response != nil || large.epoch != token {
		t.Fatalf("oversized correlation: %v", large.err)
	}
	if small.err != nil || small.response == nil || small.response.ID != firstID || small.epoch != token {
		t.Fatalf("other history correlation: %+v, %v", small.response, small.err)
	}
}

func TestClientOversizedStaleEpochCannotSettleCurrentRequest(t *testing.T) {
	c, peer, wire := oversizedPipe(t, 1024)
	token, _ := c.CurrentEpoch()
	id, done := oversizedCall(t, c, wire, t.Context(), GetEntries{SessionID: "rpc-a"})
	stale := &connectionEpoch{number: token.epoch.number - 1}
	if c.settleOversizedHistory(stale, &oversizedHistoryError{id: id, command: CmdGetEntries}) {
		t.Fatal("stale reader claimed current request")
	}
	if _, err := io.WriteString(peer, historyRecord(id, `{"entries":[]}`, false)); err != nil {
		t.Fatal(err)
	}
	got := oversizedResult(t, done)
	if got.err != nil || got.response == nil || got.epoch != token || c.DroppedEvents() != 0 {
		t.Fatalf("stale reader affected current epoch: %v", got.err)
	}
}
