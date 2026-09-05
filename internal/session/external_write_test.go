package session

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
)

func TestInPlaceMutationFenceQuarantinesDirectFileDrift(t *testing.T) {
	for _, tc := range []struct {
		name       string
		mutate     func(*testing.T, string)
		wantCause  error
		wantReason string
	}{
		{name: "unlink", wantCause: os.ErrNotExist, mutate: func(t *testing.T, path string) {
			t.Helper()
			if err := os.Remove(path); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "rename", wantCause: os.ErrNotExist, mutate: func(t *testing.T, path string) {
			t.Helper()
			if err := os.Rename(path, path+".moved"); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "chmod-000", wantCause: os.ErrPermission, wantReason: "session file is not readable", mutate: func(t *testing.T, path string) {
			t.Helper()
			t.Cleanup(func() { _ = os.Chmod(path, 0o600) })
			if err := os.Chmod(path, 0); err != nil {
				t.Fatal(err)
			}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cwd := t.TempDir()
			path := filepath.Join(cwd, "durable-direct-drift.jsonl")
			body := fmt.Sprintf("{\"type\":\"session\",\"id\":\"durable-direct-drift\",\"version\":3,\"timestamp\":\"2026-09-03T00:00:00Z\",\"cwd\":%q}\n", cwd) +
				"{\"type\":\"message\",\"id\":\"root\",\"parentId\":null,\"message\":{\"role\":\"user\",\"content\":\"before\"}}\n"
			if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
				t.Fatal(err)
			}
			daemon := newDaemon(t)
			if err := daemon.LoadSessionFile(path); err != nil {
				t.Fatal(err)
			}
			store := newMemStore()
			store.cursors["chat-direct-drift"] = Cursor{SessionFile: path, DurableSessionID: "durable-direct-drift", InPlace: true}
			manager := testManager(t, dial(t, daemon), store, 32)
			sub := newRecorder(32)
			sess, _, detach := acquire(t, manager, testChat{id: "chat-direct-drift", cwd: cwd}, sub)
			defer detach()
			sub.await(t, FrameReady)
			sub.await(t, FrameEntries)

			tc.mutate(t, path)

			beforePrompts := daemon.RequestCount(omorpc.CmdPrompt)
			err := sess.SendPrompt(context.Background(), "must not reach stale route", nil)
			var drift *ExternalWriteError
			if !errors.As(err, &drift) || !errors.Is(err, tc.wantCause) {
				t.Fatalf("prompt error = %T %v, want typed external-write wrapping %v", err, err, tc.wantCause)
			}
			if tc.wantReason != "" && drift.Reason != tc.wantReason {
				t.Fatalf("drift reason = %q, want %q", drift.Reason, tc.wantReason)
			}
			if got := daemon.RequestCount(omorpc.CmdPrompt); got != beforePrompts {
				t.Fatalf("prompt reached provider: prompt count %d -> %d", beforePrompts, got)
			}
			sess.lifecycleMu.Lock()
			_, routeErr := sess.routeLocked()
			latched := sess.quarantineErr
			sess.lifecycleMu.Unlock()
			if latched == nil || !errors.As(routeErr, &drift) {
				t.Fatalf("route was not quarantined: latch=%v route error=%T %v", latched, routeErr, routeErr)
			}
			_, frame := sub.awaitError(t, "external-write-detected")
			if info, ok := frame.Data.(ErrorInfo); !ok || info.Code != "external-write-detected" {
				t.Fatalf("quarantine transition = %#v", frame.Data)
			}
		})
	}
}

type blockingNameStore struct {
	*memCursorStore
	entered     chan struct{}
	release     chan struct{}
	enteredOnce sync.Once
}

func (s *blockingNameStore) UpdateName(ctx context.Context, chatID, name, source string) error {
	s.enteredOnce.Do(func() { close(s.entered) })
	select {
	case <-s.release:
	case <-ctx.Done():
		return ctx.Err()
	}
	return s.memCursorStore.UpdateName(ctx, chatID, name, source)
}

func TestAutoTitleQuarantineDuringNamePersistenceSkipsProviderRename(t *testing.T) {
	cwd := t.TempDir()
	path := filepath.Join(cwd, "durable-blocked-auto-title.jsonl")
	body := fmt.Sprintf("{\"type\":\"session\",\"id\":\"durable-blocked-auto-title\",\"version\":3,\"timestamp\":\"2026-09-03T00:00:00Z\",\"cwd\":%q}\n", cwd) +
		"{\"type\":\"message\",\"id\":\"root\",\"parentId\":null,\"message\":{\"role\":\"user\",\"content\":\"before\"}}\n"
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	daemon := newDaemon(t)
	if err := daemon.LoadSessionFile(path); err != nil {
		t.Fatal(err)
	}
	base := newMemStore()
	base.cursors["chat-blocked-auto-title"] = Cursor{SessionFile: path, DurableSessionID: "durable-blocked-auto-title", InPlace: true}
	store := &blockingNameStore{memCursorStore: base, entered: make(chan struct{}), release: make(chan struct{})}
	manager := testManager(t, dial(t, daemon), store, 32)
	sub := newRecorder(32)
	sess, _, detach := acquire(t, manager, testChat{id: "chat-blocked-auto-title", cwd: cwd}, sub)
	defer detach()
	sub.await(t, FrameReady)
	sub.await(t, FrameEntries)

	done := make(chan struct{})
	go func() {
		sess.applyAutoTitle(context.Background(), "Must not rename stale route")
		close(done)
	}()
	select {
	case <-store.entered:
	case <-time.After(testTimeout):
		t.Fatal("automatic title did not enter UpdateName")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	var drift *ExternalWriteError
	if err := sess.prepareWrite(context.Background()); !errors.As(err, &drift) {
		t.Fatalf("mutation fence error = %T %v, want external-write error", err, err)
	}
	close(store.release)
	select {
	case <-done:
	case <-time.After(testTimeout):
		t.Fatal("automatic title did not return after UpdateName")
	}
	if got := daemon.RequestCount(omorpc.CmdSetSessionName); got != 0 {
		t.Fatalf("quarantined automatic title reached stale route: set_session_name requests = %d", got)
	}
}

func TestAutoTitleFenceRejectsUnlinkedInPlaceSession(t *testing.T) {
	cwd := t.TempDir()
	path := filepath.Join(cwd, "durable-auto-title.jsonl")
	body := fmt.Sprintf("{\"type\":\"session\",\"id\":\"durable-auto-title\",\"version\":3,\"timestamp\":\"2026-09-03T00:00:00Z\",\"cwd\":%q}\n", cwd) +
		"{\"type\":\"message\",\"id\":\"root\",\"parentId\":null,\"message\":{\"role\":\"user\",\"content\":\"before\"}}\n"
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	daemon := newDaemon(t)
	if err := daemon.LoadSessionFile(path); err != nil {
		t.Fatal(err)
	}
	store := newMemStore()
	store.cursors["chat-auto-title-fence"] = Cursor{SessionFile: path, DurableSessionID: "durable-auto-title", InPlace: true}
	manager := testManager(t, dial(t, daemon), store, 32)
	sub := newRecorder(32)
	sess, _, detach := acquire(t, manager, testChat{id: "chat-auto-title-fence", cwd: cwd}, sub)
	defer detach()
	sub.await(t, FrameReady)
	sub.await(t, FrameEntries)

	releasePrompt := daemon.BlockHandler(omorpc.CmdPrompt)
	defer releasePrompt()
	done := make(chan error, 1)
	go func() { done <- sess.SendPrompt(context.Background(), "Must not rename stale route", nil) }()
	if !daemon.AwaitRequestCount(omorpc.CmdPrompt, 1, testTimeout) {
		t.Fatal("prompt did not enter provider")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	releasePrompt()
	if err := <-done; err != nil {
		t.Fatalf("accepted prompt returned error: %v", err)
	}
	sub.awaitError(t, "external-write-detected")
	if got := daemon.RequestCount(omorpc.CmdSetSessionName); got != 0 {
		t.Fatalf("automatic title reached stale route: set_session_name requests = %d", got)
	}
}

type blockingHistoryRecorder struct {
	frames            chan Frame
	entered           chan struct{}
	release           chan struct{}
	transitionEntered chan struct{}
	transitionRelease chan struct{}
	replayEvents      chan string
	enteredOnce       sync.Once
	transitionOnce    sync.Once
}

func (s *blockingHistoryRecorder) Deliver(frame Frame) {
	s.frames <- frame
	if frame.Kind == FrameEntries {
		s.enteredOnce.Do(func() {
			close(s.entered)
			<-s.release
		})
	}
	if frame.Kind == FrameError {
		if info, ok := frame.Data.(ErrorInfo); ok && info.Code == "external-write-detected" {
			s.replayEvents <- "transition"
			s.transitionOnce.Do(func() {
				close(s.transitionEntered)
				<-s.transitionRelease
			})
		}
	}
	if frame.Kind == FrameExtensionEvent {
		s.replayEvents <- "activity"
	}
}

func (s *blockingHistoryRecorder) BeginReplay()  {}
func (s *blockingHistoryRecorder) EndReplay()    { s.replayEvents <- "end" }
func (s *blockingHistoryRecorder) Cancel() error { return nil }

func TestHydrationLosingQuarantineRaceEndsReplayWithoutDuplicateTransition(t *testing.T) {
	sess, path := newValidatedHistorySession(t, "quarantine-race", 1)
	identity, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	sess.sessionFileIdentity = identity
	sess.inPlace = true

	observer := newRecorder(8)
	detachObserver, _, err := sess.attachCheckedTarget(observer)
	if err != nil {
		t.Fatal(err)
	}
	defer detachObserver()
	blocked := &blockingHistoryRecorder{
		frames:            make(chan Frame, 16),
		entered:           make(chan struct{}),
		release:           make(chan struct{}),
		transitionEntered: make(chan struct{}),
		transitionRelease: make(chan struct{}),
		replayEvents:      make(chan string, 3),
	}
	detachReplay, target, err := sess.attachCheckedReplayTarget(blocked)
	if err != nil {
		t.Fatal(err)
	}
	defer detachReplay()

	hydrated := make(chan struct{})
	go func() {
		sess.hydrateEntriesValidated(context.Background(), path, target, nil)
		close(hydrated)
	}()
	select {
	case <-blocked.entered:
	case <-time.After(testTimeout):
		t.Fatal("hydration did not enter blocked replay delivery")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	var drift *ExternalWriteError
	if err := sess.prepareWrite(context.Background()); !errors.As(err, &drift) {
		t.Fatalf("mutation fence error = %T %v, want external-write error", err, err)
	}
	observer.awaitError(t, "external-write-detected")
	if active, pending := replayState(target); !active || pending != 1 {
		t.Fatalf("quarantine transition was not buffered during replay: active=%v pending=%d", active, pending)
	}
	close(blocked.release)
	select {
	case <-blocked.transitionEntered:
	case <-time.After(testTimeout):
		t.Fatal("buffered quarantine transition was not delivered")
	}
	activity := Frame{Kind: FrameExtensionEvent, SessionID: sess.ID(), Data: map[string]any{"name": "omo.task.updated"}}
	sess.lifecycleMu.Lock()
	sess.publishLocked(activity)
	sess.lifecycleMu.Unlock()
	close(blocked.transitionRelease)
	select {
	case <-hydrated:
	case <-time.After(testTimeout):
		t.Fatal("hydration did not complete after quarantine race")
	}
	if active, pending := replayState(target); active || pending != 0 {
		t.Fatalf("replay did not complete: active=%v pending=%d", active, pending)
	}
	for i, want := range []string{"transition", "activity", "end"} {
		select {
		case got := <-blocked.replayEvents:
			if got != want {
				t.Fatalf("replay event %d = %q, want %q", i, got, want)
			}
		case <-time.After(testTimeout):
			t.Fatalf("timed out waiting for replay event %q", want)
		}
	}

	sess.lifecycleMu.Lock()
	sess.publishLocked(Frame{Kind: FrameState, SessionID: sess.ID()})
	sess.lifecycleMu.Unlock()
	transitions := 0
	for {
		select {
		case frame := <-blocked.frames:
			if frame.Kind == FrameError && frame.Data.(ErrorInfo).Code == "external-write-detected" {
				transitions++
			}
			if frame.Kind == FrameState {
				if transitions != 1 {
					t.Fatalf("quarantine transitions before subsequent live frame = %d, want 1", transitions)
				}
				return
			}
		case <-time.After(testTimeout):
			t.Fatal("subsequent live frame remained buffered after replay")
		}
	}
}

func TestInPlaceQuarantinePublishesOnceToEveryAttachedSubscriber(t *testing.T) {
	cwd := t.TempDir()
	path := filepath.Join(cwd, "durable-broadcast.jsonl")
	body := fmt.Sprintf("{\"type\":\"session\",\"id\":\"durable-broadcast\",\"version\":3,\"timestamp\":\"2026-09-03T00:00:00Z\",\"cwd\":%q}\n", cwd) +
		"{\"type\":\"message\",\"id\":\"root\",\"parentId\":null,\"message\":{\"role\":\"user\",\"content\":\"before\"}}\n"
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	daemon := newDaemon(t)
	if err := daemon.LoadSessionFile(path); err != nil {
		t.Fatal(err)
	}
	store := newMemStore()
	store.cursors["chat-broadcast"] = Cursor{SessionFile: path, DurableSessionID: "durable-broadcast", InPlace: true}
	manager := testManager(t, dial(t, daemon), store, 32)
	chat := testChat{id: "chat-broadcast", cwd: cwd}

	a := newRecorder(32)
	sess, _, detachA := acquire(t, manager, chat, a)
	defer detachA()
	a.await(t, FrameReady)
	a.await(t, FrameEntries)
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString("{\"type\":\"message\",\"id\":\"external-leaf\",\"parentId\":\"root\",\"message\":{\"role\":\"user\",\"content\":\"external\"}}\n"); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	b := newRecorder(32)
	reused, started, detachB := acquire(t, manager, chat, b)
	defer detachB()
	if started || reused != sess {
		t.Fatal("drift detection replaced the attached route")
	}

	sess.lifecycleMu.Lock()
	sess.publishLocked(Frame{Kind: FrameState, SessionID: sess.ID()})
	sess.lifecycleMu.Unlock()
	priorA, _ := a.await(t, FrameState)
	priorB, _ := b.await(t, FrameState)
	for name, frames := range map[string][]Frame{"existing": priorA, "detecting": priorB} {
		count := 0
		for _, frame := range frames {
			if frame.Kind == FrameError && frame.Data.(ErrorInfo).Code == "external-write-detected" {
				count++
			}
		}
		if count != 1 {
			t.Fatalf("%s subscriber received %d quarantine transitions, want 1: %+v", name, count, frames)
		}
	}
	if entries := frameIndex(priorB, FrameEntries); entries >= 0 {
		t.Fatalf("failed hydration leaked partial disk history: %+v", priorB)
	}
}

func TestDetachedCompletionKeepsExternalWriteQuarantineAfterDisconnect(t *testing.T) {
	drift := &ExternalWriteError{KnownLeaf: "known", ObservedLeaf: "changed", Reason: "test drift"}
	s := &Session{quarantineErr: drift, resumable: true}
	completed := make(chan error, 1)
	s.finishDetachedSend(omorpc.ErrDisconnected, "chat.send", "quarantined", func(err error) {
		completed <- err
	})
	if err := <-completed; err != drift {
		t.Fatalf("completion error = %T %v, want latched quarantine", err, err)
	}
	if err := s.acquisitionError(); err != drift {
		t.Fatalf("acquisition error = %T %v, want latched quarantine", err, err)
	}
}

func TestInPlaceReattachRehydratesDiskAndReportsExternalLeaf(t *testing.T) {
	cwd := t.TempDir()
	path := filepath.Join(cwd, "durable-external.jsonl")
	body := fmt.Sprintf("{\"type\":\"session\",\"id\":\"durable-external\",\"version\":3,\"timestamp\":\"2026-09-03T00:00:00Z\",\"cwd\":%q}\n", cwd) +
		"{\"type\":\"message\",\"id\":\"root\",\"parentId\":null,\"message\":{\"role\":\"user\",\"content\":\"before\"}}\n"
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	daemon := newDaemon(t)
	if err := daemon.LoadSessionFile(path); err != nil {
		t.Fatal(err)
	}
	store := newMemStore()
	store.cursors["chat-external"] = Cursor{SessionFile: path, DurableSessionID: "durable-external", InPlace: true}
	manager := testManager(t, dial(t, daemon), store, 32)
	chat := testChat{id: "chat-external", cwd: cwd}

	first := newRecorder(32)
	stale, _, detach := acquire(t, manager, chat, first)
	first.await(t, FrameReady)
	first.await(t, FrameEntries)
	detach()
	if err, duplicate := stale.beginSendOperation("survives-quarantine-recovery"); err != nil || duplicate {
		t.Fatalf("begin retained operation = (%v, %v)", err, duplicate)
	}
	stale.recordSendOperation("survives-quarantine-recovery", nil)
	stale.CompleteDetachedSend("survives-quarantine-recovery", nil)

	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	_, writeErr := file.WriteString("{\"type\":\"message\",\"id\":\"external-leaf\",\"parentId\":\"root\",\"message\":{\"role\":\"user\",\"content\":\"external\"}}\n")
	if writeErr != nil {
		_ = file.Close()
		t.Fatal(writeErr)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	second := newRecorder(32)
	_, started, detachSecond := acquire(t, manager, chat, second)
	defer detachSecond()
	if started {
		t.Fatal("reattach unexpectedly opened a replacement provider route")
	}
	prior, frame := second.awaitError(t, "external-write-detected")
	info, ok := frame.Data.(ErrorInfo)
	if !ok || info.KnownLeaf != "root" || info.ObservedLeaf != "external-leaf" {
		t.Fatalf("external-write state = %#v", frame.Data)
	}
	for _, candidate := range prior {
		if candidate.Kind != FrameEntries {
			continue
		}
		for _, entry := range candidate.Data.(EntriesFrame).Entries {
			if bytes.Contains(entry, []byte("external-leaf")) {
				t.Fatalf("failed hydration leaked external disk entry: %+v", prior)
			}
		}
	}

	beforePrompts := daemon.RequestCount(omorpc.CmdPrompt)
	err = stale.SendPrompt(context.Background(), "must not reach stale route", nil)
	var drift *ExternalWriteError
	if !errors.As(err, &drift) {
		t.Fatalf("post-drift prompt error = %T %v, want typed external-write error", err, err)
	}
	if got := daemon.RequestCount(omorpc.CmdPrompt); got != beforePrompts {
		t.Fatalf("post-drift prompt reached provider: prompt count %d -> %d", beforePrompts, got)
	}

	beforeOpens := daemon.RequestCount(omorpc.CmdOpenSession)
	beforeCloses := daemon.RequestCount(omorpc.CmdCloseSession)
	_, _, ordinaryDetach, err := manager.Acquire(context.Background(), chat, newRecorder(32))
	if ordinaryDetach != nil {
		ordinaryDetach()
	}
	if !errors.As(err, &drift) {
		t.Fatalf("ordinary reattach error = %T %v, want typed external-write error", err, err)
	}
	if got := daemon.RequestCount(omorpc.CmdCloseSession); got != beforeCloses {
		t.Fatalf("ordinary reattach closed quarantined route: %d -> %d", beforeCloses, got)
	}
	if got := daemon.RequestCount(omorpc.CmdOpenSession); got != beforeOpens {
		t.Fatalf("ordinary reattach reopened quarantined route: %d -> %d", beforeOpens, got)
	}

	// The first explicit recovery closes the quarantined route, then fails all
	// reopen attempts. No live session remains to carry operation state.
	daemon.FailOpenPath(path, omorpctest.CodeSessionPathInUse, 3)
	_, _, failedDetach, err := manager.AcquireInitializedWithRecovery(context.Background(), chat, newRecorder(32), nil)
	if failedDetach != nil {
		failedDetach()
	}
	var pathInUse *omorpc.StableError
	if !errors.As(err, &pathInUse) || pathInUse.Code != omorpc.ErrCodeSessionPathInUse {
		t.Fatalf("failed quarantine reopen = %T %v, want session_path_in_use", err, err)
	}
	if _, live := manager.Get(chat.id); live {
		t.Fatal("failed quarantine reopen left a live session")
	}

	recoveredSub := newRecorder(32)
	recovered, started, recoveredDetach, err := manager.AcquireInitializedWithRecovery(context.Background(), chat, recoveredSub, nil)
	if err != nil {
		t.Fatalf("explicit recovery retry: %v", err)
	}
	defer recoveredDetach()
	if !started {
		t.Fatal("external-write recovery retry reused a prior route")
	}
	replayPrior, _ := recoveredSub.await(t, FrameReady)
	retainedOutcome := false
	for _, frame := range replayPrior {
		if frame.Kind == FrameAck && frame.RequestID == "survives-quarantine-recovery" && frame.Phase == "completed" {
			retainedOutcome = true
		}
	}
	if !retainedOutcome {
		t.Fatalf("successful retry did not replay retained outcome: %+v", replayPrior)
	}
	if recovered.RoutingID() == stale.RoutingID() {
		t.Fatalf("external-write recovery retained stale route %q", stale.RoutingID())
	}
	if recovered.operationOwner() != stale.operationOwner() {
		t.Fatal("external-write recovery lost the retained operation owner")
	}
	beforeFollowUps := daemon.RequestCount(omorpc.CmdFollowUp)
	if err := recovered.SendFollowUpDetachedWithRequestID(context.Background(), "duplicate", nil, "survives-quarantine-recovery"); err != nil {
		t.Fatalf("duplicate retained operation: %v", err)
	}
	if got := daemon.RequestCount(omorpc.CmdFollowUp); got != beforeFollowUps {
		t.Fatalf("duplicate retained operation reached provider: %d -> %d", beforeFollowUps, got)
	}
	owner := recovered.operationOwner()
	owner.mu.Lock()
	retained := owner.operations["survives-quarantine-recovery"]
	owner.mu.Unlock()
	if retained.phase != sendOperationTerminal || retained.outcome.Kind != FrameAck || retained.outcome.Phase != "completed" {
		t.Fatalf("late retained outcome = %+v", retained)
	}
	if got := daemon.RequestCount(omorpc.CmdCloseSession); got != beforeCloses+1 {
		t.Fatalf("external-write recovery close count = %d, want %d", got, beforeCloses+1)
	}
	if got := daemon.RequestCount(omorpc.CmdOpenSession); got != beforeOpens+4 {
		t.Fatalf("external-write recovery open count = %d, want %d", got, beforeOpens+4)
	}
	open := daemon.LastRequest(omorpc.CmdOpenSession)
	if got, _ := open["sessionPath"].(string); got != path {
		t.Fatalf("external-write recovery opened %q, want original %q", got, path)
	}
}
