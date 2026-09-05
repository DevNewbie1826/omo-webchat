package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/DevNewbie1826/omo-webchat/internal/coldhistory"
	"os"
	"path/filepath"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func TestTransparentIdleRecoverySavedNoFallback(t *testing.T) {
	for _, failure := range []string{"open", "identity"} {
		t.Run(failure, func(t *testing.T) {
			d := newDaemon(t)
			client := dial(t, d)
			store := newMemStore()
			mgr := testManager(t, client, store, 64)
			chat := testChat{id: "saved-no-fallback", cwd: t.TempDir()}
			original, _, detach := acquire(t, mgr, chat, nil)
			defer detach()
			cur := store.stored(chat.id)
			d.EvictSessionSilently(cur.SessionFile)
			if _, err := original.QueryState(context.Background()); !errors.Is(err, ErrSessionResumable) {
				t.Fatalf("loss=%v", err)
			}
			if failure == "open" {
				d.FailOpenPath(cur.SessionFile, omorpc.ErrCodeSessionPathInUse, 3)
			} else {
				d.OverrideNextOpenIdentity("wrong-identity")
			}
			before := len(d.Requests())
			got, _, cleanup, err := mgr.AcquireInitializedCheckedAndRunRecovering(context.Background(), chat, nil, nil, nil, nil)
			if cleanup != nil {
				defer cleanup()
			}
			if err == nil || got != nil {
				t.Fatalf("saved recovery silently created route: session=%v err=%v", got, err)
			}
			var resume *ResumeError
			if !errors.As(err, &resume) || resume.Info.Code != "resume_failed" {
				t.Fatalf("failure=%T %v", err, err)
			}
			for _, r := range d.Requests()[before:] {
				if r["type"] == omorpc.CmdOpenSession && (r["sessionPath"] != cur.SessionFile || r["cwd"] != chat.cwd) {
					t.Fatalf("changed original path/cwd: %v", r)
				}
			}
			if got := store.stored(chat.id); got != cur {
				t.Fatalf("cursor changed: %+v", got)
			}
		})
	}
}

func newValidatedHistorySession(t *testing.T, id string, queueSize int) (*Session, string) {
	t.Helper()
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	path, _ := writeHistorySession(t, entriesPageMaxCount*2+1, 0)
	if err := d.LoadSessionFile(path); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveCursor(context.Background(), id, Cursor{SessionFile: path}); err != nil {
		t.Fatal(err)
	}
	mgr := testManager(t, client, store, queueSize)
	sess, _, _ := acquire(t, mgr, testChat{id: id, cwd: filepath.Dir(path)}, nil)
	return sess, path
}

func TestTransparentIdleRecoveryTailOutcome(t *testing.T) {
	s := &Session{}
	want := ErrSessionResumable
	// A terminal emission failure must be observable by the acquisition owner.
	// Exercise the shipping hydrator with a valid root response and a bound callback
	// that loses the route immediately before tail emission.
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 16)
	s, _, _ = acquire(t, mgr, testChat{id: "tail-outcome", cwd: t.TempDir()}, nil)
	if err := os.Remove(s.SessionFile()); err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
	err := s.hydrateEntriesValidated(context.Background(), s.SessionFile(), nil, func() error { s.lifecycleMu.Lock(); s.resumable = true; s.lifecycleMu.Unlock(); return nil })
	if !errors.Is(err, want) {
		t.Fatalf("tail outcome=%v, want %v", err, want)
	}
}

type resetHistoryRecorder struct {
	*recorder
	resets int
}

func (r *resetHistoryRecorder) DiscardHydrationAttempt() { r.drain(); r.resets++ }

func TestTransparentIdleRecoveryEmissionBarriers(t *testing.T) {
	for _, boundary := range []string{"disk", "tail", "exhausted"} {
		t.Run(boundary, func(t *testing.T) {
			d := newDaemon(t)
			client := dial(t, d)
			store := newMemStore()
			const count = entriesPageMaxCount*2 + 1
			path, _ := writeHistorySession(t, count, 0)
			if err := d.LoadSessionFile(path); err != nil {
				t.Fatal(err)
			}
			if err := store.SaveCursor(context.Background(), boundary, Cursor{SessionFile: path}); err != nil {
				t.Fatal(err)
			}
			mgr := testManager(t, client, store, 1)
			chat := testChat{id: boundary, cwd: filepath.Dir(path)}
			original, _, _ := acquire(t, mgr, chat, nil)
			before := d.OpenCount()
			sub := &resetHistoryRecorder{recorder: newRecorder(1024)}
			var current *Session
			validations, losses := 0, 0
			lose := func() {
				if validations == 0 || current == nil {
					t.Fatal("emission reached before binding validation")
				}
				d.EvictSessionSilently(path)
				if _, err := current.QueryState(context.Background()); !errors.Is(err, ErrSessionResumable) {
					t.Fatalf("barrier loss=%v", err)
				}
				losses++
			}
			originalStream := streamSessionHistory
			streamSessionHistory = func(ctx context.Context, path string, opts coldhistory.Options, emit func(coldhistory.Metadata, coldhistory.Page) error) (coldhistory.Metadata, error) {
				failed := false
				metadata, err := originalStream(ctx, path, opts, func(m coldhistory.Metadata, p coldhistory.Page) error {
					if err := emit(m, p); err != nil {
						return err
					}
					if !failed && (losses == 0 || boundary == "exhausted") && boundary != "tail" {
						failed = true
						lose()
					}
					return nil
				})
				if err == nil && boundary == "tail" && losses == 0 {
					lose()
				}
				return metadata, err
			}
			defer func() { streamSessionHistory = originalStream }()
			got, _, detach, err := mgr.AcquireInitializedCheckedAndRunRecovering(context.Background(), chat, sub, func(s *Session, _ bool, _ func()) { current = s }, nil, func(*Session) error { validations++; return nil })
			if detach != nil {
				defer detach()
			}
			if boundary == "exhausted" {
				if !errors.Is(err, ErrSessionResumable) || validations != 2 || losses != 2 {
					t.Fatalf("exhaustion err=%v validations=%d losses=%d", err, validations, losses)
				}
				if d.OpenCount()-before != 1 {
					t.Fatalf("unbounded opens=%d", d.OpenCount()-before)
				}
				for _, f := range sub.drain() {
					if f.Kind == FrameEntries && f.Data.(EntriesFrame).Final {
						t.Fatal("failed generation published terminal")
					}
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got == original || got.ID() != original.ID() || got.SessionFile() != path || d.OpenCount()-before != 1 || sub.resets != 1 || validations != 2 {
				t.Fatalf("retry identity/budget/reset failed: opens=%d resets=%d validations=%d", d.OpenCount()-before, sub.resets, validations)
			}
			pages := collectHydrationPages(t, got, sub.recorder)
			assertSingleTerminalHistory(t, pages, count)
			i := 0
			for _, page := range pages {
				for _, raw := range page.Entries {
					var e struct {
						ID string `json:"id"`
					}
					if err := json.Unmarshal(raw, &e); err != nil {
						t.Fatal(err)
					}
					if e.ID != fmt.Sprintf("entry-%04d", i) {
						t.Fatalf("entry[%d]=%s", i, e.ID)
					}
					i++
				}
			}
			// An ordinary live publication after the terminal must remain usable.
			got.lifecycleMu.Lock()
			got.publishLocked(Frame{Kind: FrameState, SessionID: got.ID()})
			got.lifecycleMu.Unlock()
			sub.await(t, FrameState)
		})
	}
}
