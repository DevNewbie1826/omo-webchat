package api

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/auth"
	"github.com/DevNewbie1826/omo-webchat/internal/config"
	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/sendqueue"
	"github.com/DevNewbie1826/omo-webchat/internal/wsbridge"
)

type testMetadataStore struct{ *cursorstore.Store }

func (s *testMetadataStore) NewChat(wsID, name, cwd, _, _ string) (cursorstore.Chat, error) {
	id, err := newID("chat-")
	if err != nil {
		return cursorstore.Chat{}, err
	}
	c := cursorstore.Chat{ID: id, WorkspaceID: wsID, CWD: cwd, Name: name, NameSource: cursorstore.NameSourceAuto, CreatedAt: time.Now().UnixMilli()}
	err = s.SaveChat(c)
	return c, err
}
func newChatCreateTestServer(t *testing.T) (*Server, *testMetadataStore, cursorstore.Workspace) {
	t.Helper()
	root := t.TempDir()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	st, err := cursorstore.Open(filepath.Join(t.TempDir(), "state-v2.json"))
	if err != nil {
		t.Fatal(err)
	}
	ws := cursorstore.Workspace{ID: "ws-test", Name: "test", Path: root}
	if err = st.SaveWorkspace(ws); err != nil {
		t.Fatal(err)
	}
	sessions := auth.NewSessionStore(t.Context(), "pw", logger)
	server := New(context.Background(), &config.Config{Root: root}, st, sessions, nil, wsbridge.Unavailable("test"), logger)
	return server, &testMetadataStore{st}, ws
}
func TestDeleteChatRemovesOwnedQueueFromDisk(t *testing.T) {
	server, store, ws := newChatCreateTestServer(t)
	chat := cursorstore.Chat{ID: "chat-delete-queue", WorkspaceID: ws.ID, CWD: ws.Path, Name: "delete"}
	if err := store.SaveChat(chat); err != nil {
		t.Fatal(err)
	}
	queuePath := filepath.Join(t.TempDir(), "queue-v1.json")
	queue, err := sendqueue.Load(queuePath)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := queue.Append(chat.ID, sendqueue.Item{Text: "unsent", Images: []map[string]string{{"data": "image"}}}); err != nil {
		t.Fatal(err)
	}
	server.queue = queue

	req := httptest.NewRequest(http.MethodDelete, "/api/workspaces/"+ws.ID+"/chats/"+chat.ID, nil)
	req.SetPathValue("wsId", ws.ID)
	req.SetPathValue("chatId", chat.ID)
	rec := httptest.NewRecorder()
	server.handleDeleteChat(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete status = %d, body = %s", rec.Code, rec.Body.String())
	}
	restarted, err := sendqueue.Load(queuePath)
	if err != nil {
		t.Fatal(err)
	}
	if got := restarted.Snapshot(chat.ID); got.Dispatching != nil || len(got.Items) != 0 {
		t.Fatalf("chat queue survived deletion: %+v", got)
	}
}

func TestProviderListIsDaemonBackedOmoOnly(t *testing.T) {
	s, _, _ := newChatCreateTestServer(t)
	req, rec := httptest.NewRequest(http.MethodGet, "/api/providers", nil), httptest.NewRecorder()
	s.handleListProviders(rec, req)
	if rec.Code != http.StatusOK || rec.Body.String() != "[{\"id\":\"omo\",\"label\":\"Omo\",\"binary\":\"omo\",\"available\":true}]\n" {
		t.Fatalf("providers: %d %s", rec.Code, rec.Body.String())
	}
}
