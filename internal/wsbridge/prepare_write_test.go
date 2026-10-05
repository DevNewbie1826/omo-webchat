package wsbridge

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
)

func TestPrepareWriteMissingFileRequiresForcedOpen(t *testing.T) {
	store, err := cursorstore.Open(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "missing.jsonl")
	if err := store.SaveWorkspace(cursorstore.Workspace{ID: "ws", Path: filepath.Dir(path)}); err != nil {
		t.Fatal(err)
	}
	chat := cursorstore.Chat{ID: "forced", WorkspaceID: "ws", CWD: filepath.Dir(path), SessionFile: path, DurableSessionID: "durable", SessionProvenance: cursorstore.SessionProvenanceInPlace}
	if err := store.SaveChat(chat); err != nil {
		t.Fatal(err)
	}
	adapter := (*CursorStore)(store)
	if err := adapter.PrepareWrite(t.Context(), chat.ID); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("plain missing snapshot=%v", err)
	}
	AuthorizeInPlaceOpen(store, chat.ID, true, func(context.Context, string, time.Duration) (SessionActivity, error) {
		return SessionActivity{}, os.ErrNotExist
	})
	cur, err := adapter.CursorForOpen(t.Context(), chat.ID)
	if err != nil || !cur.InPlace {
		t.Fatalf("forced missing cursor=%+v err=%v", cur, err)
	}
	if _, err := adapter.CursorForOpen(t.Context(), chat.ID); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("one-shot reopen=%v", err)
	}
}
