package session

// A session may report a file path that does not exist yet. The path can
// appear later, while history requests made before it appears still return
// the entries currently visible on the wire.

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/coldhistory"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
)

func hydrateAbsentPath(t *testing.T, sess *Session, d *omorpctest.Daemon) (*recorder, func() (pages []EntriesFrame, errs []ErrorInfo)) {
	t.Helper()
	path := sess.SessionFile()
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
	if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("session path is present before hydration: %v", err)
	}
	before := d.RequestCount(omorpc.CmdGetEntries)
	sub := newRecorder(32)
	detach, target, err := sess.attachCheckedReplayTarget(sub)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(detach)
	sess.hydrateEntries(context.Background(), path, target)
	if got := d.RequestCount(omorpc.CmdGetEntries); got != before+1 {
		t.Fatalf("get_entries request count = %d, want %d", got, before+1)
	}
	if request := d.LastRequest(omorpc.CmdGetEntries); request["since"] != nil {
		t.Fatalf("root get_entries request included since: %#v", request)
	}

	sess.lifecycleMu.Lock()
	sess.publishLocked(Frame{Kind: FrameState, SessionID: sess.ID()})
	sess.lifecycleMu.Unlock()
	scan := func() (pages []EntriesFrame, errs []ErrorInfo) {
		for {
			frame := sub.next(t)
			switch frame.Kind {
			case FrameEntries:
				pages = append(pages, frame.Data.(EntriesFrame))
			case FrameError:
				errs = append(errs, frame.Data.(ErrorInfo))
			case FrameState:
				return pages, errs
			}
		}
	}
	return sub, scan
}

func TestHistoryMissingSessionFileHydratesEmptyTerminalPage(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 16)
	sess, _, detach := acquire(t, mgr, testChat{id: "enoent-empty", cwd: t.TempDir()}, nil)
	defer detach()

	_, scan := hydrateAbsentPath(t, sess, d)
	pages, errs := scan()
	if len(errs) != 0 {
		t.Fatalf("absent session path produced error frames: %+v", errs)
	}
	assertSingleTerminalHistory(t, pages, 0)
	if terminal := pages[len(pages)-1]; terminal.LeafID != "" {
		t.Fatalf("terminal leaf = %q, want empty", terminal.LeafID)
	}
}

func TestHistoryMissingSessionFileHydratesEntriesFromRoot(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 16)
	sess, _, detach := acquire(t, mgr, testChat{id: "enoent-held", cwd: t.TempDir()}, nil)
	defer detach()

	if err := os.Remove(sess.SessionFile()); err != nil {
		t.Fatal(err)
	}
	d.SetPromptScript(sess.SessionFile(), map[string]any{"type": omorpctest.EventAgentSettled})
	if err := sess.SendPrompt(context.Background(), "visible before the path appears", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(sess.SessionFile()); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("session path is present before hydration: %v", err)
	}

	_, scan := hydrateAbsentPath(t, sess, d)
	pages, errs := scan()
	if len(errs) != 0 {
		t.Fatalf("absent session path produced error frames: %+v", errs)
	}
	assertSingleTerminalHistory(t, pages, 1)
	terminal := pages[len(pages)-1]
	if terminal.LeafID != "entry-1" || len(terminal.Entries) != 1 {
		t.Fatalf("terminal page = %+v, want entry-1", terminal)
	}
}

func TestHistoryMissingResumedSessionFileSurfacesOpenErrorWithoutRootFetch(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	path := filepath.Join(t.TempDir(), "missing-resumed.jsonl")
	store.cursors["enoent-resumed"] = Cursor{SessionFile: path}
	mgr := testManager(t, client, store, 16)
	sub := newRecorder(16)

	before := d.RequestCount(omorpc.CmdGetEntries)
	_, _, detach := acquire(t, mgr, testChat{id: "enoent-resumed", cwd: filepath.Dir(path)}, sub)
	defer detach()
	prior, frame := sub.awaitError(t, "decode_failed")
	for _, got := range prior {
		if got.Kind == FrameEntries {
			t.Fatalf("missing resumed path produced an entries page: %+v", got)
		}
	}
	info := frame.Data.(ErrorInfo)
	if !strings.Contains(info.Message, path) {
		t.Fatalf("history error = %q, want missing path %q", info.Message, path)
	}
	if got := d.RequestCount(omorpc.CmdGetEntries); got != before {
		t.Fatalf("missing resumed path requested get_entries: %d -> %d", before, got)
	}
}

func TestHistoryCorruptStreamThenDisappearanceSurfacesOpenErrorWithoutRootFetch(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 32)
	chat := testChat{id: "enoent-corrupt", cwd: t.TempDir()}
	live := newRecorder(32)
	sess, _, detach := acquire(t, mgr, chat, live)
	defer detach()
	if ready := live.next(t); ready.Kind != FrameReady {
		t.Fatalf("initial frame = %+v, want ready", ready)
	}

	// A file that opens but fails to decode still proves the path existed.
	path := sess.SessionFile()
	if err := os.WriteFile(path, []byte("not a session header\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	corrupt := newRecorder(16)
	_, started, corruptDetach := acquire(t, mgr, chat, corrupt)
	if started {
		t.Fatal("corrupt attachment unexpectedly opened a new session")
	}
	corrupt.awaitError(t, "decode_failed")
	corruptDetach()

	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	before := d.RequestCount(omorpc.CmdGetEntries)
	missing := newRecorder(16)
	_, started, missingDetach := acquire(t, mgr, chat, missing)
	defer missingDetach()
	if started {
		t.Fatal("missing-file attachment unexpectedly opened a new session")
	}
	prior, frame := missing.awaitError(t, "decode_failed")
	for _, got := range prior {
		if got.Kind == FrameEntries {
			t.Fatalf("post-corruption disappearance produced an entries page: %+v", got)
		}
	}
	info := frame.Data.(ErrorInfo)
	if !strings.Contains(info.Message, path) {
		t.Fatalf("history error = %q, want missing path %q", info.Message, path)
	}
	if got := d.RequestCount(omorpc.CmdGetEntries); got != before {
		t.Fatalf("post-corruption disappearance requested get_entries: %d -> %d", before, got)
	}
}

func TestHistoryMissingPreviouslyObservedSessionFileSurfacesOpenErrorWithoutRootFetch(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 32)
	chat := testChat{id: "enoent-observed", cwd: t.TempDir()}
	live := newRecorder(32)
	sess, _, detach := acquire(t, mgr, chat, live)
	defer detach()
	if ready := live.next(t); ready.Kind != FrameReady {
		t.Fatalf("initial frame = %+v, want ready", ready)
	}

	d.SetPromptScript(sess.SessionFile(), map[string]any{"type": omorpctest.EventAgentSettled})
	if err := sess.SendPrompt(context.Background(), "first message", nil); err != nil {
		t.Fatal(err)
	}
	live.await(t, FrameRunDone)

	history := newRecorder(32)
	_, started, historyDetach := acquire(t, mgr, chat, history)
	if started {
		t.Fatal("history attachment unexpectedly opened a new session")
	}
	pages := collectHydrationPages(t, sess, history)
	assertSingleTerminalHistory(t, pages, 1)
	historyDetach()

	path := sess.SessionFile()
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	before := d.RequestCount(omorpc.CmdGetEntries)
	missing := newRecorder(16)
	_, started, missingDetach := acquire(t, mgr, chat, missing)
	defer missingDetach()
	if started {
		t.Fatal("missing-file attachment unexpectedly opened a new session")
	}
	prior, frame := missing.awaitError(t, "decode_failed")
	for _, got := range prior {
		if got.Kind == FrameEntries {
			t.Fatalf("previously observed missing path produced an entries page: %+v", got)
		}
	}
	info := frame.Data.(ErrorInfo)
	if !strings.Contains(info.Message, path) {
		t.Fatalf("history error = %q, want missing path %q", info.Message, path)
	}
	if got := d.RequestCount(omorpc.CmdGetEntries); got != before {
		t.Fatalf("previously observed missing path requested get_entries: %d -> %d", before, got)
	}
}

func TestHistoryInPlaceFileRemovedBeforeOpenQuarantines(t *testing.T) {
	cwd := t.TempDir()
	path, _ := writeHistorySessionAt(t, filepath.Join(cwd, "removed-before-open.jsonl"), "durable-removed-before-open", 1, 0)
	d := newDaemon(t)
	if err := d.LoadSessionFile(path); err != nil {
		t.Fatal(err)
	}
	store := newMemStore()
	store.cursors["enoent-in-place"] = Cursor{SessionFile: path, DurableSessionID: "durable-removed-before-open", InPlace: true}
	mgr := testManager(t, dial(t, d), store, 16)
	sess, _, detach := acquire(t, mgr, testChat{id: "enoent-in-place", cwd: cwd}, nil)
	defer detach()

	originalStream := streamSessionHistory
	streamSessionHistory = func(ctx context.Context, sessionPath string, options coldhistory.Options, emit func(coldhistory.Metadata, coldhistory.Page) error) (coldhistory.Metadata, error) {
		if err := os.Remove(sessionPath); err != nil {
			return coldhistory.Metadata{}, err
		}
		return originalStream(ctx, sessionPath, options, emit)
	}
	t.Cleanup(func() { streamSessionHistory = originalStream })

	before := d.RequestCount(omorpc.CmdGetEntries)
	sub := newRecorder(16)
	subDetach, target, err := sess.attachCheckedReplayTarget(sub)
	if err != nil {
		t.Fatal(err)
	}
	defer subDetach()
	sess.hydrateEntries(context.Background(), path, target)
	prior, frame := sub.awaitError(t, "external-write-detected")
	for _, got := range prior {
		if got.Kind == FrameEntries {
			t.Fatalf("removed in-place path produced an entries page: %+v", got)
		}
	}
	if info := frame.Data.(ErrorInfo); info.Code != "external-write-detected" {
		t.Fatalf("error frame = %+v", info)
	}
	if got := d.RequestCount(omorpc.CmdGetEntries); got != before {
		t.Fatalf("removed in-place path requested get_entries: %d -> %d", before, got)
	}
	sess.lifecycleMu.Lock()
	quarantined := sess.quarantineErr
	sess.lifecycleMu.Unlock()
	if quarantined == nil || !errors.Is(quarantined, os.ErrNotExist) {
		t.Fatalf("route error = %T %v, want missing-file external write", quarantined, quarantined)
	}
}

func TestHistoryRetainedDiskCursorUnretainedByDaemonStillIncomplete(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 16)
	sess, _, detach := acquire(t, mgr, testChat{id: "retained-unretained", cwd: t.TempDir()}, nil)
	defer detach()

	path, leaf := writeHistorySessionAt(t, filepath.Join(t.TempDir(), "retained.jsonl"), sess.ID(), 2, 0)
	before := d.RequestCount(omorpc.CmdGetEntries)
	sub := newRecorder(16)
	subDetach, target, err := sess.attachCheckedReplayTarget(sub)
	if err != nil {
		t.Fatal(err)
	}
	defer subDetach()
	sess.hydrateEntries(context.Background(), path, target)
	if got := d.RequestCount(omorpc.CmdGetEntries); got != before+1 {
		t.Fatalf("get_entries request count = %d, want %d", got, before+1)
	}
	if request := d.LastRequest(omorpc.CmdGetEntries); request["since"] != leaf {
		t.Fatalf("get_entries since = %#v, want %q", request["since"], leaf)
	}
	prior, _ := sub.awaitError(t, "incomplete_history")
	for _, got := range prior {
		if got.Kind == FrameEntries && got.Data.(EntriesFrame).Final {
			t.Fatalf("unretained cursor produced a terminal page: %+v", got)
		}
	}
}
