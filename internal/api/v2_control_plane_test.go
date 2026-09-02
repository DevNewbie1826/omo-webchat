package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/auth"
	"github.com/DevNewbie1826/omo-webchat/internal/config"
	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
	v2session "github.com/DevNewbie1826/omo-webchat/internal/session"
	"github.com/DevNewbie1826/omo-webchat/internal/store"
	"github.com/DevNewbie1826/omo-webchat/internal/wsbridge"
)

type v2ControlEnv struct {
	server  *Server
	manager *v2session.Manager
	cursors *cursorstore.Store
	daemon  *omorpctest.Daemon
	wsID    string
	chatID  string
}

type v2ControlRef struct{ id, cwd string }

func (r v2ControlRef) ChatID() string { return r.id }
func (r v2ControlRef) CWD() string    { return r.cwd }

func newV2ControlEnv(t *testing.T) *v2ControlEnv {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	st, err := store.Load(t.Context(), logger)
	if err != nil {
		t.Fatal(err)
	}
	workspace, err := st.CreateWorkspace("workspace", dir)
	if err != nil {
		t.Fatal(err)
	}
	chat, err := st.NewChat(workspace.ID, "chat", dir, "", "omo")
	if err != nil {
		t.Fatal(err)
	}
	cursors, err := cursorstore.Open(filepath.Join(dir, "v2.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := cursors.SaveWorkspace(cursorstore.Workspace{ID: workspace.ID, Name: workspace.Name, Path: workspace.Path}); err != nil {
		t.Fatal(err)
	}
	if err := cursors.SaveChat(cursorstore.Chat{ID: chat.ID, WorkspaceID: workspace.ID, CWD: dir, Name: chat.Name, NameSource: cursorstore.NameSourceAuto}); err != nil {
		t.Fatal(err)
	}
	daemonDir, err := os.MkdirTemp("", "v2api-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(daemonDir) })
	d := omorpctest.New(daemonDir)
	if err := d.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(d.Stop)
	client, err := omorpc.Dial(t.Context(), d.SocketPath())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	manager := v2session.NewManager(v2session.Config{Client: client, Store: (*wsbridge.CursorStore)(cursors)})
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = manager.CloseAll(ctx)
	})
	if _, _, _, err := manager.Acquire(t.Context(), v2ControlRef{chat.ID, dir}, nil); err != nil {
		t.Fatal(err)
	}
	server := New(t.Context(), &config.Config{Root: dir}, st, auth.NewSessionStore(t.Context(), "pw", logger), logger)
	server.installV2(manager, cursors, http.NotFoundHandler())
	return &v2ControlEnv{server: server, manager: manager, cursors: cursors, daemon: d, wsID: workspace.ID, chatID: chat.ID}
}

func TestV2ControlPlaneRoutes(t *testing.T) {
	t.Run("live listing", func(t *testing.T) {
		e := newV2ControlEnv(t)
		rec := httptest.NewRecorder()
		e.server.handleListLiveSessions(rec, httptest.NewRequest(http.MethodGet, "/api/sessions/live", nil))
		var body liveSessionsResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if len(body.Sessions) != 1 || body.Sessions[0].ID != e.chatID || body.Sessions[0].Title != "chat" {
			t.Fatalf("v2 live sessions = %+v", body.Sessions)
		}
	})

	t.Run("rename", func(t *testing.T) {
		e := newV2ControlEnv(t)
		req := httptest.NewRequest(http.MethodPatch, "/", bytes.NewBufferString(`{"name":"renamed"}`))
		req.SetPathValue("wsId", e.wsID)
		req.SetPathValue("chatId", e.chatID)
		rec := httptest.NewRecorder()
		e.server.handleRenameChat(rec, req)
		if rec.Code != http.StatusOK || !e.daemon.AwaitRequestCount(omorpc.CmdSetSessionName, 1, time.Second) {
			t.Fatalf("rename status=%d provider requests=%d", rec.Code, e.daemon.RequestCount(omorpc.CmdSetSessionName))
		}
		chat, err := e.cursors.GetChat(e.chatID)
		if err != nil || chat.Name != "renamed" || chat.NameSource != cursorstore.NameSourceUser {
			t.Fatalf("v2 cursor after rename = %+v, %v", chat, err)
		}
	})

	t.Run("chat delete", func(t *testing.T) {
		e := newV2ControlEnv(t)
		req := httptest.NewRequest(http.MethodDelete, "/", nil)
		req.SetPathValue("wsId", e.wsID)
		req.SetPathValue("chatId", e.chatID)
		rec := httptest.NewRecorder()
		e.server.handleDeleteChat(rec, req)
		if rec.Code != http.StatusNoContent {
			t.Fatalf("delete status=%d: %s", rec.Code, rec.Body.String())
		}
		if _, active := e.manager.Get(e.chatID); active {
			t.Fatal("v2 session remains active")
		}
		if _, err := e.cursors.GetChat(e.chatID); !errors.Is(err, cursorstore.ErrNotFound) {
			t.Fatalf("v2 cursor lookup after delete = %v", err)
		}
	})

	t.Run("workspace delete", func(t *testing.T) {
		e := newV2ControlEnv(t)
		req := httptest.NewRequest(http.MethodDelete, "/", nil)
		req.SetPathValue("wsId", e.wsID)
		rec := httptest.NewRecorder()
		e.server.handleDeleteWorkspace(rec, req)
		if rec.Code != http.StatusNoContent {
			t.Fatalf("delete status=%d: %s", rec.Code, rec.Body.String())
		}
		if _, active := e.manager.Get(e.chatID); active {
			t.Fatal("workspace delete left v2 session active")
		}
		if len(e.cursors.ListWorkspaces()) != 0 {
			t.Fatalf("v2 workspaces remain: %+v", e.cursors.ListWorkspaces())
		}
	})
}
