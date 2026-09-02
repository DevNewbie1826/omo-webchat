package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
)

type blockingCursorStore struct {
	*memCursorStore
	chat    string
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (s *blockingCursorStore) CursorFor(ctx context.Context, chatID string) (Cursor, error) {
	if chatID == s.chat {
		s.once.Do(func() { close(s.entered) })
		select {
		case <-s.release:
		case <-ctx.Done():
			return Cursor{}, ctx.Err()
		}
	}
	return s.memCursorStore.CursorFor(ctx, chatID)
}

func TestMergeGateAcquireSerializesPerChatOnly(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	base := newMemStore()
	store := &blockingCursorStore{memCursorStore: base, chat: "a", entered: make(chan struct{}), release: make(chan struct{})}
	mgr := NewManager(Config{Client: client, Store: store, QueueSize: 64, RetryAttempts: 3, RetryBackoff: time.Millisecond})
	t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })
	aDone := make(chan error, 1)
	go func() {
		_, _, _, err := mgr.Acquire(context.Background(), testChat{id: "a", cwd: t.TempDir()}, nil)
		aDone <- err
	}()
	select {
	case <-store.entered:
	case <-time.After(testTimeout):
		t.Fatal("chat A did not stall")
	}
	bsub := newRecorder(32)
	b, _, _, err := mgr.Acquire(context.Background(), testChat{id: "b", cwd: t.TempDir()}, bsub)
	if err != nil {
		t.Fatalf("chat B acquire: %v", err)
	}
	if f := bsub.next(t); f.Kind != FrameReady {
		t.Fatalf("chat B ready: %+v", f)
	}
	runScript(t, d, b, "independent")
	bsub.await(t, FrameRunDone)
	close(store.release)
	select {
	case err := <-aDone:
		if err != nil {
			t.Fatalf("chat A acquire: %v", err)
		}
	case <-time.After(testTimeout):
		t.Fatal("chat A did not finish")
	}
}

func TestMergeGateCloseAllBarsPendingOpenRegistration(t *testing.T) {
	newBlockedOpen := func(t *testing.T, closeTimeout time.Duration) (*omorpctest.Daemon, *omorpc.Client, *Manager, func(), <-chan error) {
		t.Helper()
		d := newDaemon(t)
		client := dial(t, d)
		mgr := NewManager(Config{Client: client, Store: newMemStore(), QueueSize: 64, RetryAttempts: 3, RetryBackoff: time.Millisecond, CloseTimeout: closeTimeout})
		release := d.BlockHandler(omorpc.CmdOpenSession)
		result := make(chan error, 1)
		go func() {
			_, _, _, err := mgr.Acquire(context.Background(), testChat{id: "a", cwd: t.TempDir()}, nil)
			result <- err
		}()
		if !d.AwaitRequestCount(omorpc.CmdOpenSession, 1, testTimeout) {
			t.Fatal("open did not reach daemon")
		}
		return d, client, mgr, release, result
	}
	assertAcquireClosed := func(t *testing.T, result <-chan error) {
		t.Helper()
		select {
		case err := <-result:
			if !errors.Is(err, ErrManagerClosed) {
				t.Fatalf("pending acquire = %v, want ErrManagerClosed", err)
			}
		case <-time.After(testTimeout):
			t.Fatal("pending acquire did not abort")
		}
	}
	assertClean := func(t *testing.T, d *omorpctest.Daemon, mgr *Manager) {
		t.Helper()
		if !d.AwaitCloseCount(1, testTimeout) {
			t.Fatal("late successful open was not closed")
		}
		if live := d.LiveSessions(); len(live) != 0 {
			t.Fatalf("provider retained canceled open: %v", live)
		}
		if _, ok := mgr.Get("a"); ok {
			t.Fatal("pending open registered after CloseAll")
		}
		mgr.chats.mu.Lock()
		flights := len(mgr.chats.flights)
		mgr.chats.mu.Unlock()
		if flights != 0 {
			t.Fatalf("keyed flights after CloseAll = %d", flights)
		}
	}

	t.Run("release_after_CloseAll_drains_cleanup", func(t *testing.T) {
		d, _, mgr, release, result := newBlockedOpen(t, 50*time.Millisecond)
		closed := make(chan error, 1)
		go func() { closed <- mgr.CloseAll(context.Background()) }()
		assertAcquireClosed(t, result)
		select {
		case err := <-closed:
			t.Fatalf("CloseAll returned before detached open completed: %v", err)
		default:
		}
		release()
		assertClean(t, d, mgr)
		select {
		case err := <-closed:
			if err != nil {
				t.Fatalf("CloseAll: %v", err)
			}
		case <-time.After(testTimeout):
			t.Fatal("CloseAll did not drain detached open")
		}
	})

	t.Run("CloseTimeout_expiry_retains_cleanup_ownership", func(t *testing.T) {
		d, _, mgr, release, result := newBlockedOpen(t, 20*time.Millisecond)
		closed := make(chan error, 1)
		go func() { closed <- mgr.CloseAll(context.Background()) }()
		assertAcquireClosed(t, result)
		select {
		case <-mgr.openCleanupExpired:
		case <-time.After(testTimeout):
			t.Fatal("open cleanup timeout did not expire")
		}
		release()
		assertClean(t, d, mgr)
		select {
		case err := <-closed:
			if err != nil {
				t.Fatalf("CloseAll: %v", err)
			}
		case <-time.After(testTimeout):
			t.Fatal("CloseAll did not drain late success")
		}
	})

	t.Run("client_close_after_CloseAll_cannot_orphan", func(t *testing.T) {
		d, client, mgr, release, result := newBlockedOpen(t, 50*time.Millisecond)
		closed := make(chan error, 1)
		go func() { closed <- mgr.CloseAll(context.Background()) }()
		assertAcquireClosed(t, result)
		release()
		select {
		case err := <-closed:
			if err != nil {
				t.Fatalf("CloseAll: %v", err)
			}
		case <-time.After(testTimeout):
			t.Fatal("CloseAll did not drain before client close")
		}
		if err := client.Close(); err != nil {
			t.Fatalf("client Close: %v", err)
		}
		assertClean(t, d, mgr)
	})
}

func TestMergeGateEpochInvalidationIsTokenScoped(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 64)
	t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })
	oldToken, oldCh := client.CurrentEpoch()
	d.DropConnections()
	select {
	case <-oldCh:
	case <-time.After(testTimeout):
		t.Fatal("old epoch did not close")
	}
	if _, err := client.Call(context.Background(), omorpc.ListSessions{}); err != nil {
		t.Fatalf("reconnect: %v", err)
	}
	newToken, _ := client.CurrentEpoch()
	old := newSession(mgr, "old", "/tmp", omorpc.OpenSessionData{SessionID: "rpc-old", State: omorpc.SessionState{SessionID: "dur-old", SessionFile: "/tmp/old"}}, false, oldToken)
	replacement := newSession(mgr, "new", "/tmp", omorpc.OpenSessionData{SessionID: "rpc-new", State: omorpc.SessionState{SessionID: "dur-new", SessionFile: "/tmp/new"}}, false, newToken)
	mgr.mu.Lock()
	mgr.byChat["old"], mgr.byRoute[old.routingID] = old, old
	mgr.byChat["new"], mgr.byRoute[replacement.routingID] = replacement, replacement
	mgr.mu.Unlock()
	mgr.invalidateEpoch(oldToken)
	if !old.Resumable() {
		t.Fatal("dead correlated-only epoch did not invalidate its session")
	}
	if replacement.Resumable() {
		t.Fatal("old epoch invalidated replacement epoch")
	}
}

func TestMergeGateResumeDisconnectDoesNotFallback(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	chat := testChat{id: "a", cwd: t.TempDir()}
	cur := Cursor{SessionFile: "/tmp/resume.jsonl", DurableSessionID: "durable-stored"}
	_ = store.SaveCursor(context.Background(), chat.id, cur)
	mgr := testManager(t, client, store, 64)
	release := d.BlockHandler(omorpc.CmdOpenSession)
	done := make(chan error, 1)
	go func() { _, _, _, err := mgr.Acquire(context.Background(), chat, nil); done <- err }()
	if !d.AwaitRequestCount(omorpc.CmdOpenSession, 1, testTimeout) {
		t.Fatal("resume did not reach daemon")
	}
	d.DropConnections()
	release()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("delivery-uncertain resume unexpectedly succeeded")
		}
	case <-time.After(testTimeout):
		t.Fatal("resume did not finish")
	}
	if got := d.RequestCount(omorpc.CmdOpenSession); got != 1 {
		t.Fatalf("delivery-uncertain resume issued %d opens", got)
	}
	if got := store.stored(chat.id); got != cur {
		t.Fatalf("cursor changed: %+v", got)
	}
}

func TestMergeGateResumeMismatchClosesRoutingAndKeepsCursor(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	chat := testChat{id: "a", cwd: t.TempDir()}
	cur := Cursor{SessionFile: "/tmp/mismatch.jsonl", DurableSessionID: "not-the-provider-id"}
	_ = store.SaveCursor(context.Background(), chat.id, cur)
	mgr := testManager(t, client, store, 64)
	sub := newRecorder(16)
	s, _, _, err := mgr.Acquire(context.Background(), chat, sub)
	if err != nil {
		t.Fatalf("Acquire fallback: %v", err)
	}
	if s.ID() == cur.DurableSessionID {
		t.Fatal("mismatch reused rejected session")
	}
	if got := store.stored(chat.id); got != cur {
		t.Fatalf("cursor changed: %+v", got)
	}
	if got := d.RequestCount(omorpc.CmdCloseSession); got != 1 {
		t.Fatalf("mismatched routing handle closes = %d, want 1", got)
	}
	sub.awaitError(t, "resume_failed")
}

func TestMergeGateOpenValidationRequiresCompleteDurableIdentity(t *testing.T) {
	cur := Cursor{SessionFile: "/tmp/stored", DurableSessionID: "durable"}
	cases := []omorpc.OpenSessionData{
		{SessionID: "rpc", State: omorpc.SessionState{SessionID: "durable"}},
		{SessionID: "rpc", State: omorpc.SessionState{SessionFile: "/tmp/stored"}},
	}
	for _, data := range cases {
		if err := validateOpen(data, cur, true); err == nil {
			t.Fatalf("incomplete resumed success accepted: %+v", data)
		}
	}
}

func TestMergeGateCompactionResponseThenDelayedStartExactlyOnce(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 64)
	sub := newRecorder(32)
	s, _, _ := acquire(t, mgr, testChat{id: "a", cwd: t.TempDir()}, sub)
	sub.next(t)
	if err := s.Compact(context.Background()); err != nil {
		t.Fatal(err)
	}
	sub.await(t, FrameCompactionStart)
	sub.await(t, FrameCompactionDone)
	injectEvent(t, s, map[string]any{"type": "compaction_start", "reason": "manual", "requestId": "provider-delayed"})
	injectEvent(t, s, map[string]any{"type": "compaction_end", "requestId": "provider-delayed"})
	for _, f := range sub.drain() {
		if f.Kind == FrameCompactionStart || f.Kind == FrameCompactionDone {
			t.Fatalf("delayed compaction duplicated lifecycle: %+v", f)
		}
	}
	injectEvent(t, s, map[string]any{"type": "compaction_start", "reason": "threshold", "requestId": "auto"})
	injectEvent(t, s, map[string]any{"type": "compaction_end", "requestId": "auto", "errorMessage": "too large"})
	_, done := sub.await(t, FrameCompactionDone)
	info := done.Data.(CompactionInfo)
	if info.Error != "too large" {
		t.Fatalf("compaction error = %q", info.Error)
	}
}

func TestMergeGateManualTombstoneCannotSwallowAutomaticCompaction(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 64)
	sub := newRecorder(16)
	s, _, _ := acquire(t, mgr, testChat{id: "compact-pairing", cwd: t.TempDir()}, sub)
	sub.next(t)

	if err := s.Compact(context.Background()); err != nil {
		t.Fatal(err)
	}
	sub.await(t, FrameCompactionStart)
	sub.await(t, FrameCompactionDone)

	injectEvent(t, s, map[string]any{"type": "compaction_start", "reason": "threshold", "requestId": "automatic-b"})
	injectEvent(t, s, map[string]any{"type": "compaction_end", "requestId": "automatic-b"})
	_, started := sub.await(t, FrameCompactionStart)
	_, done := sub.await(t, FrameCompactionDone)
	if started.RequestID != "automatic-b" || done.RequestID != "automatic-b" {
		t.Fatalf("automatic transaction correlation = start %q, done %q", started.RequestID, done.RequestID)
	}
	if started.Data.(CompactionInfo).Phase != "threshold" || done.Data.(CompactionInfo).Phase != "threshold" {
		t.Fatalf("automatic transaction phase = start %+v, done %+v", started.Data, done.Data)
	}

	injectEvent(t, s, map[string]any{"type": "compaction_start", "reason": "manual", "requestId": "delayed-manual-a"})
	injectEvent(t, s, map[string]any{"type": "compaction_end", "requestId": "delayed-manual-a"})
	s.broadcast.publish(Frame{Kind: FrameReady})
	if frame := sub.next(t); frame.Kind != FrameReady {
		t.Fatalf("delayed manual lifecycle emitted an extra frame: %+v", frame)
	}
	s.lifecycleMu.Lock()
	active := s.compactionActive
	s.lifecycleMu.Unlock()
	if active {
		t.Fatal("automatic transaction did not end cleanly")
	}
}

func TestMergeGateCompletedCompactionTombstonesAreBounded(t *testing.T) {
	s := &Session{completedCompactions: make(map[string]struct{})}
	for i := 0; i < maxCompletedCompactions+3; i++ {
		s.rememberCompletedCompactionLocked(string(rune('a'+i)), string(rune('A'+i)))
	}
	if got := len(s.completedCompactionFIFO); got != maxCompletedCompactions {
		t.Fatalf("transaction tombstones = %d, want %d", got, maxCompletedCompactions)
	}
	if got := len(s.completedCompactions); got > maxCompletedCompactions*2 {
		t.Fatalf("id tombstones unbounded: %d", got)
	}
}

func TestMergeGateLocalCommandCompletesInEitherOrdering(t *testing.T) {
	for _, tc := range []struct {
		name       string
		eventFirst bool
	}{{"event_then_response", true}, {"response_then_event", false}} {
		t.Run(tc.name, func(t *testing.T) {
			d := newDaemon(t)
			client := dial(t, d)
			mgr := testManager(t, client, newMemStore(), 64)
			sub := newRecorder(16)
			s, _, _ := acquire(t, mgr, testChat{id: "a", cwd: t.TempDir()}, sub)
			sub.next(t)
			if tc.eventFirst {
				release := d.BlockHandler(omorpc.CmdPrompt)
				done := make(chan error, 1)
				go func() { done <- s.SendPrompt(context.Background(), "/local", nil) }()
				if !d.AwaitRequestCount(omorpc.CmdPrompt, 1, testTimeout) {
					t.Fatal("prompt absent")
				}
				injectEvent(t, s, map[string]any{"type": "command_invocation", "command": map[string]any{"source": "extension"}})
				release()
				if err := <-done; err != nil {
					t.Fatal(err)
				}
			} else {
				if err := s.SendPrompt(context.Background(), "/local", nil); err != nil {
					t.Fatal(err)
				}
				injectEvent(t, s, map[string]any{"type": "command_invocation", "command": map[string]any{"source": "extension"}})
			}
			_, f := sub.await(t, FrameRunDone)
			if f.Data.(RunInfo).Reason != "local_command" {
				t.Fatalf("reason: %+v", f)
			}
			for _, f := range sub.drain() {
				if f.Kind == FrameRunDone {
					t.Fatal("duplicate run.done")
				}
			}
		})
	}
}

type cancellableSub struct {
	entered chan struct{}
	stop    chan struct{}
	once    sync.Once
}

func newCancellableSub() *cancellableSub {
	return &cancellableSub{entered: make(chan struct{}), stop: make(chan struct{})}
}
func (s *cancellableSub) Deliver(f Frame) {
	if f.Kind == FrameReady {
		return
	}
	s.once.Do(func() { close(s.entered) })
	<-s.stop
}
func (s *cancellableSub) Cancel() error {
	select {
	case <-s.stop:
	default:
		close(s.stop)
	}
	return nil
}

func TestMergeGateOverflowCancelsAndDetachesOnce(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	detached := make(chan error, 2)
	mgr := NewManager(Config{Client: client, Store: newMemStore(), QueueSize: 2, OnDetach: func(_ Subscriber, err error) { detached <- err }})
	t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })
	s, _, _, err := mgr.Acquire(context.Background(), testChat{id: "a", cwd: t.TempDir()}, nil)
	if err != nil {
		t.Fatal(err)
	}
	slow := newCancellableSub()
	s.Attach(slow)
	healthy := newRecorder(16)
	s.Attach(healthy)
	healthy.next(t)
	publish := func(n int) {
		s.lifecycleMu.Lock()
		s.publishLocked(Frame{Kind: FrameMessageDelta, SessionID: s.ID(), Data: n})
		s.lifecycleMu.Unlock()
	}
	publish(0)
	select {
	case <-slow.entered:
	case <-time.After(testTimeout):
		t.Fatal("slow subscriber did not block")
	}
	if f := healthy.next(t); f.Kind != FrameMessageDelta {
		t.Fatalf("healthy first frame: %+v", f)
	}
	for i := 1; i < 5; i++ {
		publish(i)
		if f := healthy.next(t); f.Kind != FrameMessageDelta {
			t.Fatalf("healthy frame %d: %+v", i, f)
		}
	}
	select {
	case reason := <-detached:
		if !errors.Is(reason, ErrSubscriberOverflow) {
			t.Fatalf("detach reason: %v", reason)
		}
	case <-time.After(testTimeout):
		t.Fatal("overflow did not detach")
	}
	if got := s.broadcast.count(); got != 1 {
		t.Fatalf("subscriptions = %d, want healthy sibling only", got)
	}
}

func TestMergeGateCloseCancelsBlockedSubscriber(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 2)
	s, _, _ := acquire(t, mgr, testChat{id: "a", cwd: t.TempDir()}, nil)
	sub := newCancellableSub()
	s.Attach(sub)
	s.lifecycleMu.Lock()
	s.publishLocked(Frame{Kind: FrameState, SessionID: s.ID()})
	s.lifecycleMu.Unlock()
	select {
	case <-sub.entered:
	case <-time.After(testTimeout):
		t.Fatal("subscriber not blocked")
	}
	done := make(chan error, 1)
	go func() { done <- s.Close() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(testTimeout):
		t.Fatal("Close did not cancel blocked subscriber")
	}
}

func TestMergeGateAbortStormSingleFlight(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 64)
	s, _, _ := acquire(t, mgr, testChat{id: "a", cwd: t.TempDir()}, nil)
	release := d.BlockHandler(omorpc.CmdAbort)
	for i := 0; i < 100; i++ {
		if err := s.Abort(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if !d.AwaitRequestCount(omorpc.CmdAbort, 1, testTimeout) {
		t.Fatal("abort absent")
	}
	if got := d.RequestCount(omorpc.CmdAbort); got != 1 {
		t.Fatalf("abort storm requests = %d", got)
	}
	release()
}

func TestMergeGateActivityReplayFilteringAndToolProjection(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 64)
	s, _, _ := acquire(t, mgr, testChat{id: "a", cwd: t.TempDir()}, nil)
	injectEvent(t, s, map[string]any{"type": "extension_event", "name": "omo.task.updated", "data": map[string]any{"parent_session_id": s.ID(), "tasks": []any{1}}})
	injectEvent(t, s, map[string]any{"type": "extension_event", "name": "omo.dag.updated", "data": map[string]any{"runs": []any{2}}})
	late := newRecorder(16)
	s.Attach(late)
	if f := late.next(t); f.Kind != FrameReady {
		t.Fatalf("ready: %+v", f)
	}
	for _, want := range activitySnapshotOrder {
		f := late.next(t)
		if f.Kind != FrameExtensionEvent || f.Data.(map[string]any)["name"] != want {
			t.Fatalf("snapshot order want %s: %+v", want, f)
		}
	}
	injectEvent(t, s, map[string]any{"type": "extension_event", "name": "bad", "data": map[string]any{"parent_session_id": "other"}})
	injectEvent(t, s, map[string]any{"type": "extension_event", "name": "allowed", "data": map[string]any{"x": 1}})
	_, allowed := late.await(t, FrameExtensionEvent)
	if allowed.Data.(map[string]any)["name"] != "allowed" {
		t.Fatalf("mismatched parent leaked: %+v", allowed)
	}
	injectEvent(t, s, map[string]any{"type": "tool_execution_update", "toolCallId": "t", "partial": "x"})
	_, tool := late.await(t, FrameTool)
	payload := tool.Data.(map[string]any)
	if payload["phase"] != "update" || payload["partial"] != "x" {
		t.Fatalf("tool payload collapsed: %+v", payload)
	}
}

func TestMergeGateEntriesPagingAndApprovalAck(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 64)
	sub := newRecorder(16)
	s, _, _ := acquire(t, mgr, testChat{id: "a", cwd: t.TempDir()}, sub)
	sub.next(t)
	entries := make([]any, 300)
	for i := range entries {
		entries[i] = map[string]any{"x": 1}
	}
	d.SetPromptScript(s.SessionFile(),
		map[string]any{"type": "entries.stream", "entries": entries, "leafId": "leaf", "final": true},
		map[string]any{"type": "extension_ui_request", "id": "approval-1", "requestId": "client-7", "method": "select"},
		map[string]any{"type": "agent_settled", "reason": "end_turn"},
	)
	if err := s.SendPrompt(context.Background(), "history", nil); err != nil {
		t.Fatal(err)
	}
	for page := 0; page < 3; page++ {
		_, f := sub.await(t, FrameEntries)
		data := f.Data.(EntriesFrame)
		if len(data.Entries) != 100 {
			t.Fatalf("page %d entries = %d", page, len(data.Entries))
		}
		if data.Final != (page == 2) {
			t.Fatalf("page %d final=%v", page, data.Final)
		}
		if page == 2 && data.LeafID != "leaf" {
			t.Fatalf("terminal leaf = %q", data.LeafID)
		}
	}
	_, approval := sub.await(t, FrameApproval)
	if approval.ApprovalID != "approval-1" || approval.RequestID != "client-7" {
		t.Fatalf("approval correlation lost: %+v", approval)
	}
	confirmed := true
	if err := s.RespondApproval(approval.ApprovalID, json.RawMessage(`"yes"`), &confirmed, false); err != nil {
		t.Fatal(err)
	}
	_, ack := sub.await(t, FrameAck)
	if ack.RequestID != "approval-1" {
		t.Fatalf("approval ack: %+v", ack)
	}
	if !d.AwaitRequestCount(omorpc.CmdExtensionUIResponse, 1, testTimeout) {
		t.Fatal("approval response absent")
	}
}

func TestMergeGateIdleEvictionConfirmsBeforeRemoval(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := NewManager(Config{Client: client, Store: newMemStore(), QueueSize: 64, IdleAfter: time.Hour, CloseTimeout: 50 * time.Millisecond})
	t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })
	s, _, _, err := mgr.Acquire(context.Background(), testChat{id: "a", cwd: t.TempDir()}, nil)
	if err != nil {
		t.Fatal(err)
	}
	d.FailNext(omorpc.CmdCloseSession, omorpc.ErrCodeUnknownSession)
	mgr.evict(s)
	if _, ok := mgr.Get("a"); ok {
		t.Fatal("definitive unknown_session retained stale session")
	}
	if got := d.RequestCount(omorpc.CmdCloseSession); got != 1 {
		t.Fatalf("definitive close requests = %d", got)
	}
	replacement, _, _, err := mgr.Acquire(context.Background(), testChat{id: "a", cwd: t.TempDir()}, nil)
	if err != nil {
		t.Fatalf("acquire after eviction: %v", err)
	}
	if replacement == s {
		t.Fatal("acquire after eviction returned evicted handle")
	}
}

func TestMergeGateIdleEvictionTimeoutRetainsSession(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := NewManager(Config{Client: client, Store: newMemStore(), QueueSize: 64, IdleAfter: time.Hour, CloseTimeout: 20 * time.Millisecond})
	t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })
	s, _, _, err := mgr.Acquire(context.Background(), testChat{id: "a", cwd: t.TempDir()}, nil)
	if err != nil {
		t.Fatal(err)
	}
	release := d.BlockHandler(omorpc.CmdCloseSession)
	done := make(chan struct{})
	go func() { mgr.evict(s); close(done) }()
	select {
	case <-done:
	case <-time.After(testTimeout):
		t.Fatal("bounded eviction did not return")
	}
	if got, ok := mgr.Get("a"); !ok || got != s {
		t.Fatal("timed-out close removed session")
	}
	release()
}

func TestMergeGateEpochLostAfterOpenIsResumable(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 64)
	release := d.BlockHandler(omorpc.CmdOpenSession)
	result := make(chan error, 1)
	go func() {
		_, _, _, err := mgr.Acquire(context.Background(), testChat{id: "epoch-lost", cwd: t.TempDir()}, nil)
		result <- err
	}()
	if !d.AwaitRequestCount(omorpc.CmdOpenSession, 1, testTimeout) {
		t.Fatal("open request absent")
	}
	req := d.LastRequest(omorpc.CmdOpenSession)
	id, _ := req["id"].(string)
	oldEpoch := client.Events()
	mgr.mu.Lock() // hold attachment until the response epoch is dead
	d.WriteRaw([]byte(fmt.Sprintf(`{"id":%q,"type":"response","command":"open_session","success":true,"data":{"sessionId":"route-lost","state":{"sessionId":"durable-lost","sessionFile":"/tmp/lost.jsonl"}}}`+"\n", id)))
	d.DropConnections()
	select {
	case _, ok := <-oldEpoch:
		if ok {
			t.Fatal("unexpected event before epoch close")
		}
	case <-time.After(testTimeout):
		t.Fatal("old epoch did not close")
	}
	mgr.mu.Unlock()
	select {
	case err := <-result:
		if !errors.Is(err, ErrSessionResumable) {
			t.Fatalf("Acquire = %v, want ErrSessionResumable", err)
		}
	case <-time.After(testTimeout):
		t.Fatal("Acquire did not settle")
	}
	if _, err := client.Call(context.Background(), omorpc.ListSessions{}); err != nil {
		t.Fatalf("reconnect after response epoch death: %v", err)
	}
	release()
	s, ok := mgr.Get("epoch-lost")
	if !ok || !s.Resumable() {
		t.Fatalf("epoch-lost session = (%v, %v), want registered resumable", s, ok)
	}
	mgr.mu.Lock()
	_, routed := mgr.byRoute["route-lost"]
	mgr.mu.Unlock()
	if routed {
		t.Fatal("epoch-lost route remained live")
	}
}

func TestMergeGateStaleEpochEventCannotReachSuccessor(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	oldToken, oldEvents := client.CurrentEpoch()
	d.DropConnections()
	select {
	case <-oldEvents:
	case <-time.After(testTimeout):
		t.Fatal("old epoch did not close")
	}
	if _, err := client.Call(context.Background(), omorpc.ListSessions{}); err != nil {
		t.Fatalf("reconnect: %v", err)
	}
	newToken, _ := client.CurrentEpoch()
	s := &Session{durableID: "successor", routingID: "reused", epoch: newToken, queueSize: 8, activitySnapshots: map[string]json.RawMessage{}, activityOversized: map[string]bool{}}
	sub := newRecorder(1)
	_, detach := s.broadcast.attach(sub, 8, nil)
	defer detach()
	raw := json.RawMessage(`{"type":"state_changed","sessionId":"reused","value":"stale"}`)
	s.dispatchEpoch(oldToken, &omorpc.Event{Type: "state_changed", SessionID: "reused", Raw: raw})
	// A sentinel through the same FIFO proves the counting subscriber has
	// observed every frame the stale dispatch could have queued.
	s.broadcast.publish(Frame{Kind: FrameReady})
	if frame := sub.next(t); frame.Kind != FrameReady {
		t.Fatalf("stale epoch event reached counting subscriber: %+v", frame)
	}
	if extra := sub.drain(); len(extra) != 0 {
		t.Fatalf("counting subscriber received extra stale frames: %+v", extra)
	}
}

func TestMergeGateMalformedResumeClosesRoutingOnceBeforeFallback(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	chat := testChat{id: "malformed", cwd: t.TempDir()}
	cur := Cursor{SessionFile: "/tmp/malformed.jsonl", DurableSessionID: "stored"}
	_ = store.SaveCursor(context.Background(), chat.id, cur)
	mgr := testManager(t, client, store, 64)
	release := d.BlockHandler(omorpc.CmdOpenSession)
	result := make(chan error, 1)
	go func() {
		_, _, _, err := mgr.Acquire(context.Background(), chat, nil)
		result <- err
	}()
	if !d.AwaitRequestCount(omorpc.CmdOpenSession, 1, testTimeout) {
		t.Fatal("resume request absent")
	}
	id, _ := d.LastRequest(omorpc.CmdOpenSession)["id"].(string)
	d.WriteRaw([]byte(fmt.Sprintf(`{"id":%q,"type":"response","command":"open_session","success":true,"data":{"sessionId":"orphan-route","state":"garbage"}}`+"\n", id)))
	if !d.AwaitRequestCount(omorpc.CmdCloseSession, 1, testTimeout) {
		t.Fatal("partially decoded route was not closed")
	}
	release()
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("fallback acquire: %v", err)
		}
	case <-time.After(testTimeout):
		t.Fatal("fallback acquire did not settle")
	}
	if got := d.RequestCount(omorpc.CmdCloseSession); got != 1 {
		t.Fatalf("orphan close count = %d, want 1", got)
	}
	if got := store.stored(chat.id); got != cur {
		t.Fatalf("cursor changed after fallback: %+v", got)
	}
}

func TestMergeGateDelayedCompactionIDDoesNotBindSuccessor(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 64)
	s, _, _ := acquire(t, mgr, testChat{id: "compact-delay", cwd: t.TempDir()}, nil)
	if err := s.Compact(context.Background()); err != nil {
		t.Fatal(err)
	}
	releaseB := d.BlockHandler(omorpc.CmdCompact)
	bDone := make(chan error, 1)
	go func() { bDone <- s.Compact(context.Background()) }()
	if !d.AwaitRequestCount(omorpc.CmdCompact, 2, testTimeout) {
		t.Fatal("successor compact absent")
	}
	injectEvent(t, s, map[string]any{"type": "compaction_start", "reason": "manual", "requestId": "provider-a"})
	s.lifecycleMu.Lock()
	if s.compactProviderID != "" {
		t.Fatalf("delayed A id bound to B: %q", s.compactProviderID)
	}
	s.lifecycleMu.Unlock()
	injectEvent(t, s, map[string]any{"type": "compaction_end", "requestId": "provider-a"})
	injectEvent(t, s, map[string]any{"type": "compaction_start", "reason": "manual", "requestId": "provider-b"})
	s.lifecycleMu.Lock()
	if s.compactProviderID != "provider-b" || !s.compactionActive {
		t.Fatalf("B lifecycle corrupted: id=%q active=%v", s.compactProviderID, s.compactionActive)
	}
	s.lifecycleMu.Unlock()
	injectEvent(t, s, map[string]any{"type": "compaction_end", "requestId": "provider-b"})
	releaseB()
	if err := <-bDone; err != nil {
		t.Fatal(err)
	}
}

func TestMergeGateMalformedHistoryStillPublishesTerminalFrame(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	chat := testChat{id: "history", cwd: t.TempDir()}
	cur := Cursor{SessionFile: "/tmp/history.jsonl"}
	_ = store.SaveCursor(context.Background(), chat.id, cur)
	mgr := testManager(t, client, store, 64)
	release := d.BlockHandler(omorpc.CmdGetEntries)
	sub := newRecorder(16)
	result := make(chan error, 1)
	go func() {
		_, _, _, err := mgr.Acquire(context.Background(), chat, sub)
		result <- err
	}()
	if !d.AwaitRequestCount(omorpc.CmdGetEntries, 1, testTimeout) {
		t.Fatal("get_entries absent")
	}
	id, _ := d.LastRequest(omorpc.CmdGetEntries)["id"].(string)
	sid, _ := d.LastRequest(omorpc.CmdGetEntries)["sessionId"].(string)
	d.WriteRaw([]byte(fmt.Sprintf(`{"id":%q,"type":"response","command":"get_entries","sessionId":%q,"success":true,"data":{"entries":[{"x":1}],"leafId":123}}`+"\n", id, sid)))
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(testTimeout):
		t.Fatal("Acquire blocked on malformed history")
	}
	release()
	_, frame := sub.await(t, FrameEntries)
	entries := frame.Data.(EntriesFrame)
	if !entries.Final || len(entries.Entries) != 1 || entries.LeafID != "" {
		t.Fatalf("terminal malformed history frame: %+v", entries)
	}
}

func TestMergeGateCommandSourceInfoAndActivityAccessor(t *testing.T) {
	commands, err := decodeCommands([]byte(`{"commands":[{"name":"hooks","sourceInfo":{"path":"<builtin:hooks>","baseDir":"/tmp/omo","source":"builtin","scope":"temporary","origin":"top-level"}}]}`))
	if err != nil || len(commands) != 1 || commands[0].SourceInfo == nil || commands[0].SourceInfo.Path != "<builtin:hooks>" || commands[0].SourceInfo.BaseDir != "/tmp/omo" {
		t.Fatalf("sourceInfo decode = (%+v, %v)", commands, err)
	}
	s := &Session{durableID: "durable", activitySnapshots: map[string]json.RawMessage{"omo.task.updated": json.RawMessage(`{"tasks":[1]}`)}, activityOversized: map[string]bool{}}
	first := s.ActivitySnapshot()
	if len(first) != 1 || first[0].Kind != FrameExtensionEvent {
		t.Fatalf("activity snapshot = %+v", first)
	}
	first[0].Data.(map[string]any)["name"] = "mutated"
	if got := s.ActivitySnapshot()[0].Data.(map[string]any)["name"]; got != "omo.task.updated" {
		t.Fatalf("activity accessor exposed mutable cache: %v", got)
	}
}

func TestMergeGateClosedClientEventLoopExitsAtCloseAll(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	m := testManager(t, client, newMemStore(), 64)
	if err := client.Close(); err != nil {
		t.Fatal(err)
	}
	if err := m.CloseAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	exited := make(chan struct{})
	go func() { m.eventWG.Wait(); close(exited) }()
	select {
	case <-exited:
	case <-time.After(testTimeout):
		t.Fatal("event loop survived CloseAll")
	}
}

func TestMergeGateSlotGenerationsAreBounded(t *testing.T) {
	m := NewManager(Config{})
	m.mu.Lock()
	for i := 0; i < maxSlotGenerations+200; i++ {
		m.bumpSlotGenerationLocked(fmt.Sprintf("chat-%d", i))
	}
	got := len(m.slotGeneration)
	m.mu.Unlock()
	if got > maxSlotGenerations {
		t.Fatalf("slot generations = %d, bound %d", got, maxSlotGenerations)
	}
}

func TestMergeGateGlobalDetachedOpenLimitDrains(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := NewManager(Config{Client: client, Store: newMemStore(), DetachedOpenLimit: 2})
	t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })
	release := d.BlockHandler(omorpc.CmdOpenSession)
	results := make(chan error, 2)
	for i := 0; i < 2; i++ {
		chat := testChat{id: fmt.Sprintf("bounded-%d", i), cwd: t.TempDir()}
		go func() {
			_, _, _, err := mgr.Acquire(context.Background(), chat, nil)
			results <- err
		}()
	}
	if !d.AwaitRequestCount(omorpc.CmdOpenSession, 2, testTimeout) {
		t.Fatal("bounded opens did not occupy both slots")
	}
	_, _, _, err := mgr.Acquire(context.Background(), testChat{id: "excess", cwd: t.TempDir()}, nil)
	if !errors.Is(err, ErrOpenBusy) {
		t.Fatalf("excess acquire error = %v, want ErrOpenBusy", err)
	}
	release()
	for i := 0; i < 2; i++ {
		if err := <-results; err != nil {
			t.Fatalf("bounded acquire failed: %v", err)
		}
	}
	if _, _, detach, err := mgr.Acquire(context.Background(), testChat{id: "after-drain", cwd: t.TempDir()}, nil); err != nil {
		t.Fatalf("acquire after drain: %v", err)
	} else if detach != nil {
		detach()
	}
}
