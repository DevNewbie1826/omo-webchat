package omorpctest

// Attachment-scope tests for the shared mock daemon. The mode is opt-in
// (EnableAttachmentScope) and OFF by default; these tests pin the host's
// attachment / ownership / fanout contract that the enrolled-rpc-attach work
// depends on — HOST session-registry-attach.js:2-39 (same handle, attached:true),
// session-command-router.js:753-761 (ownership-checked close),
// session-teardown.js:19-41 (retention at zero attachments) and
// session-event-fanout.js:5-11,99-106 (lifecycle broadcast vs session-scoped
// delivery) — and pin the default mode as unchanged.

import (
	"context"
	"encoding/json"
	"os"
	"slices"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

const attachAwait = 3 * time.Second

// attachHarness bundles one daemon with the clients dialed against it.
type attachHarness struct {
	t   *testing.T
	d   *Daemon
	dir string
}

// attachClient is one dialed socket client plus the event stream its
// connection receives, drained by a reader goroutine so tests can assert
// per-connection delivery without polling the socket.
type attachClient struct {
	t      *testing.T
	c      *omorpc.Client
	events chan *omorpc.Event
}

// newAttachHarness starts a daemon, optionally in the opt-in attachment mode.
func newAttachHarness(t *testing.T, scope bool) *attachHarness {
	t.Helper()
	// Short-lived temp dir: macOS caps unix socket paths at 104 bytes.
	dir, err := os.MkdirTemp("", "omoa-*")
	if err != nil {
		t.Fatalf("temp dir: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	d := New(dir)
	if scope {
		d.EnableAttachmentScope()
	}
	if err := d.Start(); err != nil {
		t.Fatalf("daemon start: %v", err)
	}
	t.Cleanup(d.Stop)
	return &attachHarness{t: t, d: d, dir: dir}
}

// dial opens one real socket client against the daemon.
func (h *attachHarness) dial() *attachClient {
	h.t.Helper()
	c, err := omorpc.DialWithConfig(context.Background(), h.d.SocketPath(), omorpc.Config{})
	if err != nil {
		h.t.Fatalf("dial: %v", err)
	}
	ac := &attachClient{t: h.t, c: c, events: make(chan *omorpc.Event, 256)}
	_, stream := c.CurrentEpoch()
	go func() {
		for ev := range stream {
			ac.events <- ev
		}
	}()
	h.t.Cleanup(func() { _ = c.Close() })
	return ac
}

// ordinalAttachedTo returns the ordinal of the single connection attached to
// path, discovering it from the daemon's own view instead of assuming a dial
// order.
func (h *attachHarness) ordinalAttachedTo(path string) int {
	h.t.Helper()
	var found []int
	for _, ordinal := range h.d.ConnectionOrdinals() {
		if slices.Contains(h.d.AttachedSessions(ordinal), path) {
			found = append(found, ordinal)
		}
	}
	if len(found) != 1 {
		h.t.Fatalf("connections attached to %s = %v, want exactly one (live %v)", path, found, h.d.ConnectionOrdinals())
	}
	return found[0]
}

// ordinalNotAttachedTo returns the ordinal of a connection holding no
// attachment to path.
func (h *attachHarness) ordinalNotAttachedTo(path string) int {
	h.t.Helper()
	for _, ordinal := range h.d.ConnectionOrdinals() {
		if !slices.Contains(h.d.AttachedSessions(ordinal), path) {
			return ordinal
		}
	}
	h.t.Fatalf("no unattached connection among %v", h.d.ConnectionOrdinals())
	return 0
}

// openedSession is the decoded open_session reply: the typed fields plus the
// raw data object, so tests can assert wire fields the typed struct does not
// model yet (the attach marker).
type openedSession struct {
	rpcID   string
	path    string
	durable string
	raw     map[string]any
}

func (c *attachClient) open(cmd omorpc.OpenSession) openedSession {
	c.t.Helper()
	resp := c.callOK(cmd)
	var raw map[string]any
	if err := json.Unmarshal(resp.Data, &raw); err != nil {
		c.t.Fatalf("decode open data: %v", err)
	}
	var typed omorpc.OpenSessionData
	if err := json.Unmarshal(resp.Data, &typed); err != nil {
		c.t.Fatalf("decode typed open data: %v", err)
	}
	return openedSession{rpcID: typed.SessionID, path: typed.State.SessionFile, durable: typed.State.SessionID, raw: raw}
}

func (c *attachClient) callOK(cmd omorpc.Command) *omorpc.Response {
	c.t.Helper()
	resp, err := c.c.Call(context.Background(), cmd)
	if err != nil {
		c.t.Fatalf("call %T: %v", cmd, err)
	}
	if !resp.Success {
		c.t.Fatalf("call %T: %v", cmd, resp.Err())
	}
	return resp
}

// callErr issues a command expected to fail and returns its stable error code.
// A failed response settles as BOTH a response and an error, so the code is
// read from the response and the error value is only checked for presence.
func (c *attachClient) callErr(cmd omorpc.Command) string {
	c.t.Helper()
	resp, err := c.c.Call(context.Background(), cmd)
	if resp == nil {
		c.t.Fatalf("call %T never settled: %v", cmd, err)
	}
	if resp.Success {
		c.t.Fatalf("call %T unexpectedly succeeded", cmd)
	}
	if err == nil {
		c.t.Fatalf("call %T answered success:false without an error value", cmd)
	}
	return resp.Error
}

// expectTypes reads exactly len(want) events in order and asserts their types.
// Reading the exact sequence is what makes the absence proof for an unattached
// connection deterministic: a misrouted record would arrive before the sentinel
// the test emits after it, on the same ordered connection.
func (c *attachClient) expectTypes(want ...string) {
	c.t.Helper()
	got := make([]string, 0, len(want))
	for i := range want {
		select {
		case ev := <-c.events:
			got = append(got, ev.Type)
		case <-time.After(attachAwait):
			c.t.Fatalf("event %d of %v never arrived (got %v)", i+1, want, got)
		}
	}
	if !slices.Equal(got, want) {
		c.t.Fatalf("event types = %v, want %v", got, want)
	}
}

type listedSession struct {
	rpcID string
	path  string
}

func (c *attachClient) listSessions() []listedSession {
	c.t.Helper()
	resp := c.callOK(omorpc.ListSessions{})
	var data struct {
		Sessions []struct {
			SessionID   string `json:"sessionId"`
			SessionFile string `json:"sessionFile"`
		} `json:"sessions"`
	}
	if err := json.Unmarshal(resp.Data, &data); err != nil {
		c.t.Fatalf("decode list_sessions data: %v", err)
	}
	out := make([]listedSession, 0, len(data.Sessions))
	for _, session := range data.Sessions {
		out = append(out, listedSession{rpcID: session.SessionID, path: session.SessionFile})
	}
	return out
}

// TestAttachmentScopeFreshOpenAttachesOpener pins item 1: a fresh open attaches
// its opener, and only an attach carries the "attached" marker on the wire.
func TestAttachmentScopeFreshOpenAttachesOpener(t *testing.T) {
	h := newAttachHarness(t, true)
	a := h.dial()
	opened := a.open(omorpc.OpenSession{CWD: h.dir})
	h.dial() // never opens anything

	if got := h.d.Attachments(opened.path); got != 1 {
		t.Fatalf("attachments after a fresh open = %d, want 1", got)
	}
	if got, present := opened.raw["attached"]; present {
		t.Fatalf("fresh open data carries attached=%v; the host sends that field only on an attach", got)
	}
	if got := h.d.AttachedSessions(h.ordinalAttachedTo(opened.path)); !slices.Equal(got, []string{opened.path}) {
		t.Fatalf("attached sessions of the opener = %v, want [%s]", got, opened.path)
	}
	if got := h.d.AttachedSessions(h.ordinalNotAttachedTo(opened.path)); len(got) != 0 {
		t.Fatalf("unattached connection holds %v, want nothing", got)
	}
	if got := h.d.CloseRequestsFrom(h.ordinalNotAttachedTo(opened.path)); got != 0 {
		t.Fatalf("close requests from the unattached connection = %d, want 0", got)
	}
}

// TestAttachmentScopeSessionPathAttachSharesRoute pins item 2: opening a LIVE
// session by path attaches instead of re-opening, keeping the routing handle.
func TestAttachmentScopeSessionPathAttachSharesRoute(t *testing.T) {
	h := newAttachHarness(t, true)
	a := h.dial()
	opened := a.open(omorpc.OpenSession{CWD: h.dir})
	b := h.dial()

	attached := b.open(omorpc.OpenSession{CWD: h.dir, SessionPath: opened.path})
	if attached.rpcID != opened.rpcID {
		t.Fatalf("attach route = %q, want the live handle %q", attached.rpcID, opened.rpcID)
	}
	if attached.durable != opened.durable {
		t.Fatalf("attach durable id = %q, want %q", attached.durable, opened.durable)
	}
	if got, ok := attached.raw["attached"].(bool); !ok || !got {
		t.Fatalf("attach data attached = %v (data %v), want true", attached.raw["attached"], attached.raw)
	}
	if _, ok := attached.raw["state"].(map[string]any); !ok {
		t.Fatalf("attach data carries no state: %v", attached.raw)
	}
	if !h.d.AwaitAttachments(opened.path, 2, attachAwait) {
		t.Fatalf("attachments after the path-naming open = %d, want 2", h.d.Attachments(opened.path))
	}
	// The shared host publishes ONE route for the session, not one per client.
	if got := b.listSessions(); len(got) != 1 || got[0].path != opened.path || got[0].rpcID != opened.rpcID {
		t.Fatalf("list_sessions = %v, want one route for %s", got, opened.path)
	}
}

// TestAttachmentScopeCloseRequiresAttachment pins item 3: ownership, not
// knowledge of the public routing handle, authorizes a close.
func TestAttachmentScopeCloseRequiresAttachment(t *testing.T) {
	h := newAttachHarness(t, true)
	a := h.dial()
	opened := a.open(omorpc.OpenSession{CWD: h.dir})
	owner := h.ordinalAttachedTo(opened.path)
	b := h.dial() // never opened: it holds no attachment
	stranger := h.ordinalNotAttachedTo(opened.path)

	if got := b.callErr(omorpc.CloseSession{SessionID: opened.rpcID}); got != omorpc.ErrCodeUnknownSession {
		t.Fatalf("unattached close_session error = %q, want %q", got, omorpc.ErrCodeUnknownSession)
	}
	if !slices.Contains(h.d.LiveSessions(), opened.path) {
		t.Fatalf("a rejected close ended %s", opened.path)
	}
	if got := h.d.Attachments(opened.path); got != 1 {
		t.Fatalf("attachments after a rejected close = %d, want 1", got)
	}
	if got := h.d.CloseRequestsFrom(stranger); got != 1 {
		t.Fatalf("close requests recorded for the unattached connection = %d, want 1", got)
	}
	if got := h.d.CloseRequestsFrom(owner); got != 0 {
		t.Fatalf("close requests recorded for the owner before it closed = %d, want 0", got)
	}

	a.callOK(omorpc.CloseSession{SessionID: opened.rpcID})
	if !h.d.AwaitAttachments(opened.path, 0, attachAwait) {
		t.Fatalf("attachments after the owner's close = %d, want 0", h.d.Attachments(opened.path))
	}
	if slices.Contains(h.d.LiveSessions(), opened.path) {
		t.Fatalf("non-retained session %s survived its last close", opened.path)
	}
	if got := h.d.CloseRequestsFrom(owner); got != 1 {
		t.Fatalf("close requests recorded for the owner = %d, want 1", got)
	}
}

// TestAttachmentScopeLastAttachmentEndsEvenRetained pins item 3's retention
// split: a disconnect at zero leaves a retained session live, an explicit close
// ends it anyway.
func TestAttachmentScopeLastAttachmentEndsEvenRetained(t *testing.T) {
	h := newAttachHarness(t, true)
	a := h.dial()
	opened := a.open(omorpc.OpenSession{CWD: h.dir})
	h.d.MarkRetained(opened.path)
	b := h.dial()
	attached := b.open(omorpc.OpenSession{CWD: h.dir, SessionPath: opened.path})
	if !h.d.AwaitAttachments(opened.path, 2, attachAwait) {
		t.Fatalf("attachments after the attach = %d, want 2", h.d.Attachments(opened.path))
	}

	a.callOK(omorpc.CloseSession{SessionID: opened.rpcID})
	if !h.d.AwaitAttachments(opened.path, 1, attachAwait) {
		t.Fatalf("attachments after one of two closed = %d, want 1", h.d.Attachments(opened.path))
	}
	if !slices.Contains(h.d.LiveSessions(), opened.path) {
		t.Fatalf("retained session %s ended while still attached", opened.path)
	}

	b.callOK(omorpc.CloseSession{SessionID: attached.rpcID})
	if !h.d.AwaitAttachments(opened.path, 0, attachAwait) {
		t.Fatalf("attachments after the last close = %d, want 0", h.d.Attachments(opened.path))
	}
	if slices.Contains(h.d.LiveSessions(), opened.path) {
		t.Fatalf("explicit close left retained session %s live at zero attachments", opened.path)
	}
}

// TestAttachmentScopeConnectionCloseDetaches pins item 4: a dropped connection
// releases exactly its own attachments.
func TestAttachmentScopeConnectionCloseDetaches(t *testing.T) {
	t.Run("retained_stays_live", func(t *testing.T) {
		h := newAttachHarness(t, true)
		a := h.dial()
		opened := a.open(omorpc.OpenSession{CWD: h.dir})
		h.d.MarkRetained(opened.path)
		b := h.dial()
		b.open(omorpc.OpenSession{CWD: h.dir, SessionPath: opened.path})
		if !h.d.AwaitAttachments(opened.path, 2, attachAwait) {
			t.Fatalf("attachments before the drop = %d, want 2", h.d.Attachments(opened.path))
		}

		if err := b.c.Close(); err != nil {
			t.Fatalf("close client: %v", err)
		}
		if !h.d.AwaitAttachments(opened.path, 1, attachAwait) {
			t.Fatalf("attachments after the drop = %d, want 1", h.d.Attachments(opened.path))
		}
		if !slices.Contains(h.d.LiveSessions(), opened.path) {
			t.Fatalf("retained session %s was ended by a disconnect", opened.path)
		}
		a.callOK(omorpc.GetState{SessionID: opened.rpcID})
	})

	t.Run("non_retained_last_ends", func(t *testing.T) {
		h := newAttachHarness(t, true)
		a := h.dial()
		opened := a.open(omorpc.OpenSession{CWD: h.dir})
		b := h.dial()
		b.open(omorpc.OpenSession{CWD: h.dir, SessionPath: opened.path})
		if !h.d.AwaitAttachments(opened.path, 2, attachAwait) {
			t.Fatalf("attachments before the drop = %d, want 2", h.d.Attachments(opened.path))
		}

		if err := b.c.Close(); err != nil {
			t.Fatalf("close client: %v", err)
		}
		if !h.d.AwaitAttachments(opened.path, 1, attachAwait) {
			t.Fatalf("attachments after one drop = %d, want 1", h.d.Attachments(opened.path))
		}
		if !slices.Contains(h.d.LiveSessions(), opened.path) {
			t.Fatalf("session %s ended while an attachment remained", opened.path)
		}

		if err := a.c.Close(); err != nil {
			t.Fatalf("close client: %v", err)
		}
		if !h.d.AwaitAttachments(opened.path, 0, attachAwait) {
			t.Fatalf("attachments after the last drop = %d, want 0", h.d.Attachments(opened.path))
		}
		if slices.Contains(h.d.LiveSessions(), opened.path) {
			t.Fatalf("non-retained session %s survived its last disconnect", opened.path)
		}
	})

	t.Run("non_retained_single_ends", func(t *testing.T) {
		h := newAttachHarness(t, true)
		a := h.dial()
		opened := a.open(omorpc.OpenSession{CWD: h.dir})
		if err := a.c.Close(); err != nil {
			t.Fatalf("close client: %v", err)
		}
		if !h.d.AwaitAttachments(opened.path, 0, attachAwait) {
			t.Fatalf("attachments after the drop = %d, want 0", h.d.Attachments(opened.path))
		}
		if slices.Contains(h.d.LiveSessions(), opened.path) {
			t.Fatalf("non-retained session %s survived its only disconnect", opened.path)
		}
	})
}

// TestAttachmentScopeEventFanout pins item 5: session-scoped records reach only
// the attached connections while the five lifecycle records reach every
// connection. Absence is proven by order — the unattached connection must see
// the lifecycle sentinel FIRST — so the check cannot pass by timing luck.
func TestAttachmentScopeEventFanout(t *testing.T) {
	h := newAttachHarness(t, true)
	a := h.dial()
	opened := a.open(omorpc.OpenSession{CWD: h.dir})
	b := h.dial()
	b.open(omorpc.OpenSession{CWD: h.dir, SessionPath: opened.path})
	c := h.dial() // never opens: it holds no attachment

	// Emit/EmitSession: one session-scoped record, then a broadcast sentinel.
	h.d.EmitSession(opened.path, map[string]any{"type": EventMessageDelta, "text": "scoped"})
	h.d.Emit(map[string]any{"type": EventAgentIdle, "sessionId": opened.rpcID})
	a.expectTypes(EventMessageDelta, EventAgentIdle)
	b.expectTypes(EventMessageDelta, EventAgentIdle)
	c.expectTypes(EventAgentIdle)

	// Scripted prompt output: the same split, written by one handler goroutine.
	h.d.SetPromptScript(opened.path,
		map[string]any{"type": EventMessageDelta, "text": "script"},
		map[string]any{"type": EventAgentIdle},
	)
	a.callOK(omorpc.Prompt{SessionID: opened.rpcID, Message: "hi"})
	a.expectTypes(EventMessageDelta, EventAgentIdle)
	b.expectTypes(EventMessageDelta, EventAgentIdle)
	c.expectTypes(EventAgentIdle)

	// A broadcast lifecycle record still reaches the unattached connection.
	h.d.Emit(map[string]any{"type": EventSessionOpened, "sessionId": opened.rpcID})
	c.expectTypes(EventSessionOpened)
}

// TestAttachmentScopeGhostHealsOnSessionPathOpen pins item 6: a ghost is the
// host's rollback ghost - a still-listed OPEN registry entry (same handle, same
// durable identity, same attachments) whose router binding was rolled back. It
// answers unknown_session to every session-scoped command, and a path-naming
// open ATTACHES to the same entry: same route, attached:true with the current
// state, one more attachment, and normal command handling restored
// (HOST session-registry-attach.js:2-39, session-command-router.js:534).
func TestAttachmentScopeGhostHealsOnSessionPathOpen(t *testing.T) {
	h := newAttachHarness(t, true)
	a := h.dial()
	opened := a.open(omorpc.OpenSession{CWD: h.dir})
	ownerOrdinal := h.ordinalAttachedTo(opened.path)
	h.d.MakeGhost(opened.path)

	if got := a.listSessions(); len(got) != 1 || got[0].path != opened.path || got[0].rpcID != opened.rpcID {
		t.Fatalf("list_sessions = %v, want the ghost %s (%s) still listed", got, opened.path, opened.rpcID)
	}
	for _, cmd := range []omorpc.Command{
		omorpc.GetState{SessionID: opened.rpcID},
		omorpc.Prompt{SessionID: opened.rpcID, Message: "x"},
		omorpc.SetSessionName{SessionID: opened.rpcID, Name: "n"},
		omorpc.CloseSession{SessionID: opened.rpcID},
	} {
		if got := a.callErr(cmd); got != omorpc.ErrCodeUnknownSession {
			t.Fatalf("ghost %T error = %q, want %q", cmd, got, omorpc.ErrCodeUnknownSession)
		}
	}
	// Only the binding was rolled back: the entry keeps the attachment its owner
	// already held.
	if got := h.d.Attachments(opened.path); got != 1 {
		t.Fatalf("attachments on the ghost = %d, want the owner's 1 preserved", got)
	}

	// A DIFFERENT connection heals it by naming the path.
	b := h.dial()
	healed := b.open(omorpc.OpenSession{CWD: h.dir, SessionPath: opened.path})
	if healed.rpcID != opened.rpcID {
		t.Fatalf("healed route = %q, want the listed handle %q", healed.rpcID, opened.rpcID)
	}
	if healed.durable != opened.durable {
		t.Fatalf("healed durable id = %q, want %q", healed.durable, opened.durable)
	}
	if got, ok := healed.raw["attached"].(bool); !ok || !got {
		t.Fatalf("healing open attached = %v (data %v), want true", healed.raw["attached"], healed.raw)
	}
	if _, ok := healed.raw["state"].(map[string]any); !ok {
		t.Fatalf("healing open carries no state: %v", healed.raw)
	}
	if !h.d.AwaitAttachments(opened.path, 2, attachAwait) {
		t.Fatalf("attachments after the heal = %d, want the owner's 1 + the healer's 1", h.d.Attachments(opened.path))
	}
	if got := h.d.AttachedSessions(ownerOrdinal); !slices.Equal(got, []string{opened.path}) {
		t.Fatalf("the ghost's original attachment = %v, want [%s] preserved", got, opened.path)
	}

	// Binding recreated: the SAME handle works again for the pre-existing
	// attachment too, and session-scoped records reach both attachments.
	a.callOK(omorpc.GetState{SessionID: opened.rpcID})
	b.callOK(omorpc.GetState{SessionID: opened.rpcID})
	h.d.EmitSession(opened.path, map[string]any{"type": EventMessageDelta, "text": "after-heal"})
	a.expectTypes(EventMessageDelta)
	b.expectTypes(EventMessageDelta)
}

// TestAttachmentScopeRepeatAttachAndReopen pins the host's per-open counting: a
// connection that opens the same LIVE session twice holds two attachments, an
// explicit close releases one at a time, and reopening the same path afterwards
// leaves the bookkeeping consistent.
func TestAttachmentScopeRepeatAttachAndReopen(t *testing.T) {
	h := newAttachHarness(t, true)
	a := h.dial()
	opened := a.open(omorpc.OpenSession{CWD: h.dir})

	again := a.open(omorpc.OpenSession{CWD: h.dir, SessionPath: opened.path})
	if again.rpcID != opened.rpcID {
		t.Fatalf("second open route = %q, want the live handle %q", again.rpcID, opened.rpcID)
	}
	if got, ok := again.raw["attached"].(bool); !ok || !got {
		t.Fatalf("second open attached = %v, want true", again.raw["attached"])
	}
	if !h.d.AwaitAttachments(opened.path, 2, attachAwait) {
		t.Fatalf("attachments after two opens by one connection = %d, want 2", h.d.Attachments(opened.path))
	}

	a.callOK(omorpc.CloseSession{SessionID: opened.rpcID})
	if !h.d.AwaitAttachments(opened.path, 1, attachAwait) {
		t.Fatalf("attachments after one close = %d, want 1", h.d.Attachments(opened.path))
	}
	if !slices.Contains(h.d.LiveSessions(), opened.path) {
		t.Fatalf("session %s ended with an attachment left", opened.path)
	}
	a.callOK(omorpc.CloseSession{SessionID: opened.rpcID})
	if !h.d.AwaitAttachments(opened.path, 0, attachAwait) {
		t.Fatalf("attachments after the second close = %d, want 0", h.d.Attachments(opened.path))
	}
	if slices.Contains(h.d.LiveSessions(), opened.path) {
		t.Fatalf("session %s survived both closes", opened.path)
	}

	// Reopening the ended path is a fresh binding, and the connection must be
	// able to close it again: a stale per-connection claim would either leak the
	// count or deny the close.
	reopened := a.open(omorpc.OpenSession{CWD: h.dir, SessionPath: opened.path})
	if got, present := reopened.raw["attached"]; present {
		t.Fatalf("reopen data carries attached=%v; the session had ended", got)
	}
	if got := h.d.Attachments(opened.path); got != 1 {
		t.Fatalf("attachments after the reopen = %d, want 1", got)
	}
	a.callOK(omorpc.CloseSession{SessionID: reopened.rpcID})
	if !h.d.AwaitAttachments(opened.path, 0, attachAwait) {
		t.Fatalf("attachments after closing the reopened session = %d, want 0", h.d.Attachments(opened.path))
	}
	if slices.Contains(h.d.LiveSessions(), opened.path) {
		t.Fatalf("reopened session %s survived its close", opened.path)
	}
}

// TestAttachmentScopeDisabledKeepsDefaultBroadcast pins the OFF-by-default
// guarantee: without EnableAttachmentScope a connection that never opened
// anything can still close the session, and every record still reaches every
// connection.
func TestAttachmentScopeDisabledKeepsDefaultBroadcast(t *testing.T) {
	h := newAttachHarness(t, false)
	a := h.dial()
	opened := a.open(omorpc.OpenSession{CWD: h.dir})
	b := h.dial()

	b.callOK(omorpc.CloseSession{SessionID: opened.rpcID})
	if slices.Contains(h.d.LiveSessions(), opened.path) {
		t.Fatalf("default mode: close_session from another connection no longer ends %s", opened.path)
	}

	second := a.open(omorpc.OpenSession{CWD: h.dir})
	h.d.EmitSession(second.path, map[string]any{"type": EventMessageDelta, "text": "broadcast"})
	b.expectTypes(EventMessageDelta)
	a.expectTypes(EventMessageDelta)
	if got := h.d.Attachments(second.path); got != 0 {
		t.Fatalf("attachments with the mode off = %d, want 0", got)
	}
	if got := h.d.CloseRequestsFrom(h.d.ConnectionOrdinals()[0]); got != 0 {
		t.Fatalf("close requests recorded with the mode off = %d, want 0", got)
	}
}
