package omorpc

// Client contract tests: the executable specification of the omorpc
// Client. These tests are RED against the client.go stub (every test must
// fail with "not implemented") and are the acceptance criteria for the
// implementation node.

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest/transport"
	"net"
	"slices"
	"sync"
	"testing"
	"time"
)

const testAwaitTimeout = 2 * time.Second

// dialForTest dials the daemon or fails the test immediately, so a RED run
// reports "not implemented" instead of a nil-pointer panic.
func dialForTest(t *testing.T, d *mockDaemon, cfg Config) *Client {
	t.Helper()
	c, err := DialWithConfig(context.Background(), d.SocketPath(), cfg)
	if err != nil {
		t.Fatalf("DialWithConfig: %v", err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func mustOpenSession(t *testing.T, c *Client, cwd string) OpenSessionData {
	t.Helper()
	resp := mustCall(t, c, OpenSession{CWD: cwd})
	var opened OpenSessionData
	if err := json.Unmarshal(resp.Data, &opened); err != nil {
		t.Fatalf("decode open_session data: %v", err)
	}
	return opened
}

func mustCall(t *testing.T, c *Client, cmd Command) *Response {
	t.Helper()
	resp, err := c.Call(context.Background(), cmd)
	if err != nil {
		t.Fatalf("Call %s: %v", cmd.commandName(), err)
	}
	if resp == nil {
		t.Fatalf("Call %s: nil response", cmd.commandName())
	}
	if !resp.Success {
		t.Fatalf("Call %s: not successful: %v", cmd.commandName(), resp.Err())
	}
	return resp
}

// awaitEvent receives the next event or fails on timeout / early close.
func awaitEvent(t *testing.T, ch <-chan *Event, timeout time.Duration) *Event {
	t.Helper()
	select {
	case ev, ok := <-ch:
		if !ok {
			t.Fatal("event channel closed while waiting for an event")
		}
		return ev
	case <-time.After(timeout):
		t.Fatal("timed out waiting for event")
		return nil
	}
}

// awaitChannelClosed fails unless ch closes (possibly with buffered
// leftovers drained first) within timeout.
func awaitChannelClosed(t *testing.T, ch <-chan *Event, timeout time.Duration) {
	t.Helper()
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	for {
		select {
		case _, ok := <-ch:
			if !ok {
				return
			}
		case <-deadline.C:
			t.Fatal("timed out waiting for event channel to close")
		}
	}
}

// TestClientDialHandshake: Dial performs the get_protocol_info handshake
// before returning; the client exposes the negotiated info and the daemon
// saw exactly one handshake.
func TestClientDialHandshake(t *testing.T) {
	d := newMockDaemon(t)
	c := dialForTest(t, d, Config{})

	info := c.ProtocolInfo()
	if info == nil {
		t.Fatal("ProtocolInfo is nil after Dial: handshake not performed")
	}
	if info.ProtocolVersion != 1 {
		t.Errorf("ProtocolInfo.ProtocolVersion = %d, want 1", info.ProtocolVersion)
	}
	if !slices.Contains(info.Capabilities, "multi_session") {
		t.Errorf("ProtocolInfo.Capabilities = %v, want to contain multi_session", info.Capabilities)
	}
	if info.Mode != "multi" {
		t.Errorf("ProtocolInfo.Mode = %q, want %q", info.Mode, "multi")
	}
	if got := c.ServerVersion(); got != "1.2.3" {
		t.Errorf("ServerVersion() = %q, want %q", got, "1.2.3")
	}
	if got := d.Handshakes(); got != 1 {
		t.Errorf("daemon handshakes = %d, want exactly 1", got)
	}
}

func TestClientDetachedCallSurvivesCallerCancellation(t *testing.T) {
	d := newMockDaemon(t)
	release := d.BlockHandler(CmdOpenSession)
	c := dialForTest(t, d, Config{})
	ctx, cancel := context.WithCancel(context.Background())
	completed := make(chan callResult, 1)
	if err := c.CallDetached(ctx, OpenSession{CWD: t.TempDir()}, func(resp *Response, epoch EpochToken, err error) {
		completed <- callResult{response: resp, epoch: epoch, err: err}
	}); err != nil {
		t.Fatalf("CallDetached: %v", err)
	}
	d.awaitRequest(t, CmdOpenSession, testAwaitTimeout)
	cancel()
	release()
	select {
	case got := <-completed:
		if got.err != nil || got.response == nil || !got.response.Success || got.epoch.epoch == nil {
			t.Fatalf("detached completion = %+v", got)
		}
	case <-time.After(testAwaitTimeout):
		t.Fatal("detached call did not retain its correlation")
	}
}

// TestClientRequestCorrelation: two overlapping requests resolve to their
// own responses — ids never cross, replies may arrive out of order. The
// daemon delays the first command so its reply overtakes the second's
// unless correlation is id-based.
func TestClientRequestCorrelation(t *testing.T) {
	d := newMockDaemon(t)
	releaseList := d.BlockHandler(CmdListSessions)
	c := dialForTest(t, d, Config{})

	type result struct {
		resp *Response
		err  error
	}
	resA := make(chan result, 1)
	resB := make(chan result, 1)
	go func() {
		r, err := c.Call(context.Background(), ListSessions{})
		resA <- result{r, err}
	}()
	// Deterministic overlap: wait until the daemon has read the first
	// (delayed) request before sending the second one.
	d.awaitRequest(t, CmdListSessions, testAwaitTimeout)
	go func() {
		r, err := c.Call(context.Background(), OpenSession{CWD: t.TempDir()})
		resB <- result{r, err}
	}()
	rB := <-resB
	releaseList()
	rA := <-resA
	if rA.err != nil {
		t.Fatalf("Call %s: %v", CmdListSessions, rA.err)
	}
	if rB.err != nil {
		t.Fatalf("Call %s: %v", CmdOpenSession, rB.err)
	}
	if rA.resp.Command != CmdListSessions || rB.resp.Command != CmdOpenSession {
		t.Fatalf("responses crossed: first caller got %q, second got %q",
			rA.resp.Command, rB.resp.Command)
	}
	if rA.resp.ID == "" || rB.resp.ID == "" {
		t.Fatalf("responses must echo a correlation id, got %q and %q", rA.resp.ID, rB.resp.ID)
	}
	if rA.resp.ID == rB.resp.ID {
		t.Fatalf("two requests must not share a correlation id, both got %q", rA.resp.ID)
	}
	if !rA.resp.Success || !rB.resp.Success {
		t.Fatalf("both responses must succeed: %v / %v", rA.resp.Err(), rB.resp.Err())
	}
}

// TestClientEventSubscription: unsolicited records arrive on the
// subscriber channel tagged with their sessionId, and unrecognized event
// types normalize through AsUnknownEvent without loss.
func TestClientEventSubscription(t *testing.T) {
	d := newMockDaemon(t)
	c := dialForTest(t, d, Config{})
	opened := mustOpenSession(t, c, t.TempDir())

	evCh := c.Events()
	if evCh == nil {
		t.Fatal("Events() returned nil channel")
	}

	d.Emit(map[string]any{"type": "agent_idle", "sessionId": opened.SessionID})
	ev := awaitEvent(t, evCh, testAwaitTimeout)
	if ev.Type != "agent_idle" {
		t.Errorf("event type = %q, want %q", ev.Type, "agent_idle")
	}
	if ev.SessionID != opened.SessionID {
		t.Errorf("event sessionId = %q, want %q", ev.SessionID, opened.SessionID)
	}

	const exotic = "hologram_uplink"
	d.Emit(map[string]any{"type": exotic, "sessionId": opened.SessionID, "payload": map[string]any{"k": "v"}, "meta": map[string]any{"revision": 7}})
	ev = awaitEvent(t, evCh, testAwaitTimeout)
	unk := AsUnknownEvent(ev)
	if unk.Type != UnknownEventType {
		t.Errorf("unknown envelope type = %q, want %q", unk.Type, UnknownEventType)
	}
	if unk.EventType != exotic {
		t.Errorf("unknown envelope preserved eventType = %q, want %q", unk.EventType, exotic)
	}
	var record struct {
		Type      string `json:"type"`
		SessionID string `json:"sessionId"`
		Payload   struct {
			K string `json:"k"`
		} `json:"payload"`
		Meta struct {
			Revision int `json:"revision"`
		} `json:"meta"`
	}
	if err := json.Unmarshal(unk.Payload, &record); err != nil || record.Type != exotic ||
		record.SessionID != opened.SessionID || record.Payload.K != "v" || record.Meta.Revision != 7 {
		t.Errorf("unknown event record not preserved completely: %s (%v)", unk.Payload, err)
	}
}

func TestClientNotifyExtensionUIResponseOneWay(t *testing.T) {
	d := newMockDaemon(t)
	c := dialForTest(t, d, Config{})
	confirmed := false
	if err := c.Notify(context.Background(), ExtensionUIResponse{
		SessionID: "rpc-routing-7",
		ID:        "native-dialog-7",
		Confirmed: &confirmed,
	}); err != nil {
		t.Fatalf("Notify: %v", err)
	}
	d.awaitRequest(t, CmdExtensionUIResponse, testAwaitTimeout)
	request := d.lastRequest(CmdExtensionUIResponse)
	if request["id"] != "native-dialog-7" || request["confirmed"] != false {
		t.Fatalf("notification fields = %#v", request)
	}
	if request["sessionId"] != "rpc-routing-7" {
		t.Fatalf("extension_ui_response sessionId = %#v, want routing handle %q", request["sessionId"], "rpc-routing-7")
	}
}

// TestClientOpenSessionDistinctIDs: open_session returns the epoch-local
// routing handle AND the durable state.sessionId; the two are distinct and
// subsequent session-scoped commands are addressed by the handle.
func TestClientOpenSessionDistinctIDs(t *testing.T) {
	d := newMockDaemon(t)
	c := dialForTest(t, d, Config{})

	opened := mustOpenSession(t, c, t.TempDir())
	if opened.SessionID != "rpc-1" {
		t.Fatalf("epoch-local handle = %q, want %q", opened.SessionID, "rpc-1")
	}
	if opened.State.SessionID == "" {
		t.Fatal("state.sessionId (durable id) is empty")
	}
	if opened.State.SessionID == opened.SessionID {
		t.Fatalf("durable id %q must be distinct from the epoch-local handle", opened.State.SessionID)
	}
	if opened.State.SessionFile == "" {
		t.Error("state.sessionFile is empty")
	}

	// Routing goes through the handle; the durable id must never travel
	// on the wire as a command address.
	resp := mustCall(t, c, GetEntries{SessionID: opened.SessionID})
	if resp.SessionID != opened.SessionID {
		t.Errorf("session-scoped response echoes top-level sessionId %q, want %q",
			resp.SessionID, opened.SessionID)
	}
	last := d.lastRequest(CmdGetEntries)
	if last == nil {
		t.Fatal("daemon never received get_entries")
	}
	if got, _ := last["sessionId"].(string); got != opened.SessionID {
		t.Errorf("client addressed get_entries with sessionId %q, want the rpc handle %q",
			got, opened.SessionID)
	}
}

// TestClientStableErrorMapping: a success:false envelope surfaces as a
// *StableError with the exact stable code, alongside the raw response.
func TestClientStableErrorMapping(t *testing.T) {
	d := newMockDaemon(t)
	c := dialForTest(t, d, Config{})
	opened := mustOpenSession(t, c, t.TempDir())

	d.FailNext(CmdPrompt, ErrCodeUnknownSession)
	resp, err := c.Call(context.Background(), Prompt{SessionID: opened.SessionID, Message: "hi"})
	if err == nil {
		t.Fatal("success:false response must produce a non-nil error")
	}
	if resp == nil {
		t.Fatal("Call must return the response envelope alongside the error")
	}
	if resp.Success {
		t.Error("response envelope must carry success=false")
	}
	var se *StableError
	if !errors.As(err, &se) {
		t.Fatalf("error is %T (%v), want *StableError", err, err)
	}
	if se.Code != ErrCodeUnknownSession {
		t.Errorf("StableError.Code = %q, want %q", se.Code, ErrCodeUnknownSession)
	}
	if se.Detail != "" {
		t.Errorf("StableError.Detail = %q, want empty for an exact code", se.Detail)
	}
	if se.Error() != ErrCodeUnknownSession {
		t.Errorf("StableError.Error() = %q, want %q", se.Error(), ErrCodeUnknownSession)
	}
}

// TestClientDisconnectFailsPending: a mid-request disconnect fails all
// pending requests with ErrDisconnected, closes the event channel, and the
// daemon's epoch-local counter increments on the next Dial.
func TestClientDisconnectFailsPending(t *testing.T) {
	d := newMockDaemon(t)
	c := dialForTest(t, d, Config{})
	opened := mustOpenSession(t, c, t.TempDir())
	token, evCh := c.CurrentEpoch()

	releaseEntries := d.BlockHandler(CmdGetEntries)
	defer releaseEntries()
	errCh := make(chan error, 1)
	go func() {
		_, err := c.Call(context.Background(), GetEntries{SessionID: opened.SessionID})
		errCh <- err
	}()
	// Deterministic disconnect: only after the request is in flight and
	// its (delayed) reply has not been written yet.
	d.awaitRequest(t, CmdGetEntries, testAwaitTimeout)
	d.DropConnections()

	select {
	case err := <-errCh:
		if !errors.Is(err, ErrDisconnected) {
			t.Fatalf("pending request failed with %v, want ErrDisconnected", err)
		}
	case <-time.After(testAwaitTimeout):
		t.Fatal("pending request was not settled after disconnect")
	}
	awaitChannelClosed(t, evCh, testAwaitTimeout)
	if c.EpochCurrent(token) {
		t.Fatal("peer close left the dead epoch current")
	}

	// Next Dial: the daemon hands out the next epoch-local handle.
	c2 := dialForTest(t, d, Config{})
	reopened := mustOpenSession(t, c2, t.TempDir())
	if reopened.SessionID != "rpc-2" {
		t.Errorf("epoch-local handle after reconnect = %q, want %q (counter incremented)",
			reopened.SessionID, "rpc-2")
	}
}

// TestClientReconnectBoundedSingleFlight: after the daemon goes down and
// comes back, the next request transparently reconnects and re-handshakes.
// The reconnect is single-flight (concurrent callers share one sequence —
// exactly one extra handshake) and bounded (exactly ReconnectMaxAttempts
// connection attempts while the daemon is unreachable — no busy loop).
func TestClientReconnectBoundedSingleFlight(t *testing.T) {
	d := newMockDaemon(t)
	cfg := Config{
		EventBuffer:          16,
		ReconnectInitial:     50 * time.Millisecond,
		ReconnectMax:         100 * time.Millisecond,
		ReconnectMaxAttempts: 3,
	}
	c := dialForTest(t, d, cfg)
	d.SetServerVersion("2.0.0-restart") // proves a re-handshake, not just a re-dial

	oldEvents := c.Events()
	d.SetRefuseMode(true) // daemon "down": drops the live conn, refuses new ones
	awaitChannelClosed(t, oldEvents, testAwaitTimeout)

	type callResult struct {
		resp *Response
		err  error
	}
	resCh := make(chan callResult, 16)
	launch := func() {
		go func() {
			r, err := c.Call(context.Background(), ListSessions{})
			resCh <- callResult{r, err}
		}()
	}

	// Outage: one caller starts the reconnect; once the daemon has seen
	// (refused) that attempt, more callers pile on. All must share the
	// single in-flight bounded sequence.
	baseRefusals := d.Refusals()
	launch()
	if !d.awaitRefusal(t, baseRefusals, testAwaitTimeout) {
		t.Fatal("daemon never saw the first reconnect attempt")
	}
	for i := 0; i < 4; i++ {
		launch()
	}
	for i := 0; i < 5; i++ {
		select {
		case r := <-resCh:
			if !errors.Is(r.err, ErrDisconnected) {
				t.Fatalf("call during outage: err=%v, want ErrDisconnected", r.err)
			}
		case <-time.After(testAwaitTimeout):
			t.Fatal("call during outage did not return")
		}
	}
	if got := d.Refusals(); got != 3 {
		t.Errorf("daemon refused %d reconnect attempts, want exactly ReconnectMaxAttempts=3 "+
			"(bounded sequence, single flight)", got)
	}

	// Recovery: the next request transparently reconnects and exactly one
	// re-handshake serves all concurrent callers.
	d.SetRefuseMode(false)
	releaseHandshake := d.BlockHandler(CmdGetProtocolInfo)
	baseHandshakes := d.Handshakes()
	baseProtocolRequests := len(requestIDs(d, CmdGetProtocolInfo))
	launch()
	d.awaitRequestCount(t, CmdGetProtocolInfo, baseProtocolRequests+1, testAwaitTimeout)
	for i := 0; i < 4; i++ {
		launch()
	}
	releaseHandshake()
	var mu sync.Mutex
	var ids []string
	for i := 0; i < 5; i++ {
		select {
		case r := <-resCh:
			if r.err != nil {
				t.Fatalf("call after recovery: %v", r.err)
			}
			if !r.resp.Success || r.resp.Command != CmdListSessions {
				t.Fatalf("call after recovery: bad response %+v", r.resp)
			}
			mu.Lock()
			ids = append(ids, r.resp.ID)
			mu.Unlock()
		case <-time.After(testAwaitTimeout):
			t.Fatal("call after recovery did not return")
		}
	}
	if got := d.Handshakes(); got != baseHandshakes+1 {
		t.Errorf("handshakes after recovery = %d, want exactly %d (one single-flight re-handshake)",
			got, baseHandshakes+1)
	}
	if got := c.ServerVersion(); got != "2.0.0-restart" {
		t.Errorf("ServerVersion() = %q after reconnect, want the re-negotiated %q",
			got, "2.0.0-restart")
	}
	slices.Sort(ids)
	if hasDuplicate(ids) {
		t.Errorf("response correlation ids must be unique across callers, got %v", ids)
	}
	if got := d.Refusals(); got != 3 {
		t.Errorf("refusals grew to %d after recovery, want no background reconnect attempts", got)
	}
}

// hasDuplicate reports duplicate adjacent entries (ids must be sorted
// first) and also flags a short slice, since five callers must yield five
// ids.
func hasDuplicate(sorted []string) bool {
	if len(sorted) != 5 {
		return true
	}
	for i := 1; i < len(sorted); i++ {
		if sorted[i] == sorted[i-1] {
			return true
		}
	}
	return false
}

func TestClientPreWriteCancellationKeepsEpochUsable(t *testing.T) {
	d := newMockDaemon(t)
	c := dialForTest(t, d, Config{})
	token, events := c.CurrentEpoch()
	handshakes := d.Handshakes()

	<-c.writeGate // deterministically model a sibling write holding the gate
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := c.Call(ctx, ListSessions{})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Call canceled before write = %v, want context.Canceled", err)
	}
	if errors.Is(err, ErrWrittenUnanswered) || errors.Is(err, ErrDisconnected) {
		t.Fatalf("pre-write cancellation reported delivery or transport uncertainty: %v", err)
	}
	c.writeGate <- struct{}{}

	response, err := c.Call(context.Background(), ListSessions{})
	if err != nil || response == nil || !response.Success {
		t.Fatalf("call after pre-write cancellation: response=%+v err=%v", response, err)
	}
	if !c.EpochCurrent(token) || c.EventsInEpoch(token) != events {
		t.Fatal("pre-write cancellation replaced the connection epoch")
	}
	if got := d.Handshakes(); got != handshakes {
		t.Fatalf("pre-write cancellation caused reconnect: handshakes=%d, want %d", got, handshakes)
	}
}

func TestClientPostWriteDeadlineReportsWrittenUnanswered(t *testing.T) {
	d := newMockDaemon(t)
	release := d.BlockHandler(CmdGetEntries)
	defer release()
	c := dialForTest(t, d, Config{})
	opened := mustOpenSession(t, c, t.TempDir())
	token, events := c.CurrentEpoch()
	handshakes := d.Handshakes()

	ctx := newControlledDeadlineContext()
	result := make(chan error, 1)
	go func() {
		_, err := c.Call(ctx, GetEntries{SessionID: opened.SessionID})
		result <- err
	}()
	d.awaitRequest(t, CmdGetEntries, testAwaitTimeout)
	ctx.expire()
	if err := <-result; !errors.Is(err, ErrWrittenUnanswered) || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Call deadline after write = %v, want ErrWrittenUnanswered wrapping context deadline", err)
	} else if errors.Is(err, ErrDisconnected) {
		t.Fatalf("written-unanswered call reported dead transport: %v", err)
	}
	if !c.EpochCurrent(token) {
		t.Fatal("post-write deadline invalidated the connection epoch")
	}
	response, err := c.Call(context.Background(), ListSessions{})
	if err != nil || response == nil || !response.Success {
		t.Fatalf("next call on surviving socket: response=%+v err=%v", response, err)
	}
	if !c.EpochCurrent(token) || c.EventsInEpoch(token) != events {
		t.Fatal("next call used a different connection epoch")
	}
	if got := d.Handshakes(); got != handshakes {
		t.Fatalf("post-write deadline caused reconnect: handshakes=%d, want %d", got, handshakes)
	}
}

func TestClientPartialWriteInvalidatesEpochAndReconnects(t *testing.T) {
	d := newMockDaemon(t)
	clientConn, peer := net.Pipe()
	defer peer.Close()
	c, token := clientAtTransportSeam(t, d, &partialWriteConn{Conn: clientConn})

	_, err := c.Call(context.Background(), ListSessions{})
	if !errors.Is(err, ErrDisconnected) {
		t.Fatalf("partial write = %v, want ErrDisconnected", err)
	}
	if c.EpochCurrent(token) {
		t.Fatal("partial write left the corrupted epoch current")
	}
	response, err := c.Call(context.Background(), ListSessions{})
	if err != nil || response == nil || !response.Success {
		t.Fatalf("call after partial-write reconnect: response=%+v err=%v", response, err)
	}
	if c.EpochCurrent(token) {
		t.Fatal("call after partial write reused the corrupted epoch")
	}
	if got := d.Handshakes(); got != 1 {
		t.Fatalf("reconnect handshakes = %d, want 1", got)
	}
}

func TestClientPeerCloseMidWriteInvalidatesEpoch(t *testing.T) {
	d := newMockDaemon(t)
	clientConn, peer := net.Pipe()
	started := make(chan struct{})
	c, token := clientAtTransportSeam(t, d, &writeStartedConn{Conn: clientConn, started: started})

	result := make(chan error, 1)
	go func() {
		_, err := c.Call(context.Background(), ListSessions{})
		result <- err
	}()
	select {
	case <-started:
	case <-time.After(testAwaitTimeout):
		t.Fatal("transport write did not start")
	}
	_ = peer.Close()
	select {
	case err := <-result:
		if !errors.Is(err, ErrDisconnected) {
			t.Fatalf("peer close during write = %v, want ErrDisconnected", err)
		}
	case <-time.After(testAwaitTimeout):
		t.Fatal("peer close did not unblock transport write")
	}
	if c.EpochCurrent(token) {
		t.Fatal("peer close during write left the dead epoch current")
	}
	response, err := c.Call(context.Background(), ListSessions{})
	if err != nil || response == nil || !response.Success {
		t.Fatalf("call after peer-close reconnect: response=%+v err=%v", response, err)
	}
	if got := d.Handshakes(); got != 1 {
		t.Fatalf("reconnect handshakes = %d, want 1", got)
	}
}

func TestClientTransportWriteDeadlineInvalidatesEpoch(t *testing.T) {
	d := newMockDaemon(t)
	clientConn, stalledPeer := net.Pipe()
	defer stalledPeer.Close() // the peer deliberately never reads
	lifecycle, cancelLifecycle := context.WithCancel(context.Background())
	cfg := normalizeConfig(Config{
		WriteTimeout: 20 * time.Millisecond, ReconnectInitial: time.Millisecond,
		ReconnectMax: time.Millisecond, ReconnectMaxAttempts: 2,
	})
	c := &Client{
		socketPath: d.SocketPath(), cfg: cfg, lifecycle: lifecycle, cancel: cancelLifecycle,
		pending: make(map[string]pendingRequest), writeGate: make(chan struct{}, 1), epoch: 1,
	}
	c.writeGate <- struct{}{}
	ep := &connectionEpoch{number: 1, conn: clientConn, events: newEventStream(cfg.EventBuffer, &c.dropped)}
	c.current = ep
	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		c.readLoop(ep)
	}()
	defer c.Close()
	token := EpochToken{epoch: ep}

	payload := make(json.RawMessage, (1<<20)+2)
	payload[0], payload[len(payload)-1] = '"', '"'
	for i := 1; i < len(payload)-1; i++ {
		payload[i] = 'x'
	}
	_, err := c.Call(context.Background(), ExtensionRequest{SessionID: "rpc-1", Name: "large", Data: payload})
	if !errors.Is(err, ErrDisconnected) {
		t.Fatalf("transport write timeout = %v, want ErrDisconnected", err)
	}
	if c.EpochCurrent(token) {
		t.Fatal("transport write timeout left the epoch current")
	}
	awaitChannelClosed(t, ep.events.out, testAwaitTimeout)

	response, err := c.Call(context.Background(), ListSessions{})
	if err != nil || response == nil || !response.Success {
		t.Fatalf("call after transport reconnect: response=%+v err=%v", response, err)
	}
}

type controlledDeadlineContext struct {
	context.Context
	done chan struct{}
	mu   sync.Mutex
	err  error
}

func newControlledDeadlineContext() *controlledDeadlineContext {
	return &controlledDeadlineContext{Context: context.Background(), done: make(chan struct{})}
}

func (c *controlledDeadlineContext) Deadline() (time.Time, bool) {
	return time.Now().Add(time.Hour), true
}

func (c *controlledDeadlineContext) Done() <-chan struct{} { return c.done }

func (c *controlledDeadlineContext) Err() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.err
}

func (c *controlledDeadlineContext) expire() {
	c.mu.Lock()
	c.err = context.DeadlineExceeded
	close(c.done)
	c.mu.Unlock()
}

type partialWriteConn struct{ net.Conn }

func (c *partialWriteConn) Write(p []byte) (int, error) { return len(p) / 2, nil }

type writeStartedConn struct {
	net.Conn
	started chan struct{}
	once    sync.Once
}

func (c *writeStartedConn) Write(p []byte) (int, error) {
	c.once.Do(func() { close(c.started) })
	return c.Conn.Write(p)
}

func clientAtTransportSeam(t *testing.T, d *mockDaemon, conn net.Conn) (*Client, EpochToken) {
	t.Helper()
	lifecycle, cancelLifecycle := context.WithCancel(context.Background())
	cfg := normalizeConfig(Config{
		WriteTimeout: testAwaitTimeout, ReconnectInitial: time.Millisecond,
		ReconnectMax: time.Millisecond, ReconnectMaxAttempts: 2,
	})
	c := &Client{
		socketPath: d.SocketPath(), cfg: cfg, lifecycle: lifecycle, cancel: cancelLifecycle,
		pending: make(map[string]pendingRequest), writeGate: make(chan struct{}, 1), epoch: 1,
	}
	c.writeGate <- struct{}{}
	ep := &connectionEpoch{number: 1, conn: conn, events: newEventStream(cfg.EventBuffer, &c.dropped)}
	c.current = ep
	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		c.readLoop(ep)
	}()
	t.Cleanup(func() { _ = c.Close() })
	return c, EpochToken{epoch: ep}
}

// TestMockDaemonWireSmoke is a fixture sanity check (not a client test):
// the mock daemon speaks the raw wire protocol end to end — handshake,
// open_session handle/state split, and an unsolicited event — driven with
// only protocol.go primitives.
func TestMockDaemonWireSmoke(t *testing.T) {
	d := newMockDaemon(t)
	conn, err := transport.Dial(t.Context(), d.SocketPath())
	if err != nil {
		t.Fatalf("dial mock daemon: %v", err)
	}
	defer conn.Close()
	dec := NewDecoder(conn)

	write := func(frame []byte, ferr error, wantCmd string) *Response {
		t.Helper()
		if ferr != nil {
			t.Fatalf("encode %s: %v", wantCmd, ferr)
		}
		if _, err := conn.Write(frame); err != nil {
			t.Fatalf("write %s: %v", wantCmd, err)
		}
		in, err := dec.Decode()
		if err != nil {
			t.Fatalf("decode %s reply: %v", wantCmd, err)
		}
		if in.Response == nil || in.Response.Command != wantCmd {
			t.Fatalf("expected %s response, got %+v", wantCmd, in)
		}
		return in.Response
	}

	frame, ferr := EncodeRequest("w1", GetProtocolInfo{})
	resp := write(frame, ferr, CmdGetProtocolInfo)
	var info ProtocolInfo
	if err := json.Unmarshal(resp.Data, &info); err != nil {
		t.Fatalf("decode protocol info: %v", err)
	}
	if !slices.Contains(info.Capabilities, "multi_session") || info.ServerVersion == "" {
		t.Fatalf("handshake payload incomplete: %+v", info)
	}

	frame, ferr = EncodeRequest("w2", OpenSession{CWD: t.TempDir()})
	resp = write(frame, ferr, CmdOpenSession)
	var opened OpenSessionData
	if err := json.Unmarshal(resp.Data, &opened); err != nil {
		t.Fatalf("decode open_session: %v", err)
	}
	if opened.SessionID != "rpc-1" || opened.State.SessionID == opened.SessionID {
		t.Fatalf("open_session ids wrong: handle=%q durable=%q", opened.SessionID, opened.State.SessionID)
	}

	d.Emit(map[string]any{"type": "agent_idle", "sessionId": opened.SessionID})
	in, err := dec.Decode()
	if err != nil {
		t.Fatalf("decode event: %v", err)
	}
	if in.Event == nil || in.Event.Type != "agent_idle" || in.Event.SessionID != opened.SessionID {
		t.Fatalf("expected agent_idle event tagged %q, got %+v", opened.SessionID, in)
	}
}
