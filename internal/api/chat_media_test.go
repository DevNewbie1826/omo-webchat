package api

// Engine-shaped end-to-end tests for the per-chat media endpoint:
// GET /api/workspaces/{wsId}/chats/{chatId}/media serves the inline image
// block an image_ref placeholder stands in for, fetched from the chat's
// engine session on demand.

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/auth"
	"github.com/DevNewbie1826/omo-webchat/internal/config"
	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
	"github.com/DevNewbie1826/omo-webchat/internal/wsbridge"
)

// mediaPNGBase64 is a 69-byte 1x1 red PNG. The endpoint test pins exact-byte
// delivery of the block the engine returns.
const mediaPNGBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"

func mediaPNGBytes(t *testing.T) []byte {
	t.Helper()
	raw, err := base64.StdEncoding.DecodeString(mediaPNGBase64)
	if err != nil {
		t.Fatalf("fixture PNG decode: %v", err)
	}
	return raw
}

type mediaHarness struct {
	server    *httptest.Server
	daemon    *omorpctest.Daemon
	store     *cursorstore.Store
	manager   *session.Manager
	workspace cursorstore.Workspace
	chat      cursorstore.Chat
	token     string
}

func newMediaHarness(t *testing.T) *mediaHarness {
	t.Helper()
	daemonDir, err := os.MkdirTemp("", "media-e2e-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(daemonDir) })
	daemon := omorpctest.New(daemonDir)
	if err := daemon.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(daemon.Stop)
	// Fast reconnect so an engine-down scenario resolves in milliseconds
	// instead of the production backoff schedule.
	client, err := omorpc.DialWithConfig(t.Context(), daemon.SocketPath(), omorpc.Config{
		EventBuffer:          256,
		ReconnectInitial:     time.Millisecond,
		ReconnectMax:         2 * time.Millisecond,
		ReconnectMaxAttempts: 2,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })

	root := t.TempDir()
	store, err := cursorstore.Open(filepath.Join(root, "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	workspace := cursorstore.Workspace{ID: "ws-media", Name: "Media", Path: root}
	if err := store.SaveWorkspace(workspace); err != nil {
		t.Fatal(err)
	}
	chat := cursorstore.Chat{ID: "chat-media", WorkspaceID: workspace.ID, CWD: root, Name: "Media chat"}
	if err := store.SaveChat(chat); err != nil {
		t.Fatal(err)
	}

	manager := session.NewManager(session.Config{Client: client, Store: (*wsbridge.CursorStore)(store), ConnectionWait: 2 * time.Second})
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = manager.CloseAll(ctx)
	})
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	authStore := auth.NewSessionStore(t.Context(), "pw", logger)
	bridge := wsbridge.New(wsbridge.Config{
		Context: t.Context(), Manager: manager, Store: store, ServerVersion: client.ServerVersion(), Logger: logger,
	})
	server := New(t.Context(), &config.Config{Root: root}, store, authStore, manager, bridge, logger)
	httpServer := httptest.NewServer(server.Handler())
	t.Cleanup(httpServer.Close)
	token, err := authStore.Create(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	return &mediaHarness{
		server: httpServer, daemon: daemon, store: store, manager: manager,
		workspace: workspace, chat: chat, token: token,
	}
}

func (h *mediaHarness) get(t *testing.T, wsID, chatID, rawQuery string, authenticate bool) *http.Response {
	t.Helper()
	url := h.server.URL + "/api/workspaces/" + wsID + "/chats/" + chatID + "/media"
	if rawQuery != "" {
		url += "?" + rawQuery
	}
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	if authenticate {
		req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: h.token})
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func checkMediaStatus(t *testing.T, resp *http.Response, want int) {
	t.Helper()
	if resp.StatusCode == want {
		return
	}
	body, _ := io.ReadAll(resp.Body)
	t.Fatalf("status=%d want=%d body=%s", resp.StatusCode, want, body)
}

func TestChatMediaEndpoint(t *testing.T) {
	h := newMediaHarness(t)

	t.Run("requires_auth", func(t *testing.T) {
		resp := h.get(t, h.workspace.ID, h.chat.ID, "toolCallId=call_mock&contentIndex=0", false)
		defer resp.Body.Close()
		checkMediaStatus(t, resp, http.StatusUnauthorized)
	})

	t.Run("unknown_chat", func(t *testing.T) {
		resp := h.get(t, h.workspace.ID, "chat-absent", "toolCallId=call_mock&contentIndex=0", true)
		defer resp.Body.Close()
		checkMediaStatus(t, resp, http.StatusNotFound)
	})

	t.Run("chat_outside_workspace", func(t *testing.T) {
		resp := h.get(t, "ws-other", h.chat.ID, "toolCallId=call_mock&contentIndex=0", true)
		defer resp.Body.Close()
		checkMediaStatus(t, resp, http.StatusNotFound)
	})

	t.Run("missing_tool_call_id", func(t *testing.T) {
		resp := h.get(t, h.workspace.ID, h.chat.ID, "contentIndex=0", true)
		defer resp.Body.Close()
		checkMediaStatus(t, resp, http.StatusBadRequest)
	})

	t.Run("invalid_content_index", func(t *testing.T) {
		for _, query := range []string{"toolCallId=call_mock", "toolCallId=call_mock&contentIndex=NaN", "toolCallId=call_mock&contentIndex=-1"} {
			resp := h.get(t, h.workspace.ID, h.chat.ID, query, true)
			checkMediaStatus(t, resp, http.StatusBadRequest)
			_, _ = io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
		}
	})

	// The first fetch lazily opens the chat's engine session; the block is
	// not armed yet, so the engine answers media_not_found and the endpoint
	// maps that stable code to 404.
	t.Run("media_not_found_before_arm", func(t *testing.T) {
		resp := h.get(t, h.workspace.ID, h.chat.ID, "toolCallId=call_mock&contentIndex=0", true)
		defer resp.Body.Close()
		checkMediaStatus(t, resp, http.StatusNotFound)
		var envelope map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&envelope); err != nil {
			t.Fatalf("decode error envelope: %v", err)
		}
		if _, ok := envelope["error"]; !ok {
			t.Fatalf("missing error field: %v", envelope)
		}
	})

	// The lazy open persisted the durable identity; arm the block the
	// placeholder addresses and fetch it back through the endpoint.
	chat, err := h.store.GetChat(h.chat.ID)
	if err != nil {
		t.Fatal(err)
	}
	if chat.SessionFile == "" || chat.DurableSessionID == "" {
		t.Fatalf("lazy open persisted no durable identity: %+v", chat)
	}
	h.daemon.SetSessionMedia(chat.SessionFile, "call_mock", 0, map[string]any{
		"type": "image", "data": mediaPNGBase64, "mimeType": "image/png",
	})

	t.Run("exact_bytes_and_headers", func(t *testing.T) {
		resp := h.get(t, h.workspace.ID, h.chat.ID, "toolCallId=call_mock&contentIndex=0", true)
		defer resp.Body.Close()
		checkMediaStatus(t, resp, http.StatusOK)
		if got := resp.Header.Get("Content-Type"); got != "image/png" {
			t.Fatalf("Content-Type=%q want image/png", got)
		}
		if got := resp.Header.Get("Content-Disposition"); got != "inline" {
			t.Fatalf("Content-Disposition=%q want inline", got)
		}
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		want := mediaPNGBytes(t)
		if int64(len(body)) != resp.ContentLength {
			t.Fatalf("ContentLength=%d want %d", resp.ContentLength, len(body))
		}
		if got := resp.Header.Get("Content-Length"); got != strconv.Itoa(len(want)) {
			t.Fatalf("Content-Length=%q want %d", got, len(want))
		}
		if !bytes.Equal(body, want) {
			t.Fatalf("body mismatch: got %d bytes, want the exact %d-byte PNG", len(body), len(want))
		}
	})

	// Unknown coordinates on the now-open session still surface the engine's
	// media_not_found as 404.
	t.Run("media_not_found_unknown_coordinates", func(t *testing.T) {
		resp := h.get(t, h.workspace.ID, h.chat.ID, "toolCallId=nope&contentIndex=9", true)
		defer resp.Body.Close()
		checkMediaStatus(t, resp, http.StatusNotFound)
		var envelope map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&envelope); err != nil {
			t.Fatalf("decode error envelope: %v", err)
		}
		if _, ok := envelope["error"]; !ok {
			t.Fatalf("missing error field: %v", envelope)
		}
	})
}

func TestChatMediaEngineDown(t *testing.T) {
	h := newMediaHarness(t)
	h.daemon.Stop()
	resp := h.get(t, h.workspace.ID, h.chat.ID, "toolCallId=call_mock&contentIndex=0", true)
	defer resp.Body.Close()
	checkMediaStatus(t, resp, http.StatusBadGateway)
}
