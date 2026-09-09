package wsbridge

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
)

// awaitTransportLoss consumes the lifecycle error the manager publishes to a
// bound socket when the transport epoch dies, proving the loss was reconciled
// before the assertions that follow.
func awaitTransportLoss(t *testing.T, frames *collector) {
	t.Helper()
	frames.nextMatching(t, "error", heartbeatTestTimeout, func(f map[string]any) bool {
		return f["message"] == "provider connection lost"
	})
}

// entryCountForPath snapshots the provider-side durable record for one session
// file: the applied prompt texts and the durable entry count.
func entryCountForPath(t *testing.T, daemon *omorpctest.Daemon, path string) (omorpctest.SessionSnapshot, bool) {
	t.Helper()
	for _, snapshot := range daemon.SessionSnapshots() {
		if snapshot.Path == path {
			return snapshot, true
		}
	}
	return omorpctest.SessionSnapshot{}, false
}

// assertNoPhasedOutcome fails if a settled chat.send outcome — a phased ack
// or an error — was already delivered for requestID. An operation whose
// provider outcome is unknown must stay withheld.
func assertNoPhasedOutcome(t *testing.T, frames *collector, requestID string) {
	t.Helper()
	frames.mu.Lock()
	defer frames.mu.Unlock()
	for _, raw := range frames.frames {
		var frame map[string]any
		if json.Unmarshal(raw, &frame) != nil {
			continue
		}
		if frame["requestId"] != requestID {
			continue
		}
		if frame["type"] == "ack" && frame["phase"] != nil {
			t.Fatalf("ambiguous send %s surfaced a settled outcome: %s", requestID, raw)
		}
		if frame["type"] == "error" {
			t.Fatalf("ambiguous send %s surfaced a terminal error: %s", requestID, raw)
		}
	}
}

// awaitRecoveredHistory blocks until the rebound binding replays its durable
// history terminal on this socket.
func awaitRecoveredHistory(t *testing.T, frames *collector) {
	t.Helper()
	awaitRecoveredHistoryEntries(t, frames)
}

// awaitRecoveredHistoryEntries is awaitRecoveredHistory plus the number of
// entries the recovery replay delivered on this socket, so callers can
// assert the provider-side durable record through the replay that read it.
func awaitRecoveredHistoryEntries(t *testing.T, frames *collector) int {
	t.Helper()
	if ready := frames.next(t, "ready"); ready["resumed"] != true {
		t.Fatalf("recovery ready = %v, want a resumed rebind", ready)
	}
	replayed := 0
	for {
		page := frames.next(t, "entries")
		if entries, ok := page["entries"].([]any); ok {
			replayed += len(entries)
		}
		if page["final"] == true {
			return replayed
		}
	}
}

// TestAutomaticReconciliationAfterReconnect is criterion C2: after a silent
// transport loss the manager proactively reconnects (C1), and once a successor
// epoch is established it automatically reconciles the sessions it still
// owns — transparently reopening the SAME durable session (identity, file,
// working directory) and rebinding the live browser socket, with no user
// action. A session the engine silently evicted (the routing handle is gone)
// must never be substituted with a fresh session.
func TestAutomaticReconciliationAfterReconnect(t *testing.T) {
	t.Run("transparently_reopens_same_durable_session", func(t *testing.T) {
		const chatID = "auto-reconcile"
		h := newInPlaceBridgeHarnessWithHistory(t, chatID, 3)
		conn, frames := h.connect(t)
		attachAndAwaitHistory(t, conn, frames, chatID)
		awaitCommandFence(t, conn, frames)

		_, stale := h.soleServerConnection(t).binding()
		if stale == nil {
			t.Fatal("server connection was not bound")
		}
		staleRoute, staleID, staleFile := stale.RoutingID(), stale.ID(), stale.SessionFile()
		record, err := h.store.GetChat(chatID)
		if err != nil {
			t.Fatal(err)
		}
		wantCWD := record.CWD

		beforeOpen := h.daemon.OpenCount()
		beforeHandshake := h.daemon.Handshakes()
		h.daemon.EvictSessionSilently(h.path)
		h.daemon.DropConnections()
		awaitTransportLoss(t, frames)

		// No user frame is written on this socket from here on: the reconnect
		// and the reconciliation can only come from the manager.
		if !h.daemon.AwaitRequestCount(omorpc.CmdGetProtocolInfo, beforeHandshake+1, heartbeatTestTimeout) {
			t.Fatalf("transport was not proactively re-established within %v", heartbeatTestTimeout)
		}
		if !h.daemon.AwaitRequestCount(omorpc.CmdOpenSession, beforeOpen+1, heartbeatTestTimeout) {
			t.Fatalf("durable session was not transparently reopened without user action (opens=%d)", h.daemon.OpenCount()-beforeOpen)
		}

		// The rebound binding replays ready + durable history on the live socket:
		// recovery completion is observable before identity assertions.
		awaitRecoveredHistory(t, frames)

		recovered, ok := h.manager.Get(chatID)
		if !ok || recovered == nil {
			t.Fatal("recovered session was not retained by the manager")
		}
		if recovered.ID() != staleID {
			t.Fatalf("durable session id changed: stale=%q recovered=%q", staleID, recovered.ID())
		}
		if recovered.SessionFile() != staleFile {
			t.Fatalf("session file changed: stale=%q recovered=%q", staleFile, recovered.SessionFile())
		}
		if recovered.RoutingID() == staleRoute {
			t.Fatal("engine-evicted routing handle was reused instead of reopened")
		}
		var summaryFound bool
		for _, summary := range h.manager.LiveSummaries() {
			if summary.ChatID != chatID {
				continue
			}
			summaryFound = true
			if summary.DurableSessionID != staleID || summary.SessionFile != staleFile || summary.CWD != wantCWD {
				t.Fatalf("recovered durable identity = id:%q file:%q cwd:%q, want id:%q file:%q cwd:%q",
					summary.DurableSessionID, summary.SessionFile, summary.CWD, staleID, staleFile, wantCWD)
			}
		}
		if !summaryFound {
			t.Fatal("recovered session produced no live summary")
		}

		if got := h.daemon.OpenCount() - beforeOpen; got != 1 {
			t.Fatalf("reconciliation opens = %d, want exactly 1", got)
		}
		if got := h.daemon.Handshakes() - beforeHandshake; got != 1 {
			t.Fatalf("reconnect handshakes = %d, want exactly 1", got)
		}
		assertNoBridgeErrors(t, frames)
	})

	t.Run("inflight_request_not_resent_across_recovery_window", func(t *testing.T) {
		const chatID = "auto-reconcile-dedup"
		h := newInPlaceBridgeHarness(t, chatID)
		conn, frames := h.connect(t)
		attachAndAwaitHistory(t, conn, frames, chatID)
		awaitCommandFence(t, conn, frames)

		_, stale := h.soleServerConnection(t).binding()
		if stale == nil {
			t.Fatal("server connection was not bound")
		}
		staleID, staleFile := stale.ID(), stale.SessionFile()
		beforeSnapshot, ok := entryCountForPath(t, h.daemon, h.path)
		if !ok {
			t.Fatalf("session %s was not registered before the loss", h.path)
		}
		beforeEntries := beforeSnapshot.EntryCount
		beforePrompt := h.daemon.RequestCountForPath(omorpc.CmdPrompt, h.path)
		beforeOpen := h.daemon.OpenCount()
		beforeHandshake := h.daemon.Handshakes()

		// The prompt handler is gated after the request was recorded but before
		// the provider applied it or answered: the write reached the transport,
		// so its outcome is ambiguous once the transport dies. The session is
		// retained — only the connection epoch is lost, never the provider-side
		// session (no eviction). The gate stays closed through the recovery
		// below: the provider has not applied anything yet, so the durable file
		// is stable while the transparent reopen replays it.
		const promptText = "single mid-flight prompt"
		promptEntered, release := h.daemon.BlockPromptBeforeApply(h.path)
		defer release()
		request := map[string]any{
			"type": "chat.send", "sessionId": chatID, "requestId": "ambiguous-written-once",
			"run": map[string]any{"kind": "prompt", "message": promptText},
		}
		writeClient(t, conn, request)
		if ack := frames.next(t, "ack"); ack["requestId"] != "ambiguous-written-once" {
			t.Fatalf("initial admission ack = %v", ack)
		}
		promptDeadline := time.NewTimer(heartbeatTestTimeout)
		defer promptDeadline.Stop()
		select {
		case <-promptEntered:
		case <-promptDeadline.C:
			t.Fatal("prompt did not reach the provider's pre-apply barrier")
		}

		h.daemon.DropConnections()
		awaitTransportLoss(t, frames)

		// Automatic reconciliation alone recovers: it re-establishes the
		// transport, transparently reopens the SAME retained durable session,
		// and replays its durable history on the live socket. That replay is
		// the completion barrier for the recovery wave — a resending flight
		// would share the per-chat FIFO, so it settles before anything the
		// test issues next.
		awaitRecoveredHistory(t, frames)

		// Exactly one prompt forward: the ambiguous post-write loss never
		// licenses an automatic resend. The gated arrival counter is sticky, so
		// a second forward is caught here or at the re-checks below.
		if got := h.daemon.RequestCountForPath(omorpc.CmdPrompt, h.path) - beforePrompt; got != 1 {
			t.Fatalf("prompt forwards across the ambiguous loss = %d, want exactly 1", got)
		}
		recovered, ok := h.manager.Get(chatID)
		if !ok || recovered == nil {
			t.Fatal("session with an ambiguous in-flight prompt was not retained")
		}
		if recovered.ID() != staleID || recovered.SessionFile() != staleFile {
			t.Fatalf("recovered identity = id:%q file:%q, want the retained id:%q file:%q",
				recovered.ID(), recovered.SessionFile(), staleID, staleFile)
		}
		if got := h.daemon.OpenCount() - beforeOpen; got != 1 {
			t.Fatalf("recovery opens = %d, want exactly 1 reconciliation open", got)
		}
		if got := h.daemon.Handshakes() - beforeHandshake; got != 1 {
			t.Fatalf("reconnect handshakes = %d, want exactly 1", got)
		}

		// The ambiguous outcome stays withheld: no terminal ack and no error
		// frame may surface for it, or the client could mistake an unknown
		// provider outcome for a settled one.
		assertNoPhasedOutcome(t, frames, "ambiguous-written-once")

		// A browser replay of the same requestID deduplicates against the
		// retained admitted operation and never reaches the provider again. The
		// replay rides the same per-chat FIFO as any resending flight, so by
		// the time its ack returns, a wrongly resent prompt has been counted.
		writeClient(t, conn, request)
		nextSuccessfulSendAcks(t, frames, "ambiguous-written-once")
		if got := h.daemon.RequestCountForPath(omorpc.CmdPrompt, h.path) - beforePrompt; got != 1 {
			t.Fatalf("prompt forwards after the replay = %d, want exactly 1", got)
		}
		// The provider has still not applied anything (the handler gate is held),
		// so the durable record is unchanged — deterministic at this point.
		if snapshot, ok := entryCountForPath(t, h.daemon, h.path); !ok || snapshot.EntryCount != beforeEntries {
			t.Fatalf("durable user turns before the provider applied the prompt = %d, want %d", snapshot.EntryCount, beforeEntries)
		}

		// Now let the provider apply the one already-written prompt. Its
		// response can only fail against the dead connection, so the outcome
		// stays unknown to the client. The fixture's append notification is the
		// completion barrier for the durable assertions below.
		release()
		if !h.daemon.AwaitSessionEntryCount(h.path, beforeEntries+1, heartbeatTestTimeout) {
			t.Fatal("the already-written prompt was not durably applied")
		}
		snapshot, ok := entryCountForPath(t, h.daemon, h.path)
		if !ok {
			t.Fatalf("session %s was not registered after the loss", h.path)
		}
		if got := snapshot.EntryCount - beforeEntries; got != 1 {
			t.Fatalf("durable user turns across the ambiguous loss = %d, want exactly 1", got)
		}
		if len(snapshot.Prompts) != 1 || snapshot.Prompts[0] != promptText {
			t.Fatalf("provider prompt record = %v, want exactly [%q]", snapshot.Prompts, promptText)
		}
		if got := h.daemon.RequestCountForPath(omorpc.CmdPrompt, h.path) - beforePrompt; got != 1 {
			t.Fatalf("prompt forwards after durable application = %d, want exactly 1", got)
		}
		if got := h.daemon.OpenCount() - beforeOpen; got != 1 {
			t.Fatalf("recovery opens = %d, want exactly 1 reconciliation open", got)
		}
		if got := h.daemon.Handshakes() - beforeHandshake; got != 1 {
			t.Fatalf("reconnect handshakes = %d, want exactly 1", got)
		}
		assertNoPhasedOutcome(t, frames, "ambiguous-written-once")
		assertNoBridgeErrors(t, frames)
	})

	t.Run("concurrent_recovery_runs_execute_once", func(t *testing.T) {
		const chatID = "auto-reconcile-concurrent"
		h := newInPlaceBridgeHarnessWithHistory(t, chatID, 2)
		conn, frames := h.connect(t)
		attachAndAwaitHistory(t, conn, frames, chatID)

		h.daemon.EvictSessionSilently(h.path)
		beforeOpen := h.daemon.OpenCount()
		releaseOpen := h.daemon.BlockHandler(omorpc.CmdOpenSession)
		defer releaseOpen()
		h.daemon.DropConnections()
		awaitTransportLoss(t, frames)

		// Automatic reconciliation alone reaches the open barrier; no user
		// frame has been written on any socket.
		if !h.daemon.AwaitRequestCount(omorpc.CmdOpenSession, beforeOpen+1, heartbeatTestTimeout) {
			t.Fatal("automatic reconciliation did not reach the open barrier")
		}

		// A second browser socket requesting the same chat while the recovery
		// open is still in flight must converge on that one recovery. The fence
		// is queued on the socket's work loop behind the create, so consuming
		// its rejection proves the create settled.
		refresh, refreshFrames := h.connect(t)
		writeClient(t, refresh, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": chatID})
		releaseOpen()
		awaitCommandFence(t, refresh, refreshFrames)
		if ready := refreshFrames.next(t, "ready"); ready["sessionId"] != chatID {
			t.Fatalf("converged create ready = %v", ready)
		}
		awaitRecoveredHistory(t, frames)
		if got := h.daemon.OpenCount() - beforeOpen; got != 1 {
			t.Fatalf("concurrent recovery opens = %d, want exactly 1", got)
		}
		assertNoBridgeErrors(t, refreshFrames)
		assertNoBridgeErrors(t, frames)
	})

	t.Run("deleted_session_not_resurrected", func(t *testing.T) {
		const keepID = "auto-reconcile-keep"
		h := newInPlaceBridgeHarnessWithHistory(t, keepID, 2)
		conn, frames := h.connect(t)
		attachAndAwaitHistory(t, conn, frames, keepID)
		awaitCommandFence(t, conn, frames)

		// A second in-place chat whose durable identity is explicitly deleted
		// while its session stays tracked and bound.
		const deletedID = "auto-reconcile-deleted"
		dir := filepath.Dir(h.path)
		deletedPath := filepath.Join(dir, deletedID+".jsonl")
		var body strings.Builder
		fmt.Fprintf(&body, "{\"type\":\"session\",\"id\":\"durable-%s\",\"version\":3,\"timestamp\":\"2026-09-03T00:00:00Z\",\"cwd\":%s}\n", deletedID, string(mustJSON(t, dir)))
		parent := ""
		for i := 0; i < 2; i++ {
			id := "root"
			if i != 0 {
				id = fmt.Sprintf("entry-%d", i)
			}
			parentJSON := "null"
			if parent != "" {
				parentJSON = string(mustJSON(t, parent))
			}
			fmt.Fprintf(&body, "{\"type\":\"message\",\"id\":%s,\"parentId\":%s,\"message\":{\"role\":\"user\",\"content\":\"gone\"}}\n", string(mustJSON(t, id)), parentJSON)
			parent = id
		}
		if err := os.WriteFile(deletedPath, []byte(body.String()), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := h.daemon.LoadSessionFile(deletedPath); err != nil {
			t.Fatal(err)
		}
		if err := h.store.SaveChat(cursorstore.Chat{
			ID: deletedID, WorkspaceID: "ws-1", CWD: dir, Name: deletedID,
			SessionFile: deletedPath, DurableSessionID: "durable-" + deletedID,
			SessionProvenance: cursorstore.SessionProvenanceInPlace,
		}); err != nil {
			t.Fatal(err)
		}
		deletedConn, deletedFrames := h.connect(t)
		attachAndAwaitHistory(t, deletedConn, deletedFrames, deletedID)
		awaitCommandFence(t, deletedConn, deletedFrames)
		staleDeleted, ok := h.manager.Get(deletedID)
		if !ok || staleDeleted == nil {
			t.Fatal("deleted chat's session was not tracked")
		}

		beforeKeepOpens := h.daemon.RequestCountForPath(omorpc.CmdOpenSession, h.path)
		beforeOpen := h.daemon.OpenCount()
		beforeHandshake := h.daemon.Handshakes()
		h.manager.RetireIdentity(deletedID)
		h.daemon.DropConnections()
		awaitTransportLoss(t, frames)
		awaitTransportLoss(t, deletedFrames)

		// The retained chat reconciles automatically (the control proving the
		// establishment wave was processed end to end)…
		if !h.daemon.AwaitRequestCount(omorpc.CmdGetProtocolInfo, beforeHandshake+1, heartbeatTestTimeout) {
			t.Fatalf("transport was not proactively re-established within %v", heartbeatTestTimeout)
		}
		if !h.daemon.AwaitRequestCountForPath(omorpc.CmdOpenSession, h.path, beforeKeepOpens+1, heartbeatTestTimeout) {
			t.Fatal("retained chat was not reconciled after reconnect")
		}
		awaitRecoveredHistory(t, frames)

		// …while the explicitly deleted durable identity is never reopened.
		if got := h.daemon.OpenCount() - beforeOpen; got != 1 {
			t.Fatalf("reconciliation opens = %d, want only the retained chat's single open", got)
		}
		if got := h.daemon.RequestCountForPath(omorpc.CmdOpenSession, deletedPath); got != 1 {
			t.Fatalf("deleted session file was reopened %d times, want only its initial open", got)
		}
		after, ok := h.manager.Get(deletedID)
		if !ok || after != staleDeleted {
			t.Fatal("deleted chat's resumable session was replaced by a resurrection")
		}
		if !after.Resumable() {
			t.Fatal("deleted chat's session silently became live again")
		}
		if got := h.daemon.Handshakes() - beforeHandshake; got != 1 {
			t.Fatalf("reconnect handshakes = %d, want exactly 1", got)
		}
	})
}
