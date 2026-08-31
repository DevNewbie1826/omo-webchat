package store

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestFailedPersistenceLeavesMemoryAndDiskUnchanged(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Store, string) error
	}{
		{
			name: "create workspace",
			mutate: func(st *Store, _ string) error {
				_, err := st.CreateWorkspace("new", "/tmp/new")
				return err
			},
		},
		{
			name: "delete workspace",
			mutate: func(st *Store, wsID string) error {
				_, err := st.DeleteWorkspace(wsID)
				return err
			},
		},
		{
			name: "rename workspace",
			mutate: func(st *Store, wsID string) error {
				_, err := st.RenameWorkspace(wsID, "renamed")
				return err
			},
		},
		{
			name: "set layout",
			mutate: func(st *Store, _ string) error {
				return st.SetLayout(json.RawMessage(`{"changed":true}`))
			},
		},
		{
			name: "add chat",
			mutate: func(st *Store, wsID string) error {
				return st.AddChat(wsID, Chat{ID: "chat-new", Name: "new", WsID: wsID, Provider: "omo"})
			},
		},
		{
			name: "update chat",
			mutate: func(st *Store, wsID string) error {
				_, err := st.UpdateChat(wsID, "chat-1", func(c *Chat) { c.Name = "updated" })
				return err
			},
		},
		{
			name: "remove chat",
			mutate: func(st *Store, wsID string) error {
				_, err := st.RemoveChat(wsID, "chat-1")
				return err
			},
		},
		{
			name: "new chat",
			mutate: func(st *Store, wsID string) error {
				_, err := st.NewChat(wsID, "generated", "/tmp/original", "", "omo")
				return err
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			st, path, wsID := newPersistFailureStore(t)
			beforeMemory := st.ListWorkspaces()
			beforeLayout := st.GetLayout()
			beforeDisk, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("read state before failed write: %v", err)
			}

			// flushLocked writes this path before renaming it over state.json.
			// Making it a directory forces WriteFile to fail without relying on
			// platform permissions and leaves the existing state file untouched.
			if err := os.Mkdir(path+".tmp", 0o700); err != nil {
				t.Fatalf("block temporary state destination: %v", err)
			}

			if err := tt.mutate(st, wsID); err == nil {
				t.Fatal("mutation succeeded with an invalid persistence destination")
			}
			if got := st.ListWorkspaces(); !reflect.DeepEqual(got, beforeMemory) {
				t.Fatalf("in-memory workspaces changed after failed persist:\n got: %#v\nwant: %#v", got, beforeMemory)
			}
			if got := st.GetLayout(); !bytes.Equal(got, beforeLayout) {
				t.Fatalf("in-memory layout changed after failed persist: got %s, want %s", got, beforeLayout)
			}
			afterDisk, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("read state after failed write: %v", err)
			}
			if !bytes.Equal(afterDisk, beforeDisk) {
				t.Fatalf("state file changed after failed persist:\n got: %s\nwant: %s", afterDisk, beforeDisk)
			}
		})
	}
}

func newPersistFailureStore(t *testing.T) (*Store, string, string) {
	t.Helper()
	dir := t.TempDir()
	st, err := LoadDir(dir, discardLogger())
	if err != nil {
		t.Fatalf("load store: %v", err)
	}
	ws, err := st.CreateWorkspace("original", "/tmp/original")
	if err != nil {
		t.Fatalf("seed workspace: %v", err)
	}
	if err := st.AddChat(ws.ID, Chat{
		ID: "chat-1", Name: "original", WsID: ws.ID, Cwd: "/tmp/original", Provider: "omo", CreatedAt: 1,
	}); err != nil {
		t.Fatalf("seed chat: %v", err)
	}
	if err := st.SetLayout(json.RawMessage(`{"original":true}`)); err != nil {
		t.Fatalf("seed layout: %v", err)
	}
	return st, filepath.Join(dir, "state.json"), ws.ID
}
