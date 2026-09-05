package session

// Integration RED suite: full-stack behavior against the shared mock
// daemon, per docs/v2/stage2-session-cursor.md (C001 acceptance demo) and
// invariants 7 (resume safety), 11 (idle unload), 12 (transport epoch).

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
)

func TestResumeOnlyWithoutCursorDoesNotOpenFreshSession(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 8)
	_, _, detach, err := mgr.ResumeInitialized(context.Background(), testChat{id: "no-resume-cursor", cwd: t.TempDir()}, nil, nil)
	if detach != nil {
		detach()
	}
	if !errors.Is(err, ErrNoDurableCursor) {
		t.Fatalf("resume-only error = %T %v, want ErrNoDurableCursor", err, err)
	}
	if got := d.RequestCount(omorpc.CmdOpenSession); got != 0 {
		t.Fatalf("resume-only empty cursor opened %d provider sessions", got)
	}
}

// C001 acceptance demo: create chat -> Acquire (fresh open) -> ready
// {resumed:false} -> prompt -> scripted stream -> run.done -> cursor
// persisted -> client/daemon restart -> Acquire same chat resumes from the
// stored cursor -> ready {resumed:true} -> durable id matches -> history
// flows.
func TestIntegrationHappyPathResumeAcrossRestart(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	chat := testChat{id: "chat-1", cwd: t.TempDir()}
	mgr := testManager(t, client, store, 64)

	sub := newRecorder(128)
	sess, started, detach := acquire(t, mgr, chat, sub)
	if !started {
		t.Fatalf("first Acquire must open a fresh provider session")
	}
	if detach == nil {
		t.Fatalf("Acquire must return a detach function")
	}

	// ready frame: fresh open, durable identity attached.
	ready := sub.next(t)
	if ready.Kind != FrameReady || ready.Resumed {
		t.Fatalf("expected fresh ready frame, got %+v", ready)
	}
	if ready.SessionID == "" || ready.SessionID != sess.ID() {
		t.Fatalf("ready.SessionID %q must match Session.ID() %q", ready.SessionID, sess.ID())
	}
	if sess.SessionFile() == "" {
		t.Fatalf("fresh session must carry its sessionFile")
	}
	if !d.AwaitRequestCount(omorpc.CmdOpenSession, 1, testTimeout) {
		t.Fatalf("daemon never saw open_session")
	}
	if got := d.LastRequest(omorpc.CmdOpenSession)["cwd"]; got != chat.cwd {
		t.Fatalf("fresh open must carry the chat cwd, got %v", got)
	}

	// Prompt with a scripted run stream.
	d.SetPromptScript(sess.SessionFile(), runEvents()...)
	if err := sess.SendPrompt(context.Background(), "hello", nil); err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}

	// The full run stream must flow to the subscriber and run.done must follow
	// every stream frame exactly once. Independent metadata may arrive later.
	var frames []Frame
	deadline := time.After(testTimeout)
	for counts(frames)[FrameRunDone] == 0 {
		select {
		case f := <-sub.ch:
			frames = append(frames, f)
		case <-deadline:
			t.Fatalf("run never settled; frames so far: %+v", frames)
		}
	}
	rest := sub.drain()
	frames = append(frames, rest...)
	c := counts(frames)
	if c[FrameRunStarted] != 1 || c[FrameRunDone] != 1 {
		t.Fatalf("want exactly one run.started/run.done, got %+v", c)
	}
	if c[FrameMessageDelta] == 0 || c[FrameTool] == 0 || c[FrameMessage] == 0 {
		t.Fatalf("stream frames lost: %+v", c)
	}
	if frameIndex(frames, FrameRunDone) < frameIndex(frames, FrameMessageDelta) {
		t.Fatalf("run.done must trail the stream: %+v", frames)
	}

	// Cursor persisted on proven success: durable id + sessionFile.
	cur := store.stored(chat.id)
	if cur.SessionFile != sess.SessionFile() || cur.DurableSessionID != sess.ID() {
		t.Fatalf("cursor mismatch: stored %+v, session {%q %q}", cur, sess.ID(), sess.SessionFile())
	}

	// --- restart: daemon socket preserved, live sessions gone, durable
	// state persists; the client layer is rebuilt over the same socket. ---
	detach()
	mustOK(t, mgr.CloseAll(context.Background()))
	mustOK(t, client.Close())
	d.Restart()

	client2 := dial(t, d)
	mgr2 := testManager(t, client2, store, 64)
	sub2 := newRecorder(128)
	sess2, _, _ := acquire(t, mgr2, chat, sub2)

	ready2 := sub2.next(t)
	if ready2.Kind != FrameReady || !ready2.Resumed {
		t.Fatalf("expected resumed ready frame, got %+v", ready2)
	}
	if sess2.ID() != sess.ID() {
		t.Fatalf("durable id drift across restart: %q vs %q", sess2.ID(), sess.ID())
	}
	if sess2.SessionFile() != cur.SessionFile {
		t.Fatalf("resume must reuse the stored sessionFile: %q vs %q", sess2.SessionFile(), cur.SessionFile)
	}
	open := d.LastRequest(omorpc.CmdOpenSession)
	if p, _ := open["sessionPath"].(string); p != cur.SessionFile {
		t.Fatalf("resume open must carry the stored sessionPath, got %v", open["sessionPath"])
	}
	// Observed engine contract: session-scoped state keyed by working
	// directory follows the explicit open_session cwd, so a resume must
	// carry the chat cwd alongside the stored sessionPath.
	if got, _ := open["cwd"].(string); got != chat.cwd {
		t.Fatalf("resume open must carry the chat cwd alongside sessionPath, got %q", got)
	}

	// History flows after resume: disk pages append into one live-tail terminal.
	total := 0
	for {
		_, entries := sub2.await(t, FrameEntries)
		data, _ := entries.Data.(EntriesFrame)
		total += len(data.Entries)
		if data.Final {
			break
		}
	}
	if total == 0 {
		t.Fatalf("resume must deliver history entries")
	}
}

// Invariant 7 (transient): session_path_in_use is retried on the IDENTICAL
// request, 3 attempts total, cursor untouched until success.
func TestIntegrationTransientPathInUseRetriedUnchanged(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	chat := testChat{id: "chat-1", cwd: t.TempDir()}

	path := "/tmp/omo-fake/sessions/durable-42.jsonl"
	sum := sha256.Sum256([]byte(path))
	stored := Cursor{SessionFile: path, DurableSessionID: "durable-" + hex.EncodeToString(sum[:4]) + "-7d24-4b1e-resume"}
	if err := store.SaveCursor(context.Background(), chat.id, stored); err != nil {
		t.Fatalf("seed cursor: %v", err)
	}

	// First two attempts bounce with session_path_in_use; the identical
	// third attempt succeeds.
	d.FailOpenPath(stored.SessionFile, omorpctest.CodeSessionPathInUse, 2)

	mgr := testManager(t, client, store, 64)
	sub := newRecorder(64)
	sess, _, _ := acquire(t, mgr, chat, sub)

	if !d.AwaitRequestCount(omorpc.CmdOpenSession, 3, testTimeout) {
		t.Fatalf("expected 3 open_session attempts (2 transient + 1 success), got %d", d.RequestCount(omorpc.CmdOpenSession))
	}
	// Identical payload on every retry.
	for _, r := range d.Requests() {
		if typ, _ := r["type"].(string); typ == omorpc.CmdOpenSession {
			if p, _ := r["sessionPath"].(string); p != stored.SessionFile {
				t.Fatalf("retry payload drift: %+v", r)
			}
		}
	}
	if sess.ID() == "" {
		t.Fatalf("resumed session must expose its durable id")
	}
	if sess.SessionFile() != stored.SessionFile {
		t.Fatalf("resumed session must use the stored path")
	}
	// The cursor was not touched by the retries; identity proved once.
	if store.saveCount() != 1 {
		t.Fatalf("expected exactly one cursor save (on proven success), got %d", store.saveCount())
	}
	if got := store.stored(chat.id); got != stored {
		t.Fatalf("stored cursor drifted: %+v", got)
	}
	_, ready := sub.await(t, FrameReady)
	if !ready.Resumed {
		t.Fatalf("resume must report resumed=true")
	}
}

func TestIntegrationInPlacePathInUseNeverFallsBack(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	chat := testChat{id: "chat-in-place-active", cwd: t.TempDir()}
	path := filepath.Join(chat.cwd, "active.jsonl")
	if err := os.WriteFile(path, []byte("identity"), 0o600); err != nil {
		t.Fatal(err)
	}
	stored := Cursor{SessionFile: path, DurableSessionID: "durable-active", InPlace: true}
	if err := store.SaveCursor(context.Background(), chat.id, stored); err != nil {
		t.Fatalf("seed cursor: %v", err)
	}
	d.FailOpenPath(stored.SessionFile, omorpctest.CodeSessionPathInUse, 3)

	mgr := testManager(t, client, store, 64)
	_, _, _, err := mgr.Acquire(context.Background(), chat, newRecorder(64))
	var stable *omorpc.StableError
	if !errors.As(err, &stable) || stable.Code != omorpc.ErrCodeSessionPathInUse {
		t.Fatalf("Acquire error = %T %v, want typed session_path_in_use", err, err)
	}
	assertOnlyPathOpens(t, d, stored.SessionFile, 3)
	if got := store.stored(chat.id); got != stored {
		t.Fatalf("stored cursor changed: %+v", got)
	}
}

func TestIntegrationInPlaceMissingOriginalFailsBeforeOpen(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	chat := testChat{id: "chat-in-place-missing", cwd: t.TempDir()}
	stored := Cursor{SessionFile: filepath.Join(chat.cwd, "missing.jsonl"), DurableSessionID: "durable-missing", InPlace: true}
	if err := store.SaveCursor(context.Background(), chat.id, stored); err != nil {
		t.Fatalf("seed cursor: %v", err)
	}

	mgr := testManager(t, client, store, 64)
	_, _, _, err := mgr.Acquire(context.Background(), chat, newRecorder(64))
	var drift *ExternalWriteError
	if !errors.As(err, &drift) || !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("Acquire error = %T %v, want typed external-write ENOENT", err, err)
	}
	assertOnlyPathOpens(t, d, stored.SessionFile, 0)
	if got := store.stored(chat.id); got != stored {
		t.Fatalf("stored cursor changed: %+v", got)
	}
}

func TestValidateOpenInPlaceRequiresOriginalPath(t *testing.T) {
	cur := Cursor{SessionFile: "/tmp/original.jsonl", DurableSessionID: "durable", InPlace: true}
	data := omorpc.OpenSessionData{
		SessionID: "route",
		State:     omorpc.SessionState{SessionFile: "/tmp/launch-debris.jsonl", SessionID: "durable"},
	}
	if err := validateOpen(data, cur, true); err == nil {
		t.Fatal("in-place open accepted a different provider session path")
	}
}

func assertOnlyPathOpens(t *testing.T, d *omorpctest.Daemon, path string, want int) {
	t.Helper()
	got := 0
	for _, request := range d.Requests() {
		if typ, _ := request["type"].(string); typ != omorpc.CmdOpenSession {
			continue
		}
		got++
		if requestPath, _ := request["sessionPath"].(string); requestPath != path {
			t.Fatalf("open_session %d was pathless or changed path: %+v", got, request)
		}
	}
	if got != want {
		t.Fatalf("open_session count = %d, want %d", got, want)
	}
}

// Invariant 7 (permanent): a permanent open failure surfaces one
// resume_failed error frame, falls back to a fresh cwd-backed session, and
// NEVER overwrites the stored cursor.
func TestIntegrationPermanentOpenFailureFallsBackKeepingCursor(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	chat := testChat{id: "chat-1", cwd: t.TempDir()}

	stored := Cursor{SessionFile: "/tmp/omo-fake/sessions/gone.jsonl", DurableSessionID: "durable-gone"}
	if err := store.SaveCursor(context.Background(), chat.id, stored); err != nil {
		t.Fatalf("seed cursor: %v", err)
	}
	d.FailNext(omorpc.CmdOpenSession, omorpc.ErrCodeOpenFailed+": no such session file")

	mgr := testManager(t, client, store, 64)
	sub := newRecorder(64)
	sess, _, _, err := mgr.Acquire(context.Background(), chat, sub)
	if err != nil {
		t.Fatalf("Acquire must fall back to a fresh session, not fail: %v", err)
	}

	// The resume failure is surfaced on the subscriber, once.
	prior, _ := sub.awaitError(t, "resume_failed")
	for _, f := range prior {
		if f.Kind == FrameError {
			t.Fatalf("more than one error frame during resume: %+v", prior)
		}
	}

	// Fallback session is fresh and cwd-backed.
	if sess.SessionFile() == stored.SessionFile {
		t.Fatalf("fallback session must not reuse the failed path")
	}
	open := d.LastRequest(omorpc.CmdOpenSession)
	if p, _ := open["sessionPath"].(string); p == stored.SessionFile {
		t.Fatalf("fallback must be a fresh open, got %+v", open)
	}
	if cwd, _ := open["cwd"].(string); cwd != chat.cwd {
		t.Fatalf("fallback open must use the chat cwd, got %+v", open)
	}

	// Stored binding stays verbatim: prove-before-clear.
	if got := store.stored(chat.id); got != stored {
		t.Fatalf("permanent failure overwrote the stored cursor: %+v", got)
	}
	if store.saveCount() != 1 {
		t.Fatalf("cursor must not be rewritten on fallback (seed only), got %d saves", store.saveCount())
	}
	_, ready := sub.await(t, FrameReady)
	if ready.Resumed {
		t.Fatalf("fallback session is a fresh open, resumed must be false")
	}
}

// Invariant 11: daemon-side idle unload silently marks the route resumable,
// and the next Acquire reopens from the stored cursor.
func TestIntegrationIdleUnloadSilentThenReopen(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	chat := testChat{id: "chat-1", cwd: t.TempDir()}
	mgr := testManager(t, client, store, 64)

	sub := newRecorder(64)
	sess, _, _ := acquire(t, mgr, chat, sub)
	stored := store.stored(chat.id)
	if stored.SessionFile == "" {
		t.Fatalf("cursor must persist on fresh open")
	}

	// Daemon evicts the session (idle sweep simulated daemon-side).
	d.UnloadSession(stored.SessionFile)
	if _, err := sess.QueryState(context.Background()); !errors.Is(err, ErrSessionResumable) {
		t.Fatalf("unloaded route query = %v, want ErrSessionResumable", err)
	}
	if extra := sub.drain(); counts(extra)[FrameError] != 0 {
		t.Fatalf("silent unload published an error: %+v", extra)
	}
	if !sess.Resumable() {
		t.Fatalf("unloaded session must be resumable from the stored cursor")
	}

	// Next acquire reopens from the cursor, not a fresh open.
	before := d.RequestCount(omorpc.CmdOpenSession)
	sub2 := newRecorder(64)
	sess2, started2, _ := acquire(t, mgr, chat, sub2)
	if !started2 {
		t.Fatalf("reopen must start a provider session")
	}
	if got := d.RequestCount(omorpc.CmdOpenSession); got != before+1 {
		t.Fatalf("reopen must issue exactly one open_session, got %d", got-before)
	}
	open := d.LastRequest(omorpc.CmdOpenSession)
	if p, _ := open["sessionPath"].(string); p != stored.SessionFile {
		t.Fatalf("reopen must carry the stored sessionPath, got %v", open)
	}
	if sess2.ID() != stored.DurableSessionID {
		t.Fatalf("reopen durable id %q must match stored %q", sess2.ID(), stored.DurableSessionID)
	}
	_, ready := sub2.await(t, FrameReady)
	if !ready.Resumed {
		t.Fatalf("reopen must report resumed=true")
	}
}

// Invariant 12/epoch: daemon death fails pending calls with the typed
// transport error, invalidates every live session into the resumable
// state, and is observed by the manager (Events channel close).
func TestIntegrationEpochInvalidationMarksSessionsResumable(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	chat := testChat{id: "chat-1", cwd: t.TempDir()}
	mgr := testManager(t, client, store, 64)

	sub := newRecorder(64)
	sess, _, _ := acquire(t, mgr, chat, sub)
	stored := store.stored(chat.id)
	if stored.SessionFile == "" {
		t.Fatalf("cursor must persist on fresh open")
	}

	// Park one call in flight, then kill the daemon epoch.
	release := d.BlockHandler(omorpc.CmdGetState)
	pending := make(chan error, 1)
	go func() { _, err := sess.QueryState(context.Background()); pending <- err }()

	// Wait until the request is parked in the handler, then stop.
	if !d.AwaitRequestCount(omorpc.CmdGetState, 1, testTimeout) {
		t.Fatalf("daemon never saw get_state")
	}
	d.Stop()

	select {
	case err := <-pending:
		if err == nil || !errors.Is(err, omorpc.ErrDisconnected) {
			t.Fatalf("pending call must fail typed ErrDisconnected, got %v", err)
		}
	case <-time.After(testTimeout):
		t.Fatalf("pending call never failed after epoch death")
	}
	release()

	if !sess.Resumable() {
		t.Fatalf("session must become resumable after epoch death")
	}

	// Restart on the same socket: the manager can acquire and resume.
	d.Restart()
	sub2 := newRecorder(64)
	sess2, _, _ := acquire(t, mgr, chat, sub2)
	if sess2.ID() != stored.DurableSessionID {
		t.Fatalf("resume after epoch death must restore durable id %q, got %q", stored.DurableSessionID, sess2.ID())
	}
	_, ready := sub2.await(t, FrameReady)
	if !ready.Resumed {
		t.Fatalf("resume must report resumed=true")
	}
}
