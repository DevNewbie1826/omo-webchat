package session

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/coldhistory"
)

type recoveryReplayRecorder struct {
	*recorder
	beginOnce sync.Once
	endOnce   sync.Once
	began     chan struct{}
	ended     chan struct{}
}

func newRecoveryReplayRecorder() *recoveryReplayRecorder {
	return &recoveryReplayRecorder{recorder: newRecorder(64), began: make(chan struct{}), ended: make(chan struct{})}
}

func (*recoveryReplayRecorder) SynchronousAttach() {}
func (r *recoveryReplayRecorder) BeginReplay()     { r.beginOnce.Do(func() { close(r.began) }) }
func (r *recoveryReplayRecorder) EndReplay()       { r.endOnce.Do(func() { close(r.ended) }) }

func prepareResumableSession(t *testing.T) (*Manager, testChat) {
	t.Helper()
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	mgr := testManager(t, client, store, 64)
	chat := testChat{id: "recovery-order", cwd: t.TempDir()}
	observer := newRecorder(16)
	sess, _, detach := acquire(t, mgr, chat, observer)
	t.Cleanup(detach)
	observer.await(t, FrameReady)
	d.UnloadSession(sess.SessionFile())
	if _, err := sess.QueryState(context.Background()); !errors.Is(err, ErrSessionResumable) {
		t.Fatalf("unloaded route query = %v, want ErrSessionResumable", err)
	}
	return mgr, chat
}

func TestRecoveryFinishesReplayWhenRetryAdmissionFails(t *testing.T) {
	mgr, chat := prepareResumableSession(t)

	// The generated session has a durable disk cursor. Replacing the history
	// streamer gives an exact hydration boundary without timing or polling.
	originalStream := streamSessionHistory
	entered := make(chan struct{})
	release := make(chan struct{})
	streamSessionHistory = func(ctx context.Context, path string, options coldHistoryOptions, emit func(coldHistoryMetadata, coldHistoryPage) error) (coldHistoryMetadata, error) {
		close(entered)
		select {
		case <-release:
		case <-ctx.Done():
			return coldHistoryMetadata{}, ctx.Err()
		}
		return originalStream(ctx, path, options, emit)
	}
	t.Cleanup(func() { streamSessionHistory = originalStream })

	replay := newRecoveryReplayRecorder()
	forced := errors.New("forced retry admission failure")
	runCalled := make(chan struct{})
	result := make(chan error, 1)
	go func() {
		_, _, _, err := mgr.ResumeInitializedCheckedAndRunInFlight(context.Background(), chat, replay, nil, func() error { return nil }, func(*Session) error { return nil }, func(*Session) error {
			close(runCalled)
			return forced
		})
		result <- err
	}()
	<-entered
	select {
	case <-runCalled:
		t.Fatal("retry mutation ran before hydration completed")
	default:
	}
	close(release)
	if err := <-result; !errors.Is(err, forced) {
		t.Fatalf("recovery result = %v, want forced admission failure", err)
	}
	select {
	case <-replay.ended:
	case <-time.After(testTimeout):
		t.Fatal("replay did not finish after retry admission failure")
	}
}

func TestNoIDRecoveryAdmissionSurvivesUnrelatedCompletionDuringHydration(t *testing.T) {
	mgr, chat := prepareResumableSession(t)
	stale, ok := mgr.Get(chat.id)
	if !ok {
		t.Fatal("resumable route is not retained")
	}
	retryToken, prepared := stale.PrepareDetachedSendRetry("", true)
	if !prepared {
		t.Fatal("no-id detached retry was not prepared")
	}
	defer stale.RetireDetachedSendRetry(retryToken)

	originalStream := streamSessionHistory
	entered := make(chan struct{})
	release := make(chan struct{})
	streamSessionHistory = func(ctx context.Context, path string, options coldHistoryOptions, emit func(coldHistoryMetadata, coldHistoryPage) error) (coldHistoryMetadata, error) {
		close(entered)
		select {
		case <-release:
		case <-ctx.Done():
			return coldHistoryMetadata{}, ctx.Err()
		}
		return originalStream(ctx, path, options, emit)
	}
	t.Cleanup(func() { streamSessionHistory = originalStream })

	completed := make(chan error, 1)
	result := make(chan error, 1)
	go func() {
		_, _, _, err := mgr.ResumeInitializedCheckedAndRunInFlight(context.Background(), chat, newRecoveryReplayRecorder(), nil, func() error { return nil }, func(*Session) error { return nil }, func(acquired *Session) error {
			return acquired.SendSteerDetachedWithRetryToken(context.Background(), "recovered steer", "", retryToken, func(err error) {
				completed <- err
			})
		})
		result <- err
	}()
	<-entered

	// This models a pending chat.abort-style failure completing without a
	// request ID while the recovered operation is still hydrating.
	stale.CompleteDetachedSend("", errors.New("unrelated abort failed"))
	close(release)
	if err := <-result; err != nil {
		t.Fatalf("recovered no-id admission: %v", err)
	}
	select {
	case err := <-completed:
		if err != nil {
			t.Fatalf("recovered no-id completion: %v", err)
		}
	case <-time.After(testTimeout):
		t.Fatal("recovered no-id mutation did not complete")
	}
}

func TestRecoveryRevalidatesAfterHydrationBeforeMutation(t *testing.T) {
	mgr, chat := prepareResumableSession(t)
	originalStream := streamSessionHistory
	entered := make(chan struct{})
	release := make(chan struct{})
	streamSessionHistory = func(ctx context.Context, path string, options coldHistoryOptions, emit func(coldHistoryMetadata, coldHistoryPage) error) (coldHistoryMetadata, error) {
		close(entered)
		select {
		case <-release:
		case <-ctx.Done():
			return coldHistoryMetadata{}, ctx.Err()
		}
		return originalStream(ctx, path, options, emit)
	}
	t.Cleanup(func() { streamSessionHistory = originalStream })

	var reject atomic.Bool
	stale := errors.New("metadata changed during hydration")
	runCalled := atomic.Bool{}
	result := make(chan error, 1)
	go func() {
		_, _, _, err := mgr.ResumeInitializedCheckedAndRunInFlight(context.Background(), chat, newRecoveryReplayRecorder(), nil, func() error {
			if reject.Load() {
				return stale
			}
			return nil
		}, func(*Session) error { return nil }, func(*Session) error {
			runCalled.Store(true)
			return nil
		})
		result <- err
	}()
	<-entered
	reject.Store(true)
	close(release)
	if err := <-result; !errors.Is(err, stale) {
		t.Fatalf("recovery result = %v, want post-hydration validation failure", err)
	}
	if runCalled.Load() {
		t.Fatal("retry mutation ran after post-hydration validation failed")
	}
}

// Aliases keep the stream hook signature readable and tied to the production
// cold-history package without duplicating its implementation.
type coldHistoryOptions = coldhistory.Options
type coldHistoryMetadata = coldhistory.Metadata
type coldHistoryPage = coldhistory.Page
