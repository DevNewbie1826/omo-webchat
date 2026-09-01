package omorpc

// Adversarial-edge scenario tests: the hostile-input and lifecycle matrix
// the happy-path contract tests deliberately skip. Every scenario is
// scripted against the mock daemon at the wire level.
//
// Invariant mapping (docs/v2/invariants.md), only where the invariant is
// expressible at the transport layer:
//
//   - Malformed wire input (invariant 18 canon "malformed is fatal"): a
//     line-oriented JSON stream cannot be resynchronized mid-frame, so a
//     corrupt line kills the connection EPOCH (typed ErrDisconnected for
//     in-flight calls) — never the client: the next Call transparently
//     reconnects and event subscription continues on the new epoch.
//   - Response-before-exit (invariant 5): a response already on the wire
//     when the connection dies must settle its caller with success, not
//     with ErrDisconnected.
//   - Epoch / session isolation (invariant 2 analogue): correlation is
//     per connection; identical wire ids on two clients of the same
//     daemon never cross, and one client's session handle is invisible
//     to the other's routing.
//   - Per-session FIFO (invariants 12/13 analogue): one session's event
//     order survives daemon-side interleaving with another session's.
//   - Slow-consumer policy (invariant 12 analogue): the event queue is
//     bounded by Config.EventBuffer. Overflow drops the oldest unread event
//     and increments Client.DroppedEvents, while socket reads and calls stay
//     live.
//
// NOT expressible at this layer (owned by the engine above it): durable
// notice gating, eviction, resume safety, run/compaction lifecycle.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"
)

// requestIDs returns the wire correlation ids of every logged request of
// the given command, in arrival order.
func requestIDs(d *mockDaemon, cmd string) []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	var ids []string
	for _, r := range d.requests {
		if typ, _ := r["type"].(string); typ == cmd {
			id, _ := r["id"].(string)
			ids = append(ids, id)
		}
	}
	return ids
}

// drainEvents reads exactly n events or fails within budget.
func drainEvents(t *testing.T, ch <-chan *Event, n int, budget time.Duration) []*Event {
	t.Helper()
	got := make([]*Event, 0, n)
	deadline := time.NewTimer(budget)
	defer deadline.Stop()
	for len(got) < n {
		select {
		case ev, ok := <-ch:
			if !ok {
				t.Fatalf("event channel closed after %d/%d events", len(got), n)
			}
			got = append(got, ev)
		case <-deadline.C:
			t.Fatalf("timed out draining events: %d/%d", len(got), n)
		}
	}
	return got
}

// TestEdgeMalformedLineFailsEpochClientSurvives: a corrupt line is fatal to
// the connection epoch (a newline-JSON stream cannot resynchronize mid-
// frame; v1 invariant "malformed is fatal") but never to the client: the
// in-flight call fails with the typed transport error and the next call
// transparently reconnects. "Connection stays healthy" is realized at the
// client level, not the socket level — this pins that deliberate policy.
func TestEdgeMalformedLineFailsEpochClientSurvives(t *testing.T) {
	t.Run("garbage_line", func(t *testing.T) {
		d := newMockDaemon(t)
		c := dialForTest(t, d, Config{})
		mustOpenSession(t, c, t.TempDir())
		oldCh := c.Events()
		baseHandshakes := d.Handshakes()

		d.WriteRaw([]byte("{definitely not json\n"))

		awaitChannelClosed(t, oldCh, testAwaitTimeout)
		mustCall(t, c, ListSessions{})
		if got := d.Handshakes(); got != baseHandshakes+1 {
			t.Errorf("handshakes after recovery = %d, want %d (one reconnect handshake)", got, baseHandshakes+1)
		}
		// Event subscription continues on the new epoch.
		newCh := c.Events()
		d.Emit(map[string]any{"type": "agent_idle", "sessionId": "rpc-1"})
		if ev := awaitEvent(t, newCh, testAwaitTimeout); ev.Type != "agent_idle" {
			t.Fatalf("event after reconnect: %+v", ev)
		}
	})
	t.Run("json_but_not_object", func(t *testing.T) {
		d := newMockDaemon(t)
		c := dialForTest(t, d, Config{})
		mustOpenSession(t, c, t.TempDir())
		oldCh := c.Events()
		baseHandshakes := d.Handshakes()

		d.WriteRaw([]byte("[1,2,3]\n"))

		awaitChannelClosed(t, oldCh, testAwaitTimeout)
		mustCall(t, c, ListSessions{})
		if got := d.Handshakes(); got != baseHandshakes+1 {
			t.Errorf("handshakes after recovery = %d, want %d", got, baseHandshakes+1)
		}
	})
	t.Run("corrupt_while_inflight", func(t *testing.T) {
		d := newMockDaemon(t)
		releaseEntries := d.BlockHandler(CmdGetEntries)
		defer releaseEntries()
		c := dialForTest(t, d, Config{})
		opened := mustOpenSession(t, c, t.TempDir())

		errCh := make(chan error, 1)
		go func() {
			_, err := c.Call(context.Background(), GetEntries{SessionID: opened.SessionID})
			errCh <- err
		}()
		d.awaitRequest(t, CmdGetEntries, testAwaitTimeout)
		d.WriteRaw([]byte("{\"broken\"\n"))

		select {
		case err := <-errCh:
			if !errors.Is(err, ErrDisconnected) {
				t.Fatalf("in-flight call after corrupt stream: %v, want ErrDisconnected", err)
			}
		case <-time.After(testAwaitTimeout):
			t.Fatal("corrupt stream did not settle the in-flight call")
		}
		// The client itself is unharmed.
		mustCall(t, c, ListSessions{})
	})
}

// TestEdgeStrayResponseIDNeverDisturbsPending: a response envelope with an
// unknown id, and a response for an already-cancelled caller, must neither
// panic, nor settle, nor delay the pending calls. The client's policy:
// unsolicited responses are forwarded on the event stream (type
// "response"), never silently dropped.
func TestEdgeStrayResponseIDNeverDisturbsPending(t *testing.T) {
	d := newMockDaemon(t)
	releaseEntries := d.BlockHandler(CmdGetEntries)
	releaseList := d.BlockHandler(CmdListSessions)
	defer releaseEntries()
	defer releaseList()
	c := dialForTest(t, d, Config{})
	opened := mustOpenSession(t, c, t.TempDir())
	evCh := c.Events()

	type result struct {
		resp *Response
		err  error
	}
	resA := make(chan result, 1)
	go func() {
		r, err := c.Call(context.Background(), GetEntries{SessionID: opened.SessionID})
		resA <- result{r, err}
	}()
	d.awaitRequest(t, CmdGetEntries, testAwaitTimeout)

	// A response envelope whose id matches nothing pending, crossing the
	// stream while the call is in flight.
	d.WriteRaw([]byte(`{"id":"stray-crossed","type":"response","command":"phantom","success":true,"data":{"x":1}}` + "\n"))

	// A caller that cancels while its request is in flight: once Call
	// returns, the pending entry is gone, so the daemon's late reply is
	// unsolicited from the client's point of view.
	ctxB, cancelB := context.WithCancel(context.Background())
	resB := make(chan result, 1)
	go func() {
		r, err := c.Call(ctxB, ListSessions{})
		resB <- result{r, err}
	}()
	d.awaitRequest(t, CmdListSessions, testAwaitTimeout)
	cancelB()
	releaseList()
	select {
	case got := <-resB:
		if !errors.Is(got.err, context.Canceled) {
			t.Fatalf("cancelled caller: %v, want context.Canceled", got.err)
		}
	case <-time.After(testAwaitTimeout):
		t.Fatal("cancelled call did not return")
	}

	// The untouched pending call still settles with its own response.
	releaseEntries()
	select {
	case got := <-resA:
		if got.err != nil {
			t.Fatalf("pending call disturbed by stray responses: %v", got.err)
		}
		if !got.resp.Success || got.resp.Command != CmdGetEntries {
			t.Fatalf("pending call got the wrong response: %+v", got.resp)
		}
		wantID, _ := d.lastRequest(CmdGetEntries)["id"].(string)
		if got.resp.ID != wantID {
			t.Fatalf("pending call settled with id %q, want its own %q", got.resp.ID, wantID)
		}
	case <-time.After(testAwaitTimeout):
		t.Fatal("pending call never settled")
	}

	// Both unsolicited responses surface on the event stream (any order).
	ev1 := awaitEvent(t, evCh, testAwaitTimeout)
	ev2 := awaitEvent(t, evCh, testAwaitTimeout)
	strayID, _ := d.lastRequest(CmdListSessions)["id"].(string)
	sawCrossed, sawCancelled := false, false
	for _, ev := range []*Event{ev1, ev2} {
		if ev.Type != "response" {
			t.Fatalf("unsolicited response must surface as a response-tagged event, got %+v", ev)
		}
		switch {
		case strings.Contains(string(ev.Raw), "stray-crossed"):
			sawCrossed = true
		case strayID != "" && strings.Contains(string(ev.Raw), strayID):
			sawCancelled = true
		default:
			t.Fatalf("response event %q matches neither stray id", ev.Raw)
		}
	}
	if !sawCrossed || !sawCancelled {
		t.Fatalf("expected one crossed-id stray and one cancelled-caller stray, got %q / %q", ev1.Raw, ev2.Raw)
	}
}

// TestEdgeTwoClientsSameSocketIDNeverCrosses: two clients multiplexed on
// one daemon socket are fully isolated at the correlation layer. Both
// fresh clients deterministically allocate the SAME wire id (identical
// allocation sequence on separate connections) — exactly the crossing
// hazard — yet each caller settles with its own session-tagged response,
// and the daemon hands out distinct epoch-local session handles.
func TestEdgeTwoClientsSameSocketIDNeverCrosses(t *testing.T) {
	d := newMockDaemon(t)
	releaseEntries := d.BlockHandler(CmdGetEntries)
	cA := dialForTest(t, d, Config{})
	cB := dialForTest(t, d, Config{})
	openA := mustOpenSession(t, cA, t.TempDir())
	openB := mustOpenSession(t, cB, t.TempDir())
	if openA.SessionID == openB.SessionID {
		t.Fatalf("epoch-local session handles must be distinct per connection, got %q twice", openA.SessionID)
	}

	type result struct {
		resp *Response
		err  error
	}
	resA := make(chan result, 1)
	resB := make(chan result, 1)
	go func() {
		r, err := cA.Call(context.Background(), GetEntries{SessionID: openA.SessionID})
		resA <- result{r, err}
	}()
	go func() {
		r, err := cB.Call(context.Background(), GetEntries{SessionID: openB.SessionID})
		resB <- result{r, err}
	}()
	d.awaitRequestCount(t, CmdGetEntries, 2, testAwaitTimeout)
	releaseEntries()

	var rA, rB result
	select {
	case rA = <-resA:
	case <-time.After(testAwaitTimeout):
		t.Fatal("client A call did not return")
	}
	select {
	case rB = <-resB:
	case <-time.After(testAwaitTimeout):
		t.Fatal("client B call did not return")
	}
	if rA.err != nil || rB.err != nil {
		t.Fatalf("calls failed: %v / %v", rA.err, rB.err)
	}
	if rA.resp.SessionID != openA.SessionID {
		t.Errorf("client A received a response tagged %q, want its own %q (routing crossed)",
			rA.resp.SessionID, openA.SessionID)
	}
	if rB.resp.SessionID != openB.SessionID {
		t.Errorf("client B received a response tagged %q, want its own %q (routing crossed)",
			rB.resp.SessionID, openB.SessionID)
	}
	ids := requestIDs(d, CmdGetEntries)
	if len(ids) != 2 {
		t.Fatalf("expected exactly two %s requests on the wire, got %v", CmdGetEntries, ids)
	}
	if ids[0] != ids[1] {
		t.Fatalf("test presupposes identical wire ids across the two connections (same allocation "+
			"sequence); got %v — if the id scheme changed, update this test to force a collision", ids)
	}
	// Identical ids on two sockets, zero crossing: correlation is
	// per-connection epoch, never global.
}

// TestEdgePerSessionFIFOUnderInterleave: events for session A and session
// B interleaved by the daemon preserve each session's relative order.
func TestEdgePerSessionFIFOUnderInterleave(t *testing.T) {
	d := newMockDaemon(t)
	c := dialForTest(t, d, Config{})
	mustOpenSession(t, c, t.TempDir())
	ch := c.Events()

	emit := func(sid string, n int) {
		d.Emit(map[string]any{"type": "edge_fifo", "sessionId": sid, "n": n})
	}
	// Daemon-side interleaving: A and B alternate, and A gets two more
	// frames before B's second.
	emit("s-A", 1)
	emit("s-B", 1)
	emit("s-A", 2)
	emit("s-A", 3)
	emit("s-B", 2)

	evs := drainEvents(t, ch, 5, testAwaitTimeout)
	wantA := []int{1, 2, 3}
	wantB := []int{1, 2}
	var gotA, gotB []int
	for i, ev := range evs {
		if ev.Type != "edge_fifo" {
			t.Fatalf("event %d: type = %q, want edge_fifo", i, ev.Type)
		}
		var p struct {
			N int `json:"n"`
		}
		if err := json.Unmarshal(ev.Raw, &p); err != nil {
			t.Fatalf("event %d payload: %v", i, err)
		}
		switch ev.SessionID {
		case "s-A":
			gotA = append(gotA, p.N)
		case "s-B":
			gotB = append(gotB, p.N)
		default:
			t.Fatalf("event %d tagged with unexpected session %q", i, ev.SessionID)
		}
	}
	if !slices.Equal(gotA, wantA) {
		t.Errorf("session A order = %v, want %v (relative order must be preserved)", gotA, wantA)
	}
	if !slices.Equal(gotB, wantB) {
		t.Errorf("session B order = %v, want %v", gotB, wantB)
	}
}

// TestEdgeSlowSubscriberPolicyDropOldest pins the hard bound and overflow
// policy: a stalled subscriber does not block calls, only the newest
// EventBuffer records survive, and the exact number dropped is observable.
func TestEdgeSlowSubscriberPolicyDropOldest(t *testing.T) {
	d := newMockDaemon(t)
	c := dialForTest(t, d, Config{EventBuffer: 2})
	opened := mustOpenSession(t, c, t.TempDir())
	ch := c.Events()

	const n = 200
	for i := 1; i <= n; i++ {
		d.Emit(map[string]any{"type": "edge_flood", "sessionId": opened.SessionID, "n": i})
	}
	// The response is ordered after the event writes, proving the reader has
	// processed the flood while the subscriber remained stalled.
	mustCall(t, c, ListSessions{})

	evs := drainEvents(t, ch, 2, testAwaitTimeout)
	for i, ev := range evs {
		var payload struct {
			N int `json:"n"`
		}
		if err := json.Unmarshal(ev.Raw, &payload); err != nil {
			t.Fatalf("event %d payload: %v", i, err)
		}
		want := n - 1 + i
		if payload.N != want {
			t.Fatalf("retained event %d has seq %d, want newest seq %d", i, payload.N, want)
		}
	}
	if got := c.DroppedEvents(); got != n-2 {
		t.Fatalf("DroppedEvents = %d, want %d", got, n-2)
	}
}

// TestEdgeCRLFFragmentedAndBatchedFrames: server-side hostility at the
// framing layer — an event split across three socket writes with a CRLF
// terminator, and two full frames batched into a single write with CRLF
// separators — decodes with payload and order intact.
func TestEdgeCRLFFragmentedAndBatchedFrames(t *testing.T) {
	d := newMockDaemon(t)
	c := dialForTest(t, d, Config{})
	opened := mustOpenSession(t, c, t.TempDir())
	ch := c.Events()

	d.WriteRaw([]byte(`{"type":"edge_frag","sessionId":"` + opened.SessionID + `","n":1`))
	d.WriteRaw([]byte(`,"extra":"split-across`))
	d.WriteRaw([]byte(`-writes"}` + "\r\n"))
	d.WriteRaw([]byte(`{"type":"edge_frag","sessionId":"` + opened.SessionID + `","n":2}` + "\r\n" +
		`{"type":"edge_frag","sessionId":"` + opened.SessionID + `","n":3}` + "\r\n"))

	evs := drainEvents(t, ch, 3, testAwaitTimeout)
	for i, ev := range evs {
		if ev.Type != "edge_frag" {
			t.Fatalf("event %d: type = %q, want edge_frag", i, ev.Type)
		}
		if ev.SessionID != opened.SessionID {
			t.Fatalf("event %d: sessionId = %q, want %q", i, ev.SessionID, opened.SessionID)
		}
		var p struct {
			N     int    `json:"n"`
			Extra string `json:"extra"`
		}
		if err := json.Unmarshal(ev.Raw, &p); err != nil {
			t.Fatalf("event %d payload: %v", i, err)
		}
		if p.N != i+1 {
			t.Fatalf("event %d: seq = %d, want %d (order not preserved through fragmentation)", i, p.N, i+1)
		}
		if i == 0 && p.Extra != "split-across-writes" {
			t.Fatalf("fragmented payload corrupted: %q", p.Extra)
		}
	}
}

// TestEdgeCloseWithInflightRequestTypedErrorNoLeak: Close while a request
// is in flight settles it with the typed ErrDisconnected, closes the event
// stream, makes subsequent calls fail fast, is idempotent — and leaks no
// goroutines (reader, event pump, daemon-side handler all settle).
func TestEdgeCloseWithInflightRequestTypedErrorNoLeak(t *testing.T) {
	d := newMockDaemon(t)
	releaseEntries := d.BlockHandler(CmdGetEntries)
	defer releaseEntries()
	c := dialForTest(t, d, Config{})
	opened := mustOpenSession(t, c, t.TempDir())

	oldCh := c.Events()

	errCh := make(chan error, 1)
	go func() {
		_, err := c.Call(context.Background(), GetEntries{SessionID: opened.SessionID})
		errCh <- err
	}()
	d.awaitRequest(t, CmdGetEntries, testAwaitTimeout)

	if err := c.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	select {
	case err := <-errCh:
		if !errors.Is(err, ErrDisconnected) {
			t.Fatalf("in-flight request after Close: %v, want ErrDisconnected", err)
		}
	case <-time.After(testAwaitTimeout):
		t.Fatal("in-flight request was not settled by Close")
	}
	awaitChannelClosed(t, oldCh, testAwaitTimeout)

	select {
	case _, ok := <-c.Events():
		if ok {
			t.Fatal("Events() after Close must be a closed channel")
		}
	default:
		t.Fatal("Events() after Close must not block or return an open channel")
	}
	if err := c.Close(); err != nil {
		t.Errorf("second Close: %v, want nil (idempotent)", err)
	}
	if _, err := c.Call(context.Background(), ListSessions{}); !errors.Is(err, ErrDisconnected) {
		t.Errorf("Call after Close: %v, want ErrDisconnected", err)
	}

}

// TestEdgeResponseOnWireBeforeDropStillSucceeds encodes the
// response-before-exit invariant at the transport layer: the daemon
// answers a request and dies in the same breath (response bytes on the
// wire, then FIN). The caller must observe SUCCESS — the response wins
// because it precedes the EOF on the stream — never ErrDisconnected.
func TestEdgeDuplicateResponseWrongCommandDoesNotSettleRequest(t *testing.T) {
	d := newMockDaemon(t)
	release := d.BlockHandler(CmdGetEntries)
	defer release()
	c := dialForTest(t, d, Config{})
	opened := mustOpenSession(t, c, t.TempDir())
	events := c.Events()

	type result struct {
		response *Response
		err      error
	}
	resultCh := make(chan result, 1)
	go func() {
		response, err := c.Call(context.Background(), GetEntries{SessionID: opened.SessionID})
		resultCh <- result{response, err}
	}()
	d.awaitRequest(t, CmdGetEntries, testAwaitTimeout)
	id, _ := d.lastRequest(CmdGetEntries)["id"].(string)
	d.WriteRaw(fmt.Appendf(nil, `{"id":%q,"type":"response","command":"wrong_command","success":true}`+"\n", id))
	wrong := awaitEvent(t, events, testAwaitTimeout)
	if wrong.Type != "response" || !strings.Contains(string(wrong.Raw), "wrong_command") {
		t.Fatalf("wrong-command duplicate was not surfaced as unsolicited: %+v", wrong)
	}
	select {
	case got := <-resultCh:
		t.Fatalf("wrong command settled pending request: %+v", got)
	default:
	}
	release()
	got := <-resultCh
	if got.err != nil || got.response.Command != CmdGetEntries {
		t.Fatalf("real response did not settle request: response=%+v err=%v", got.response, got.err)
	}
	// A later duplicate with the settled id is unsolicited as well.
	d.WriteRaw(fmt.Appendf(nil, `{"id":%q,"type":"response","command":"get_entries","success":true}`+"\n", id))
	if duplicate := awaitEvent(t, events, testAwaitTimeout); duplicate.Type != "response" {
		t.Fatalf("settled duplicate event = %+v", duplicate)
	}
}

func TestEdgeOversizedLineFailsConnectionAtBound(t *testing.T) {
	d := newMockDaemon(t)
	c := dialForTest(t, d, Config{MaxLineBytes: 1 << 20})
	oldEvents := c.Events()
	d.WriteRaw(bytes.Repeat([]byte{'x'}, 10<<20))
	awaitChannelClosed(t, oldEvents, testAwaitTimeout)
	// The client remains reusable through a fresh bounded epoch.
	mustCall(t, c, ListSessions{})
}

func TestEdgeResponseOnWireBeforeDropStillSucceeds(t *testing.T) {
	d := newMockDaemon(t)
	releaseEntries := d.BlockHandler(CmdGetEntries)
	defer releaseEntries()
	c := dialForTest(t, d, Config{})
	opened := mustOpenSession(t, c, t.TempDir())
	oldCh := c.Events()

	type result struct {
		resp *Response
		err  error
	}
	res := make(chan result, 1)
	go func() {
		r, err := c.Call(context.Background(), GetEntries{SessionID: opened.SessionID})
		res <- result{r, err}
	}()
	d.awaitRequest(t, CmdGetEntries, testAwaitTimeout)
	id, _ := d.lastRequest(CmdGetEntries)["id"].(string)
	if id == "" {
		t.Fatal("daemon never logged the in-flight request id")
	}

	// Answer and die in the same breath; CRLF terminator for good measure.
	env := fmt.Sprintf(`{"id":%q,"type":"response","command":"get_entries","sessionId":%q,"success":true,"data":{"entries":[]}}`,
		id, opened.SessionID)
	d.WriteRawThenDrop([]byte(env + "\r\n"))

	select {
	case got := <-res:
		if got.err != nil {
			t.Fatalf("response on the wire before death must settle the caller with success, got %v", got.err)
		}
		if got.resp == nil || !got.resp.Success || got.resp.ID != id {
			t.Fatalf("late response wrong: %+v", got.resp)
		}
		var data struct {
			Entries []json.RawMessage `json:"entries"`
		}
		if err := json.Unmarshal(got.resp.Data, &data); err != nil || len(data.Entries) != 0 {
			t.Fatalf("data payload not intact: %s (%v)", got.resp.Data, err)
		}
	case <-time.After(testAwaitTimeout):
		t.Fatal("response-before-exit did not settle the caller")
	}
	// The connection is gone right after the delivered response.
	awaitChannelClosed(t, oldCh, testAwaitTimeout)
}
