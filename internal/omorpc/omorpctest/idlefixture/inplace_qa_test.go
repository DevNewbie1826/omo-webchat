package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
	"github.com/DevNewbie1826/omo-webchat/internal/wsbridge"
)

type qaChat struct{ id, cwd string }

func (c qaChat) ChatID() string { return c.id }
func (c qaChat) CWD() string    { return c.cwd }

type qaFrames struct {
	mu     sync.Mutex
	frames []session.Frame
}

func (f *qaFrames) SynchronousAttach() {}
func (f *qaFrames) Deliver(frame session.Frame) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.frames = append(f.frames, frame)
}
func (f *qaFrames) Cancel() error { return nil }
func (f *qaFrames) assertHistory(t *testing.T, entries, finals, errors int) {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	n, ends, failures := 0, 0, 0
	for _, frame := range f.frames {
		switch frame.Kind {
		case session.FrameEntries:
			p := frame.Data.(session.EntriesFrame)
			n += len(p.Entries)
			if p.Final {
				ends++
			}
		case session.FrameError:
			failures++
			if frame.Data.(session.ErrorInfo).Code != "external-write-detected" {
				t.Fatalf("unexpected error: %+v", frame)
			}
		}
	}
	if n != entries || ends != finals || failures != errors {
		t.Fatalf("entries/finals/errors=%d/%d/%d want %d/%d/%d", n, ends, failures, entries, finals, errors)
	}
}

func TestOwnedInPlaceQABootstrapAndNoPagesMutation(t *testing.T) {
	f := startFixture(t)
	dir := t.TempDir()
	path := filepath.Join(dir, "r4-owned.jsonl")
	sum := sha256.Sum256([]byte(path))
	id := "durable-" + hex.EncodeToString(sum[:4]) + "-7d24-4b1e-resume"
	header, err := json.Marshal(map[string]any{"type": "session", "id": id, "version": 3, "timestamp": "2026-09-02T00:00:00Z", "cwd": dir})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(header, '\n'), 0600); err != nil {
		t.Fatal(err)
	}
	store, err := cursorstore.Open(filepath.Join(dir, "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SaveWorkspace(cursorstore.Workspace{ID: "ws", Path: dir, Name: "QA"}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveChat(cursorstore.Chat{ID: "r4", WorkspaceID: "ws", CWD: dir, SessionFile: path, DurableSessionID: id, SessionProvenance: cursorstore.SessionProvenanceInPlace}); err != nil {
		t.Fatal(err)
	}
	mgr := session.NewManager(session.Config{Client: f.lead, Store: (*wsbridge.CursorStore)(store)})
	t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })
	chat := qaChat{id: "r4", cwd: dir}
	initial := &qaFrames{}
	_, _, detach, err := mgr.Acquire(context.Background(), chat, initial)
	if err != nil {
		t.Fatal(err)
	}
	defer detach()
	// Header-only bootstrap cannot claim complete history and is quarantined.
	initial.assertHistory(t, 0, 0, 1)
	f.seedHistory(path, 3)
	baseline := &qaFrames{}
	_, _, detachBaseline, err := mgr.AcquireInitializedWithRecovery(context.Background(), chat, baseline, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer detachBaseline()
	baseline.assertHistory(t, 3, 1, 0)
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	replacement := path + ".replacement"
	if err := os.WriteFile(replacement, body, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(replacement, path); err != nil {
		t.Fatal(err)
	}
	resync := &qaFrames{}
	_, _, detachResync, err := mgr.Acquire(context.Background(), chat, resync)
	if err != nil {
		t.Fatal(err)
	}
	defer detachResync()
	resync.assertHistory(t, 0, 0, 1)
}
