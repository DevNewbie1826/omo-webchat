package cursorstore

import (
	"errors"
	"path/filepath"
	"testing"
)

func TestWorkspaceRenameAndUpdateRoundTrip(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err = s.SaveWorkspace(Workspace{ID: "ws", Name: "before", Path: "/before"}); err != nil {
		t.Fatal(err)
	}
	renamed, err := s.RenameWorkspace("ws", "renamed")
	if err != nil || renamed.Name != "renamed" || renamed.Path != "/before" {
		t.Fatalf("rename=%+v err=%v", renamed, err)
	}
	updated, err := s.UpdateWorkspace(Workspace{ID: "ws", Name: "updated", Path: "/after"})
	if err != nil || updated.Path != "/after" {
		t.Fatalf("update=%+v err=%v", updated, err)
	}
	reopened, err := Open(s.path)
	if err != nil {
		t.Fatal(err)
	}
	got, err := reopened.GetWorkspace("ws")
	if err != nil || got != updated {
		t.Fatalf("got=%+v err=%v", got, err)
	}
	if _, err = s.RenameWorkspace("missing", "x"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("rename missing err=%v", err)
	}
	if _, err = s.UpdateWorkspace(Workspace{ID: "missing"}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("update missing err=%v", err)
	}
}
