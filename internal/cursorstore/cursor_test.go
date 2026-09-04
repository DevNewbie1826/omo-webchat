package cursorstore

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"
)

func testChat(id, wsID string) Chat {
	return Chat{
		ID:          id,
		WorkspaceID: wsID,
		CWD:         "/tmp/proj",
		SessionFile: "/tmp/proj/.omo/sessions/s_abc.jsonl",
		Name:        "proj chat",
		NameSource:  "auto",
		CreatedAt:   1700000000000,
	}
}

func testWorkspace(id string) Workspace {
	return Workspace{ID: id, Name: "ws-" + id, Path: "/tmp/" + id}
}

type testClock struct{ now time.Time }

func (c *testClock) Now() time.Time { return c.now }

func mustOpen(t *testing.T, path string) *Store {
	t.Helper()
	s, err := Open(path)
	if err != nil {
		t.Fatalf("Open(%q): %v", path, err)
	}
	return s
}

// TestOpenAbsentFile: loading a nonexistent file yields an empty store, no error.
func TestOpenAbsentFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	s := mustOpen(t, path)
	if ws := s.ListWorkspaces(); len(ws) != 0 {
		t.Fatalf("expected no workspaces, got %d", len(ws))
	}
	if layout := s.GetLayout(); layout != nil {
		t.Fatalf("expected nil layout, got %s", layout)
	}
	if _, err := s.GetChat("missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

// TestMutationRoundtrip table-drives every mutation and verifies it survives
// a full close/reopen cycle (persistence through the atomic writer).
func TestMutationRoundtrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")

	t.Run("SaveWorkspace+SaveChat+SetLayout", func(t *testing.T) {
		s := mustOpen(t, path)
		if err := s.SaveWorkspace(testWorkspace("ws1")); err != nil {
			t.Fatalf("SaveWorkspace: %v", err)
		}
		c := testChat("c1", "ws1")
		c.DurableSessionID = "dur-1"
		if err := s.SaveChat(c); err != nil {
			t.Fatalf("SaveChat: %v", err)
		}
		if err := s.SetLayout(json.RawMessage(`{"sidebar":true}`)); err != nil {
			t.Fatalf("SetLayout: %v", err)
		}
	})

	t.Run("reopen sees everything", func(t *testing.T) {
		s := mustOpen(t, path)
		wsList := s.ListWorkspaces()
		if len(wsList) != 1 || wsList[0].ID != "ws1" || wsList[0].Name != "ws-ws1" || wsList[0].Path != "/tmp/ws1" {
			t.Fatalf("workspace roundtrip mismatch: %+v", wsList)
		}
		c, err := s.GetChat("c1")
		if err != nil {
			t.Fatalf("GetChat: %v", err)
		}
		want := testChat("c1", "ws1")
		want.DurableSessionID = "dur-1"
		if c != want {
			t.Fatalf("chat roundtrip mismatch:\n got %+v\nwant %+v", c, want)
		}
		if !jsonEqual(s.GetLayout(), []byte(`{"sidebar":true}`)) {
			t.Fatalf("layout roundtrip mismatch: %s", s.GetLayout())
		}
	})

	t.Run("TouchLastUsed persists", func(t *testing.T) {
		clock := &testClock{now: time.UnixMilli(1800000000000)}
		s, err := OpenWithClock(path, clock)
		if err != nil {
			t.Fatalf("OpenWithClock: %v", err)
		}
		before, err := s.GetChat("c1")
		if err != nil {
			t.Fatalf("GetChat: %v", err)
		}
		clock.now = clock.now.Add(time.Millisecond)
		if err := s.TouchLastUsed("c1"); err != nil {
			t.Fatalf("TouchLastUsed: %v", err)
		}
		after, err := s.GetChat("c1")
		if err != nil {
			t.Fatalf("GetChat: %v", err)
		}
		if after.LastUsedAt <= before.LastUsedAt {
			t.Fatalf("LastUsedAt did not advance: %d -> %d", before.LastUsedAt, after.LastUsedAt)
		}
		if after.CreatedAt != before.CreatedAt || after.SessionFile != before.SessionFile {
			t.Fatalf("TouchLastUsed mutated other fields: %+v", after)
		}
	})

	t.Run("SaveChat update persists", func(t *testing.T) {
		s := mustOpen(t, path)
		c := testChat("c1", "ws1")
		c.Name = "renamed"
		c.NameSource = "user"
		c.DurableSessionID = "dur-2"
		if err := s.SaveChat(c); err != nil {
			t.Fatalf("SaveChat: %v", err)
		}
	})

	got, err := mustOpen(t, path).GetChat("c1")
	if err != nil {
		t.Fatalf("GetChat: %v", err)
	}
	if got.Name != "renamed" || got.NameSource != "user" || got.DurableSessionID != "dur-2" {
		t.Fatalf("chat update not persisted: %+v", got)
	}

	t.Run("DeleteChat persists", func(t *testing.T) {
		s := mustOpen(t, path)
		if err := s.DeleteChat("c1"); err != nil {
			t.Fatalf("DeleteChat: %v", err)
		}
	})

	s := mustOpen(t, path)
	if _, err := s.GetChat("c1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound after delete, got %v", err)
	}

	t.Run("DeleteWorkspace cascades chats and persists", func(t *testing.T) {
		s := mustOpen(t, path)
		if err := s.SaveChat(testChat("c2", "ws1")); err != nil {
			t.Fatalf("SaveChat: %v", err)
		}
		if err := s.DeleteWorkspace("ws1"); err != nil {
			t.Fatalf("DeleteWorkspace: %v", err)
		}
		if _, err := s.GetChat("c2"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("expected chat cascaded away, got %v", err)
		}
	})
	if ws := mustOpen(t, path).ListWorkspaces(); len(ws) != 0 {
		t.Fatalf("workspace delete not persisted: %+v", ws)
	}
}

// TestValidation: rejected mutations leave no trace in memory or on disk.
func TestValidation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	s := mustOpen(t, path)

	if err := s.SetLayout(json.RawMessage(`{invalid`)); !errors.Is(err, ErrInvalidLayout) {
		t.Fatalf("expected ErrInvalidLayout, got %v", err)
	}
	if layout := s.GetLayout(); layout != nil {
		t.Fatalf("failed SetLayout leaked state: %s", layout)
	}

	if err := s.SaveChat(testChat("c1", "ghost")); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound for unknown workspace, got %v", err)
	}
	if _, err := s.GetChat("c1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("failed SaveChat leaked state: %v", err)
	}

	bad := testChat("c1", "")
	bad.NameSource = "wizard"
	if err := s.SaveChat(bad); !errors.Is(err, ErrInvalidNameSource) {
		t.Fatalf("expected ErrInvalidNameSource, got %v", err)
	}

	if err := s.DeleteWorkspace("ghost"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
	if err := s.TouchLastUsed("ghost"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

// TestCorruptionPolicy: unreadable or invalid state files produce a typed
// error; the store never silently resets. A truncated final line is fatal.
func TestCorruptionPolicy(t *testing.T) {
	cases := []struct {
		name    string
		content string
	}{
		{"garbage", "not json at all"},
		{"truncated final line", `{"workspaces":[{"id":"ws1"}`},
		{"valid json wrong shape", `{"workspaces": "nope"}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "state.json")
			if err := os.WriteFile(path, []byte(tc.content), 0o600); err != nil {
				t.Fatal(err)
			}
			_, err := Open(path)
			if !errors.Is(err, ErrCorrupt) {
				t.Fatalf("expected ErrCorrupt, got %v", err)
			}
			// The bad file must be left untouched for diagnosis.
			raw, readErr := os.ReadFile(path)
			if readErr != nil || string(raw) != tc.content {
				t.Fatalf("corrupt file was modified: %v %q", readErr, raw)
			}
		})
	}
}

// TestAtomicityFailureLeavesNoPartialState: when a mutation's flush fails
// (simulating a process dying mid-write), neither the in-memory state nor
// the on-disk file shows partial application, and no temp litter remains.
func TestAtomicityFailureLeavesNoPartialState(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("permission-based fault injection is ineffective as root")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")

	s := mustOpen(t, path)
	if err := s.SaveWorkspace(testWorkspace("ws1")); err != nil {
		t.Fatalf("SaveWorkspace: %v", err)
	}
	if err := s.SaveChat(testChat("c1", "ws1")); err != nil {
		t.Fatalf("SaveChat: %v", err)
	}

	// Make the directory unwritable so the temp-file write of the next
	// flush fails after the in-memory candidate was prepared.
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(dir, 0o700) })

	if err := s.SaveChat(testChat("c2", "ws1")); !errors.Is(err, ErrPersistence) {
		t.Fatalf("expected typed ErrPersistence for unwritable dir, got %v", err)
	}

	// In-memory state unchanged: c2 invisible.
	if _, err := s.GetChat("c2"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("partial state visible in memory after failed flush: %v", err)
	}

	// On-disk state unchanged and no temp litter.
	os.Chmod(dir, 0o700)
	reopened := mustOpen(t, path)
	if _, err := reopened.GetChat("c2"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("partial state visible on disk after failed flush: %v", err)
	}
	if _, err := reopened.GetChat("c1"); err != nil {
		t.Fatalf("prior state lost after failed flush: %v", err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if e.Name() != "state.json" {
			t.Fatalf("temp litter left behind: %s", e.Name())
		}
	}
}

// TestFilePermissions: the persisted state file is 0600.
func TestFilePermissions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	s := mustOpen(t, path)
	if err := s.SaveWorkspace(testWorkspace("ws1")); err != nil {
		t.Fatalf("SaveWorkspace: %v", err)
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if perm := fi.Mode().Perm(); perm != 0o600 {
		t.Fatalf("state file mode = %o, want 600", perm)
	}
}

// TestCopiesAreDeep: returned values are snapshots; mutating them never
// reaches the store (cursor records must be immutable through the API).
func TestCopiesAreDeep(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	s := mustOpen(t, path)
	if err := s.SaveWorkspace(testWorkspace("ws1")); err != nil {
		t.Fatal(err)
	}
	if err := s.SaveChat(testChat("c1", "ws1")); err != nil {
		t.Fatal(err)
	}
	if err := s.SetLayout(json.RawMessage(`{"a":1}`)); err != nil {
		t.Fatal(err)
	}

	ws := s.ListWorkspaces()[0]
	ws.Name = "hacked"
	c, _ := s.GetChat("c1")
	c.SessionFile = "hacked"
	layout := s.GetLayout()
	// Stomp the returned buffer; the store's copy must not notice.
	if len(layout) > 0 {
		layout[0] = ' '
	}

	fresh := mustOpen(t, path)
	if got := fresh.ListWorkspaces()[0].Name; got != "ws-ws1" {
		t.Fatalf("workspace copy escaped into store: %s", got)
	}
	if got, _ := fresh.GetChat("c1"); got.SessionFile != testChat("c1", "ws1").SessionFile {
		t.Fatalf("chat copy escaped into store: %+v", got)
	}
	if !jsonEqual(fresh.GetLayout(), []byte(`{"a":1}`)) {
		t.Fatalf("layout copy escaped into store: %s", fresh.GetLayout())
	}
}

// jsonEqual compares two JSON documents semantically (MarshalIndent re-indents
// the RawMessage passthrough, so byte equality is not the contract).
func jsonEqual(a, b []byte) bool {
	var va, vb interface{}
	if json.Unmarshal(a, &va) != nil || json.Unmarshal(b, &vb) != nil {
		return false
	}
	return reflect.DeepEqual(va, vb)
}

func TestChatFieldMutationsSerializeReadModifyWrite(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	s := mustOpen(t, path)
	if err := s.SaveWorkspace(testWorkspace("ws1")); err != nil {
		t.Fatal(err)
	}
	if err := s.SaveChat(testChat("c1", "ws1")); err != nil {
		t.Fatal(err)
	}

	identityRead := make(chan struct{})
	releaseIdentity := make(chan struct{})
	identityDone := make(chan error, 1)
	go func() {
		identityDone <- s.updateChatFields("c1", func(c *Chat) error {
			close(identityRead)
			<-releaseIdentity
			c.SessionFile = "/new/session.jsonl"
			c.DurableSessionID = "durable-new"
			return nil
		})
	}()
	<-identityRead

	renameStarted := make(chan struct{})
	renameDone := make(chan error, 1)
	go func() {
		close(renameStarted)
		renameDone <- s.UpdateName("c1", "user rename", NameSourceUser)
	}()
	<-renameStarted
	close(releaseIdentity)
	if err := <-identityDone; err != nil {
		t.Fatalf("UpdateIdentity transaction: %v", err)
	}
	if err := <-renameDone; err != nil {
		t.Fatalf("UpdateName: %v", err)
	}

	got, err := mustOpen(t, path).GetChat("c1")
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "user rename" || got.NameSource != NameSourceUser {
		t.Fatalf("identity update restored stale name: %+v", got)
	}
	if got.SessionFile != "/new/session.jsonl" || got.DurableSessionID != "durable-new" {
		t.Fatalf("rename lost identity update: %+v", got)
	}
}

func TestSaveChatRecordsFreshSessionAsNative(t *testing.T) {
	s := mustOpen(t, filepath.Join(t.TempDir(), "state.json"))
	if err := s.SaveWorkspace(testWorkspace("ws1")); err != nil {
		t.Fatal(err)
	}
	chat := Chat{ID: "native", WorkspaceID: "ws1", CWD: "/work", Name: "fresh", NameSource: NameSourceAuto}
	if err := s.SaveChat(chat); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetChat(chat.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !IsNativeSession(got) {
		t.Fatalf("fresh chat provenance = %q, want %q", got.SessionProvenance, SessionProvenanceNative)
	}
}

func TestUpdateIdentityPreservesProvenance(t *testing.T) {
	for _, provenance := range []string{SessionProvenanceNative, SessionProvenanceAdopted, SessionProvenanceInPlace} {
		t.Run(provenance, func(t *testing.T) {
			s := mustOpen(t, filepath.Join(t.TempDir(), "state.json"))
			if err := s.SaveWorkspace(testWorkspace("ws1")); err != nil {
				t.Fatal(err)
			}
			chat := Chat{ID: "chat", WorkspaceID: "ws1", SessionFile: "/old/session.jsonl", DurableSessionID: "old", SessionProvenance: provenance}
			if err := s.SaveChat(chat); err != nil {
				t.Fatal(err)
			}
			if err := s.UpdateIdentity(chat.ID, "/new/session.jsonl", "new"); err != nil {
				t.Fatal(err)
			}
			got, err := s.GetChat(chat.ID)
			if err != nil {
				t.Fatal(err)
			}
			if got.SessionProvenance != provenance {
				t.Fatalf("provenance = %q, want %q", got.SessionProvenance, provenance)
			}
		})
	}
}

// TestConcurrentMutations: hammer every mutation path from parallel
// goroutines; the store must stay consistent and fully persisted.
func TestConcurrentMutations(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	s := mustOpen(t, path)
	if err := s.SaveWorkspace(Workspace{ID: "ws", Name: "w", Path: "/w"}); err != nil {
		t.Fatal(err)
	}

	const workers, chatsPerWorker = 8, 10
	var wg sync.WaitGroup
	errs := make(chan error, workers*3)
	start := make(chan struct{})
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			<-start
			for i := 0; i < chatsPerWorker; i++ {
				id := chatID(w, i)
				if err := s.SaveChat(testChat(id, "ws")); err != nil {
					errs <- err
					return
				}
				if err := s.TouchLastUsed(id); err != nil {
					errs <- err
					return
				}
				if err := s.SetLayout(json.RawMessage(`{"w":` + itoa(w) + `}`)); err != nil {
					errs <- err
					return
				}
			}
		}(w)
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent mutation failed: %v", err)
	}

	reopened := mustOpen(t, path)
	for w := 0; w < workers; w++ {
		for i := 0; i < chatsPerWorker; i++ {
			c, err := reopened.GetChat(chatID(w, i))
			if err != nil {
				t.Fatalf("chat %s lost after concurrent mutations: %v", chatID(w, i), err)
			}
			if c.LastUsedAt == 0 {
				t.Fatalf("chat %s missing LastUsedAt", chatID(w, i))
			}
		}
	}
}

func chatID(w, i int) string { return "c-" + itoa(w) + "-" + itoa(i) }

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}
