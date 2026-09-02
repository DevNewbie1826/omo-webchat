package session

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func writeHistorySession(t *testing.T, entries, padding int) (path, leafID string) {
	t.Helper()
	path = filepath.Join(t.TempDir(), "large-session.jsonl")
	sum := sha256.Sum256([]byte(path))
	durableID := "durable-" + hex.EncodeToString(sum[:4]) + "-7d24-4b1e-resume"
	return writeHistorySessionAt(t, path, durableID, entries, padding)
}

func writeHistorySessionAt(t *testing.T, path, durableID string, entries, padding int) (string, string) {
	t.Helper()
	var leafID string
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	writer := bufio.NewWriterSize(file, 256<<10)
	encoder := json.NewEncoder(writer)
	if err := encoder.Encode(map[string]any{
		"type": "session", "version": 3, "id": durableID,
		"timestamp": "2026-09-02T00:00:00.000Z", "cwd": filepath.Dir(path),
	}); err != nil {
		t.Fatal(err)
	}
	parent := any(nil)
	body := strings.Repeat("x", padding)
	for i := 0; i < entries; i++ {
		id := fmt.Sprintf("entry-%04d", i)
		entry := map[string]any{
			"type": "message", "id": id, "parentId": parent,
			"timestamp": "2026-09-02T00:00:00.001Z",
			"message": map[string]any{
				"role":    "user",
				"content": []any{map[string]any{"type": "text", "text": body}},
			},
		}
		if err := encoder.Encode(entry); err != nil {
			t.Fatal(err)
		}
		parent, leafID = id, id
	}
	if err := writer.Flush(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	return path, leafID
}

func collectHydrationPages(t *testing.T, sess *Session, sub *recorder) []EntriesFrame {
	t.Helper()
	var pages []EntriesFrame
	for {
		frame := sub.next(t)
		if frame.Kind != FrameEntries {
			continue
		}
		page := frame.Data.(EntriesFrame)
		pages = append(pages, page)
		if page.Final {
			break
		}
	}

	// A marker through the same FIFO proves no second terminal page was queued
	// behind the first one.
	sess.lifecycleMu.Lock()
	sess.publishLocked(Frame{Kind: FrameState, SessionID: sess.ID()})
	sess.lifecycleMu.Unlock()
	for {
		frame := sub.next(t)
		if frame.Kind == FrameState {
			return pages
		}
		if frame.Kind == FrameEntries {
			pages = append(pages, frame.Data.(EntriesFrame))
		}
	}
}

func assertSingleTerminalHistory(t *testing.T, pages []EntriesFrame, wantEntries int) {
	t.Helper()
	terminals, entries := 0, 0
	for _, page := range pages {
		entries += len(page.Entries)
		if page.Final {
			terminals++
		}
	}
	if terminals != 1 || entries != wantEntries {
		t.Fatalf("hydration pages have terminals=%d entries=%d, want 1/%d: %+v", terminals, entries, wantEntries, pages)
	}
	if !pages[len(pages)-1].Final {
		t.Fatalf("terminal page was not last: %+v", pages)
	}
}

func TestHistoryHybridEmptyTailKeepsDiskTranscriptWithOneTerminal(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	path, leafID := writeHistorySession(t, 3, 0)
	if err := store.SaveCursor(context.Background(), "empty-tail", Cursor{SessionFile: path}); err != nil {
		t.Fatal(err)
	}
	mgr := testManager(t, client, store, 64)
	release := d.BlockHandlerForPath(omorpc.CmdGetEntries, path)
	defer release()
	sub := newRecorder(16)
	result := make(chan struct {
		sess   *Session
		detach func()
		err    error
	}, 1)
	go func() {
		sess, _, detach, err := mgr.Acquire(context.Background(), testChat{id: "empty-tail", cwd: filepath.Dir(path)}, sub)
		result <- struct {
			sess   *Session
			detach func()
			err    error
		}{sess, detach, err}
	}()
	if !d.AwaitRequestCount(omorpc.CmdGetEntries, 1, testTimeout) {
		t.Fatal("incremental tail request absent")
	}
	request := d.LastRequest(omorpc.CmdGetEntries)
	id, _ := request["id"].(string)
	sid, _ := request["sessionId"].(string)
	d.WriteRaw(fmt.Appendf(nil, `{"id":%q,"type":"response","command":"get_entries","sessionId":%q,"success":true,"data":{"entries":[],"leafId":%q}}`+"\n", id, sid, leafID))
	got := <-result
	if got.err != nil {
		t.Fatal(got.err)
	}
	defer got.detach()
	release()

	pages := collectHydrationPages(t, got.sess, sub)
	assertSingleTerminalHistory(t, pages, 3)
	terminal := pages[len(pages)-1]
	if len(terminal.Entries) != 0 {
		t.Fatalf("empty tail terminal replaced disk entries: %+v", terminal)
	}
	if terminal.LeafID != leafID {
		t.Fatalf("terminal leaf = %q, want disk leaf %q", terminal.LeafID, leafID)
	}
}

func TestHistoryHybridNonEmptyTailAppendsWithOneTerminal(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	path, leafID := writeHistorySession(t, 2, 0)
	if err := store.SaveCursor(context.Background(), "nonempty-tail", Cursor{SessionFile: path}); err != nil {
		t.Fatal(err)
	}
	mgr := testManager(t, client, store, 64)
	release := d.BlockHandlerForPath(omorpc.CmdGetEntries, path)
	defer release()
	sub := newRecorder(16)
	result := make(chan struct {
		sess   *Session
		detach func()
		err    error
	}, 1)
	go func() {
		sess, _, detach, err := mgr.Acquire(context.Background(), testChat{id: "nonempty-tail", cwd: filepath.Dir(path)}, sub)
		result <- struct {
			sess   *Session
			detach func()
			err    error
		}{sess: sess, detach: detach, err: err}
	}()
	if !d.AwaitRequestCount(omorpc.CmdGetEntries, 1, testTimeout) {
		t.Fatal("incremental tail request absent")
	}
	request := d.LastRequest(omorpc.CmdGetEntries)
	if request["since"] != leafID {
		t.Fatalf("tail cursor = %v, want %q", request["since"], leafID)
	}
	id, _ := request["id"].(string)
	sid, _ := request["sessionId"].(string)
	d.WriteRaw(fmt.Appendf(nil, `{"id":%q,"type":"response","command":"get_entries","sessionId":%q,"success":true,"data":{"entries":[{"type":"message","id":"tail-1","parentId":%q}],"leafId":"tail-1"}}`+"\n", id, sid, leafID))
	var got struct {
		sess   *Session
		detach func()
		err    error
	}
	select {
	case got = <-result:
	case <-time.After(testTimeout):
		t.Fatal("acquire did not complete after tail response")
	}
	if got.err != nil {
		t.Fatal(got.err)
	}
	defer got.detach()
	release()

	pages := collectHydrationPages(t, got.sess, sub)
	assertSingleTerminalHistory(t, pages, 3)
	if terminal := pages[len(pages)-1]; terminal.LeafID != "tail-1" || len(terminal.Entries) != 1 {
		t.Fatalf("tail terminal = %+v", terminal)
	}
}

func TestHistoryHybridUnknownCursorEmptyTailIsIncomplete(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 16)
	sub := newRecorder(16)
	sess, _, detach := acquire(t, mgr, testChat{id: "unknown-cursor", cwd: t.TempDir()}, sub)
	defer detach()
	sub.next(t) // ready

	sess.LoadEntries(context.Background(), "not-a-real-leaf")
	prior, _ := sub.awaitError(t, "incomplete_history")
	for _, frame := range prior {
		if frame.Kind == FrameEntries && frame.Data.(EntriesFrame).Final {
			t.Fatalf("unknown cursor terminalized successfully: %+v", frame)
		}
	}
}

func TestHistoryHybridHeaderOnlyConsultsDaemonThenReportsIncomplete(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	path, _ := writeHistorySession(t, 0, 0)
	if err := store.SaveCursor(context.Background(), "header-only", Cursor{SessionFile: path}); err != nil {
		t.Fatal(err)
	}
	mgr := testManager(t, client, store, 16)
	sub := newRecorder(16)
	_, _, detach := acquire(t, mgr, testChat{id: "header-only", cwd: filepath.Dir(path)}, sub)
	defer detach()
	if !d.AwaitRequestCount(omorpc.CmdGetEntries, 1, testTimeout) {
		t.Fatal("header-only hydration did not consult daemon")
	}
	prior, _ := sub.awaitError(t, "incomplete_history")
	for _, frame := range prior {
		if frame.Kind == FrameEntries && frame.Data.(EntriesFrame).Final {
			t.Fatalf("header-only history terminalized successfully: %+v", frame)
		}
	}
}

func TestHistoryHybridBrokenTailChainReportsIncomplete(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	path, _ := writeHistorySession(t, 2, 0)
	if err := store.SaveCursor(context.Background(), "broken-tail", Cursor{SessionFile: path}); err != nil {
		t.Fatal(err)
	}
	mgr := testManager(t, client, store, 16)
	release := d.BlockHandlerForPath(omorpc.CmdGetEntries, path)
	defer release()
	sub := newRecorder(16)
	done := make(chan error, 1)
	go func() {
		_, _, _, err := mgr.Acquire(context.Background(), testChat{id: "broken-tail", cwd: filepath.Dir(path)}, sub)
		done <- err
	}()
	if !d.AwaitRequestCount(omorpc.CmdGetEntries, 1, testTimeout) {
		t.Fatal("tail request absent")
	}
	request := d.LastRequest(omorpc.CmdGetEntries)
	id, _ := request["id"].(string)
	sid, _ := request["sessionId"].(string)
	d.WriteRaw(fmt.Appendf(nil, `{"id":%q,"type":"response","command":"get_entries","sessionId":%q,"success":true,"data":{"entries":[{"type":"message","id":"tail-1","parentId":"wrong-parent"}],"leafId":"tail-1"}}`+"\n", id, sid))
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	release()
	prior, _ := sub.awaitError(t, "incomplete_history")
	for _, frame := range prior {
		if frame.Kind == FrameEntries && frame.Data.(EntriesFrame).Final {
			t.Fatalf("broken chain terminalized successfully: %+v", frame)
		}
	}
}

func TestHistoryHybridReattachHistoryIsTargetedAndLiveFramesResume(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 2)
	chat := testChat{id: "targeted-history", cwd: t.TempDir()}
	a := newRecorder(32)
	sess, _, detachA := acquire(t, mgr, chat, a)
	defer detachA()
	a.next(t) // ready

	path := filepath.Join(t.TempDir(), "targeted.jsonl")
	path, leaf := writeHistorySessionAt(t, path, sess.ID(), entriesPageMaxCount*2+1, 0)
	sess.lifecycleMu.Lock()
	sess.sessionFile = path
	sess.lifecycleMu.Unlock()
	release := d.BlockHandler(omorpc.CmdGetEntries)
	defer release()
	b := newRecorder(512)
	result := make(chan struct {
		detach func()
		err    error
	}, 1)
	go func() {
		_, _, detach, err := mgr.Acquire(context.Background(), chat, b)
		result <- struct {
			detach func()
			err    error
		}{detach, err}
	}()
	if !d.AwaitRequestCount(omorpc.CmdGetEntries, 1, testTimeout) {
		t.Fatal("reattach tail request absent")
	}
	request := d.LastRequest(omorpc.CmdGetEntries)
	id, _ := request["id"].(string)
	sid, _ := request["sessionId"].(string)
	d.WriteRaw(fmt.Appendf(nil, `{"id":%q,"type":"response","command":"get_entries","sessionId":%q,"success":true,"data":{"entries":[],"leafId":%q}}`+"\n", id, sid, leaf))
	got := <-result
	if got.err != nil {
		t.Fatal(got.err)
	}
	defer got.detach()
	release()

	for _, frame := range a.drain() {
		if frame.Kind == FrameEntries || frame.Kind == FrameError {
			t.Fatalf("socket A received socket B history: %+v", frame)
		}
	}
	pages := collectHydrationPages(t, sess, b)
	assertSingleTerminalHistory(t, pages, entriesPageMaxCount*2+1)

	sess.lifecycleMu.Lock()
	sess.publishLocked(Frame{Kind: FrameState, SessionID: sess.ID()})
	sess.lifecycleMu.Unlock()
	a.await(t, FrameState)
	b.await(t, FrameState)
	if got := sess.broadcast.count(); got != 2 {
		t.Fatalf("subscriber count after replay = %d, want 2", got)
	}
}

func TestHistoryHybridInitializeLiveFrameFollowsHistoryTerminal(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 64)
	chat := testChat{id: "initialize-replay-order", cwd: t.TempDir()}
	sess, _, _ := acquire(t, mgr, chat, nil)
	path := filepath.Join(t.TempDir(), "initialize-replay-order.jsonl")
	path, leaf := writeHistorySessionAt(t, path, sess.ID(), 2, 0)
	sess.lifecycleMu.Lock()
	sess.sessionFile = path
	sess.lifecycleMu.Unlock()

	release := d.BlockHandler(omorpc.CmdGetEntries)
	defer release()
	sub := newRecorder(32)
	result := make(chan struct {
		detach func()
		err    error
	}, 1)
	go func() {
		_, _, detach, err := mgr.AcquireInitialized(context.Background(), chat, sub, func(initialized *Session, _ bool, _ func()) {
			initialized.lifecycleMu.Lock()
			initialized.publishLocked(Frame{Kind: FrameState, SessionID: initialized.ID()})
			initialized.lifecycleMu.Unlock()
		})
		result <- struct {
			detach func()
			err    error
		}{detach: detach, err: err}
	}()
	if !d.AwaitRequestCount(omorpc.CmdGetEntries, 1, testTimeout) {
		t.Fatal("reattach tail request absent")
	}
	request := d.LastRequest(omorpc.CmdGetEntries)
	id, _ := request["id"].(string)
	sid, _ := request["sessionId"].(string)
	d.WriteRaw(fmt.Appendf(nil, `{"id":%q,"type":"response","command":"get_entries","sessionId":%q,"success":true,"data":{"entries":[],"leafId":%q}}`+"\n", id, sid, leaf))
	got := <-result
	if got.err != nil {
		t.Fatal(got.err)
	}
	defer got.detach()

	terminalSeen := false
	for {
		frame := sub.next(t)
		if frame.Kind == FrameEntries && frame.Data.(EntriesFrame).Final {
			terminalSeen = true
		}
		if frame.Kind == FrameState {
			if !terminalSeen {
				t.Fatal("live initialize frame overtook the history terminal")
			}
			break
		}
	}
}

type stuckHistorySubscriber struct {
	ready       chan struct{}
	entered     chan struct{}
	release     chan struct{}
	readyOnce   sync.Once
	once        sync.Once
	releaseOnce sync.Once
}

func (s *stuckHistorySubscriber) Deliver(frame Frame) {
	if frame.Kind == FrameReady {
		s.readyOnce.Do(func() { close(s.ready) })
		return
	}
	s.once.Do(func() { close(s.entered) })
	<-s.release
}
func (s *stuckHistorySubscriber) Cancel() error {
	s.unblock()
	return nil
}
func (s *stuckHistorySubscriber) unblock() {
	s.releaseOnce.Do(func() { close(s.release) })
}

func replayState(target *subscription) (bool, int) {
	target.replayMu.Lock()
	defer target.replayMu.Unlock()
	return target.replaying, len(target.pendingLive)
}

func TestHistoryHybridEpochDeathDuringReplayRetiresTarget(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 1)
	sess, _, _ := acquire(t, mgr, testChat{id: "epoch-death-history", cwd: t.TempDir()}, nil)
	stuck := &stuckHistorySubscriber{ready: make(chan struct{}), entered: make(chan struct{}), release: make(chan struct{})}
	_, target, err := sess.attachCheckedReplayTarget(stuck)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "epoch-death-history.jsonl")
	path, _ = writeHistorySessionAt(t, path, sess.ID(), entriesPageMaxCount*2+1, 0)
	done := make(chan struct{})
	go func() {
		sess.hydrateEntries(context.Background(), path, target)
		close(done)
	}()
	select {
	case <-stuck.entered:
	case <-time.After(testTimeout):
		t.Fatal("disk replay did not enter delivery")
	}

	mgr.invalidateEpoch(sess.epoch)
	stuck.unblock()
	select {
	case <-done:
	case <-time.After(testTimeout):
		t.Fatal("epoch death did not terminate hydration")
	}
	if got := sess.broadcast.count(); got != 0 {
		t.Fatalf("subscriber count after epoch death = %d, want 0", got)
	}
	if active, pending := replayState(target); active || pending != 0 {
		t.Fatalf("replay survived epoch death: active=%v pending=%d", active, pending)
	}
}

func TestHistoryHybridContextCancelDuringReplayRetiresTarget(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 1)
	sess, _, _ := acquire(t, mgr, testChat{id: "cancel-history", cwd: t.TempDir()}, nil)
	stuck := &stuckHistorySubscriber{ready: make(chan struct{}), entered: make(chan struct{}), release: make(chan struct{})}
	_, target, err := sess.attachCheckedReplayTarget(stuck)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "cancel-history.jsonl")
	path, _ = writeHistorySessionAt(t, path, sess.ID(), entriesPageMaxCount*2+1, 0)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		sess.hydrateEntries(ctx, path, target)
		close(done)
	}()
	select {
	case <-stuck.entered:
	case <-time.After(testTimeout):
		t.Fatal("disk replay did not enter delivery")
	}

	cancel()
	select {
	case <-done:
	case <-time.After(testTimeout):
		t.Fatal("context cancellation did not terminate hydration")
	}
	if got := sess.broadcast.count(); got != 0 {
		t.Fatalf("subscriber count after context cancellation = %d, want 0", got)
	}
	if active, pending := replayState(target); active || pending != 0 {
		t.Fatalf("replay survived context cancellation: active=%v pending=%d", active, pending)
	}
}

func TestHistoryHybridReplayAdmissionObservesDeadlineWithoutLifecycleLock(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 1)
	sess, _, _ := acquire(t, mgr, testChat{id: "deadline-history", cwd: t.TempDir()}, nil)
	stuck := &stuckHistorySubscriber{ready: make(chan struct{}), entered: make(chan struct{}), release: make(chan struct{})}
	detach, target, err := sess.attachCheckedTarget(stuck)
	if err != nil {
		t.Fatal(err)
	}
	defer detach()
	defer stuck.unblock()
	target.beginReplay()

	path := filepath.Join(t.TempDir(), "large-session.jsonl")
	path, _ = writeHistorySessionAt(t, path, sess.ID(), entriesPageMaxCount*2+1, 0)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	done := make(chan struct{})
	go func() {
		sess.hydrateEntries(ctx, path, target)
		close(done)
	}()
	select {
	case <-stuck.entered:
	case <-time.After(testTimeout):
		t.Fatal("subscriber did not enter its gated delivery")
	}

	published := make(chan struct{})
	go func() {
		sess.lifecycleMu.Lock()
		sess.publishLocked(Frame{Kind: FrameState, SessionID: sess.ID()})
		sess.lifecycleMu.Unlock()
		close(published)
	}()
	select {
	case <-published:
	case <-time.After(testTimeout):
		t.Fatal("replay admission held lifecycle lock")
	}
	select {
	case <-done:
	case <-time.After(testTimeout):
		t.Fatal("replay admission ignored history deadline")
	}
}

func TestHistoryHybridExpiredContextPublishesHydrationError(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 16)
	sub := newRecorder(16)
	sess, _, detach := acquire(t, mgr, testChat{id: "expired-history", cwd: t.TempDir()}, sub)
	defer detach()
	sub.next(t) // ready
	path, _ := writeHistorySession(t, 3, 0)
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	sess.hydrateEntries(ctx, path)
	prior, frame := sub.awaitError(t, "provider_timeout")
	if !strings.Contains(frame.Data.(ErrorInfo).Message, context.DeadlineExceeded.Error()) {
		t.Fatalf("history error = %+v", frame.Data)
	}
	for _, got := range prior {
		if got.Kind == FrameEntries && got.Data.(EntriesFrame).Final {
			t.Fatalf("expired hydration published success terminal: %+v", got)
		}
	}
}

func TestSessionDeadlineOutcomesKeepStateChangingLatches(t *testing.T) {
	t.Run("prompt", func(t *testing.T) {
		d := newDaemon(t)
		client := dial(t, d)
		mgr := testManager(t, client, newMemStore(), 16)
		sess, _, _ := acquire(t, mgr, testChat{id: "prompt-deadline", cwd: t.TempDir()}, nil)
		release := d.BlockHandler(omorpc.CmdPrompt)
		defer release()
		ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
		defer cancel()
		done := make(chan error, 1)
		go func() { done <- sess.SendPrompt(ctx, "uncertain", nil) }()
		if !d.AwaitRequestCount(omorpc.CmdPrompt, 1, testTimeout) {
			t.Fatal("prompt was not written")
		}
		if err := <-done; !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("prompt error = %v", err)
		}
		if snapshot := sess.RunSnapshot(); !snapshot.Streaming {
			t.Fatalf("delivery-uncertain prompt cleared run latch: %+v", snapshot)
		}
	})

	t.Run("compact", func(t *testing.T) {
		d := newDaemon(t)
		client := dial(t, d)
		mgr := testManager(t, client, newMemStore(), 16)
		sub := newRecorder(16)
		sess, _, _ := acquire(t, mgr, testChat{id: "compact-deadline", cwd: t.TempDir()}, sub)
		sub.next(t) // ready
		release := d.BlockHandler(omorpc.CmdCompact)
		defer release()
		ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
		defer cancel()
		done := make(chan error, 1)
		go func() { done <- sess.Compact(ctx) }()
		if !d.AwaitRequestCount(omorpc.CmdCompact, 1, testTimeout) {
			t.Fatal("compact was not written")
		}
		sub.await(t, FrameCompactionStart)
		if err := <-done; !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("compact error = %v", err)
		}
		if snapshot := sess.RunSnapshot(); !snapshot.Compacting {
			t.Fatalf("delivery-uncertain compact cleared latch: %+v", snapshot)
		}
		sess.lifecycleMu.Lock()
		sess.publishLocked(Frame{Kind: FrameState, SessionID: sess.ID()})
		sess.lifecycleMu.Unlock()
		prior, _ := sub.await(t, FrameState)
		for _, frame := range prior {
			if frame.Kind == FrameCompactionDone {
				t.Fatalf("delivery-uncertain compact published completion: %+v", frame)
			}
		}
	})
}
