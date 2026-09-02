package session

import (
	"bufio"
	"context"
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
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	writer := bufio.NewWriterSize(file, 256<<10)
	encoder := json.NewEncoder(writer)
	if err := encoder.Encode(map[string]any{
		"type": "session", "version": 3, "id": "history-session",
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
	sub := newRecorder(16)
	sess, _, detach := acquire(t, mgr, testChat{id: "empty-tail", cwd: filepath.Dir(path)}, sub)
	defer detach()

	pages := collectHydrationPages(t, sess, sub)
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
func (*stuckHistorySubscriber) Cancel() error { return nil }
func (s *stuckHistorySubscriber) unblock() {
	s.releaseOnce.Do(func() { close(s.release) })
}

func TestHistoryHybridOverflowRetirementDoesNotBlockLifecycle(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 1)
	sess, _, _ := acquire(t, mgr, testChat{id: "overflow-history", cwd: t.TempDir()}, nil)
	stuck := &stuckHistorySubscriber{ready: make(chan struct{}), entered: make(chan struct{}), release: make(chan struct{})}
	detach := sess.Attach(stuck)
	defer detach()
	defer stuck.unblock()
	select {
	case <-stuck.ready:
	case <-time.After(testTimeout):
		t.Fatal("subscriber did not drain its ready replay")
	}

	// Park the delivery pump before hydration fills and overflows its queue.
	sess.lifecycleMu.Lock()
	sess.publishLocked(Frame{Kind: FrameState, SessionID: sess.ID()})
	sess.lifecycleMu.Unlock()
	select {
	case <-stuck.entered:
	case <-time.After(testTimeout):
		t.Fatal("subscriber did not enter its stuck delivery")
	}

	path, _ := writeHistorySession(t, entriesPageMaxCount*2+1, 0)
	done := make(chan struct{})
	go func() {
		sess.hydrateEntries(context.Background(), path)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(testTimeout):
		stuck.unblock()
		<-done
		t.Fatal("overflow retirement blocked hydration while lifecycleMu was held")
	}
	if got := sess.broadcast.count(); got != 0 {
		t.Fatalf("overflowed subscriber remains attached: %d", got)
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
