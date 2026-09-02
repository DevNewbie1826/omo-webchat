package session

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
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
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(client, newMemStore(), 64)
	release := d.BlockHandler(omorpc.CmdOpenSession)
	result := make(chan error, 1)
	go func() {
		_, _, _, err := mgr.Acquire(context.Background(), testChat{id: "a", cwd: t.TempDir()}, nil)
		result <- err
	}()
	if !d.AwaitRequestCount(omorpc.CmdOpenSession, 1, testTimeout) {
		t.Fatal("open did not reach daemon")
	}
	if err := mgr.CloseAll(context.Background()); err != nil {
		t.Fatalf("CloseAll: %v", err)
	}
	release()
	select {
	case err := <-result:
		if !errors.Is(err, ErrManagerClosed) {
			t.Fatalf("pending acquire = %v, want ErrManagerClosed", err)
		}
	case <-time.After(testTimeout):
		t.Fatal("pending acquire did not abort")
	}
	if _, ok := mgr.Get("a"); ok {
		t.Fatal("pending open registered after CloseAll")
	}
	if !d.AwaitRequestCount(omorpc.CmdCloseSession, 1, testTimeout) {
		t.Fatal("landed pending open was not discarded")
	}
}

func TestMergeGateEpochInvalidationIsChannelScoped(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(client, newMemStore(), 64)
	t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })
	oldCh := make(chan *omorpc.Event)
	newCh := make(chan *omorpc.Event)
	old := newSession(mgr, "old", "/tmp", omorpc.OpenSessionData{SessionID: "rpc-old", State: omorpc.SessionState{SessionID: "dur-old", SessionFile: "/tmp/old"}}, false, oldCh)
	replacement := newSession(mgr, "new", "/tmp", omorpc.OpenSessionData{SessionID: "rpc-new", State: omorpc.SessionState{SessionID: "dur-new", SessionFile: "/tmp/new"}}, false, newCh)
	mgr.mu.Lock()
	mgr.byChat["old"], mgr.byRoute[old.routingID] = old, old
	mgr.byChat["new"], mgr.byRoute[replacement.routingID] = replacement, replacement
	mgr.mu.Unlock()
	mgr.invalidateEpoch(oldCh)
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
	mgr := testManager(client, store, 64)
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
	mgr := testManager(client, store, 64)
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
	mgr := testManager(client, newMemStore(), 64)
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
			mgr := testManager(client, newMemStore(), 64)
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
func (s *cancellableSub) Close() error {
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
	mgr := testManager(client, newMemStore(), 2)
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
	mgr := testManager(client, newMemStore(), 64)
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
	mgr := testManager(client, newMemStore(), 64)
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
	mgr := testManager(client, newMemStore(), 64)
	sub := newRecorder(16)
	s, _, _ := acquire(t, mgr, testChat{id: "a", cwd: t.TempDir()}, sub)
	sub.next(t)
	entries := make([]json.RawMessage, 300)
	for i := range entries {
		entries[i] = json.RawMessage(`{"x":1}`)
	}
	s.lifecycleMu.Lock()
	s.publishEntriesLocked(entries, "leaf")
	s.lifecycleMu.Unlock()
	for page := 0; page < 3; page++ {
		f := sub.next(t)
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
	confirmed := true
	if err := s.RespondApproval("approval-1", json.RawMessage(`"yes"`), &confirmed, false); err != nil {
		t.Fatal(err)
	}
	ack := sub.next(t)
	if ack.Kind != FrameAck || ack.RequestID != "approval-1" {
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
	s, _, _, err := mgr.Acquire(context.Background(), testChat{id: "a", cwd: t.TempDir()}, nil)
	if err != nil {
		t.Fatal(err)
	}
	d.FailNext(omorpc.CmdCloseSession, omorpc.ErrCodeSessionClosing)
	mgr.evict(s)
	if got, ok := mgr.Get("a"); !ok || got != s {
		t.Fatal("failed close removed live session")
	}
	mgr.evict(s)
	if _, ok := mgr.Get("a"); ok {
		t.Fatal("successful eviction retained session")
	}
	if got := d.RequestCount(omorpc.CmdCloseSession); got != 2 {
		t.Fatalf("close retries = %d", got)
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
