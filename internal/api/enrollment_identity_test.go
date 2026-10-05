package api

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/rpcwatch"
	"github.com/DevNewbie1826/omo-webchat/internal/wsbridge"
)

func TestEnrollmentIdentityCanonicalDurableAndEmptyNative(t *testing.T) {
	// Given: an existing workspace alias and an unopened native chat.
	s, store, caller, ws := enrollmentFixture(t)
	canonical, err := filepath.EvalSymlinks(ws.Path)
	if err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(t.TempDir(), "alias")
	if err := os.Symlink(canonical, alias); err != nil {
		t.Fatal(err)
	}
	ws.Path = alias
	if err := store.SaveWorkspace(ws); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveChat(cursorstore.Chat{ID: "native-empty", WorkspaceID: ws.ID, CWD: alias, Name: "Native"}); err != nil {
		t.Fatal(err)
	}
	live := observedEnrollment(ws, "durable-identity")
	live.Cwd = canonical
	live.SessionPath = filepath.Join(canonical, "first.jsonl")
	caller.sessions = []rpcwatch.Session{live}
	// When: the daemon session is discovered under the canonical directory.
	s.rpcWatcher.Tick(t.Context())
	// Then: reuse the alias workspace, but never the native empty identity.
	if got := store.ListWorkspaces(); len(got) != 1 {
		t.Fatalf("canonical workspace duplicated: %+v", got)
	}
	chats := store.ListChats(ws.ID)
	if len(chats) != 2 {
		t.Fatalf("empty native identity matched daemon: %+v", chats)
	}
	native, err := store.GetChat("native-empty")
	if err != nil || native.SessionFile != "" || native.DurableSessionID != "" || native.AutoEnrolled {
		t.Fatalf("native was rebound: %+v, %v", native, err)
	}
	var enrolled cursorstore.Chat
	for _, chat := range chats {
		if chat.AutoEnrolled {
			enrolled = chat
		}
	}
	// Same durable identity at a new path stays one chat and fills its title.
	caller.sessions[0].SessionPath = filepath.Join(canonical, "second.jsonl")
	caller.sessions[0].Name = "Daemon title"
	s.rpcWatcher.Tick(t.Context())
	updated, err := store.GetChat(enrolled.ID)
	if err != nil || updated.SessionFile != caller.sessions[0].SessionPath || updated.Name != "Daemon title" || updated.TitleIsPlaceholder || updated.NameSource != cursorstore.NameSourceAuto {
		t.Fatalf("durable rebind/title = %+v, %v", updated, err)
	}
	if chats := store.ListChats(ws.ID); len(chats) != 2 {
		t.Fatalf("same durable duplicated: %+v", chats)
	}
	if err := store.UpdateName(enrolled.ID, "User title", cursorstore.NameSourceUser); err != nil {
		t.Fatal(err)
	}
	caller.sessions[0].Name = "Other daemon title"
	s.rpcWatcher.Tick(t.Context())
	updated, _ = store.GetChat(enrolled.ID)
	if updated.Name != "User title" {
		t.Fatalf("user title overwritten: %+v", updated)
	}
	caller.sessions[0].DurableSessionID = "replacement-at-same-path"
	s.rpcWatcher.Tick(t.Context())
	if chats := store.ListChats(ws.ID); len(chats) != 3 {
		t.Fatalf("replacement identity merged into old row: %+v", chats)
	}
}

func TestEnrollmentIdentityMatchesCanonicalSessionFileWithoutDurable(t *testing.T) {
	s, store, caller, ws := enrollmentFixture(t)
	original := filepath.Join(ws.Path, "original.jsonl")
	if err := os.WriteFile(original, []byte("identity"), 0o600); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(ws.Path, "alias.jsonl")
	if err := os.Symlink(original, alias); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveChat(cursorstore.Chat{ID: "existing", WorkspaceID: ws.ID, CWD: ws.Path, SessionFile: alias, SessionProvenance: cursorstore.SessionProvenanceNative, Name: "Existing"}); err != nil {
		t.Fatal(err)
	}
	live := observedEnrollment(ws, "path-durable")
	live.SessionPath = original
	caller.sessions = []rpcwatch.Session{live}
	s.rpcWatcher.Tick(t.Context())
	if chats := store.ListChats(ws.ID); len(chats) != 1 || chats[0].ID != "existing" || chats[0].DurableSessionID != "path-durable" {
		t.Fatalf("canonical file did not match: %+v", chats)
	}
}

func TestEnrollmentOpenSkipsRESTAndCursorTakeoverActivity(t *testing.T) {
	s, store, caller, ws := enrollmentFixture(t)
	caller.sessions = []rpcwatch.Session{observedEnrollment(ws, "running-not-persisted")}
	s.rpcWatcher.Tick(t.Context())
	chat := store.ListChats(ws.ID)[0]
	s.activityCheck = func(context.Context, string, time.Duration) (sessionActivity, error) {
		t.Fatal("auto-enrolled REST open performed takeover activity check")
		return sessionActivity{}, nil
	}
	response := openWorkspaceSession(t, s, ws.ID, map[string]any{"id": chat.DurableSessionID, "resumeIdentity": chat.SessionFile})
	if response.Code != http.StatusOK {
		t.Fatalf("REST open = %d: %s", response.Code, response.Body.String())
	}
	wsbridge.AuthorizeInPlaceOpen(store, chat.ID, false, func(context.Context, string, time.Duration) (wsbridge.SessionActivity, error) {
		t.Fatal("auto-enrolled cursor performed takeover activity check")
		return wsbridge.SessionActivity{}, nil
	})
	cur, err := (*wsbridge.CursorStore)(store).CursorForOpen(t.Context(), chat.ID)
	if err != nil || !cur.AutoEnrolled || cur.SessionFile != chat.SessionFile {
		t.Fatalf("auto-enrolled cursor = %+v, %v", cur, err)
	}
}
