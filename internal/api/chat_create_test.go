package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/auth"
	"github.com/DevNewbie1826/omo-webchat/internal/chat"
	"github.com/DevNewbie1826/omo-webchat/internal/config"
	"github.com/DevNewbie1826/omo-webchat/internal/store"
)

func newChatCreateTestServer(t *testing.T) (*Server, *store.Store, store.Workspace) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	st, err := store.Load(context.Background(), logger)
	if err != nil {
		t.Fatalf("load store: %v", err)
	}
	ws, err := st.CreateWorkspace("demo", home)
	if err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	srv := New(context.Background(), &config.Config{}, st, auth.NewSessionStore(context.Background(), "pw", logger), logger)
	return srv, st, ws
}

func installFakeProvider(t *testing.T, provider string) {
	t.Helper()
	bin := t.TempDir()
	path := filepath.Join(bin, provider)
	if err := os.WriteFile(path, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatalf("write fake provider: %v", err)
	}
	t.Setenv("PATH", bin)
}

func createChatRequestForTest(t *testing.T, srv *Server, wsID, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/workspaces/"+wsID+"/chats", strings.NewReader(body))
	req.SetPathValue("wsId", wsID)
	rec := httptest.NewRecorder()
	srv.handleCreateChat(rec, req)
	return rec
}

func TestCreateChatPersistsExplicitProviderWithoutModel(t *testing.T) {
	installFakeProvider(t, "omo")
	srv, st, ws := newChatCreateTestServer(t)

	rec := createChatRequestForTest(t, srv, ws.ID, `{"name":"chosen","provider":"omo","model":{"provider":"x","modelId":"must-not-persist"}}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d; body: %s", rec.Code, http.StatusCreated, rec.Body.String())
	}
	var created store.Chat
	if err := json.NewDecoder(rec.Body).Decode(&created); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if created.Provider != "omo" {
		t.Fatalf("response provider = %q, want omo", created.Provider)
	}
	if len(created.Model) != 0 {
		t.Fatalf("response model = %s, want absent", created.Model)
	}
	persisted, err := st.GetChat(ws.ID, created.ID)
	if err != nil {
		t.Fatalf("get persisted chat: %v", err)
	}
	if persisted.Provider != "omo" {
		t.Fatalf("persisted provider = %q, want omo", persisted.Provider)
	}
	if len(persisted.Model) != 0 {
		t.Fatalf("persisted model = %s, want absent", persisted.Model)
	}
}

func TestCreateChatRequiresSupportedProvider(t *testing.T) {
	srv, st, ws := newChatCreateTestServer(t)
	for _, tc := range []struct {
		name string
		body string
	}{
		{name: "missing", body: `{}`},
		{name: "unknown", body: `{"provider":"other"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := createChatRequestForTest(t, srv, ws.ID, tc.body)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want %d; body: %s", rec.Code, http.StatusBadRequest, rec.Body.String())
			}
			got, err := st.GetWorkspace(ws.ID)
			if err != nil {
				t.Fatal(err)
			}
			if len(got.Chats) != 0 {
				t.Fatalf("created %d chats for invalid provider", len(got.Chats))
			}
		})
	}
}

func TestCreateChatUsesConfiguredRunnerForAvailability(t *testing.T) {
	bin := t.TempDir()
	runner := filepath.Join(bin, "custom-runner")
	if err := os.WriteFile(runner, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatalf("write configured runner: %v", err)
	}
	t.Setenv("PATH", t.TempDir())
	t.Setenv("CHAT_PI_BINARY", runner)
	srv, _, ws := newChatCreateTestServer(t)

	rec := createChatRequestForTest(t, srv, ws.ID, `{"provider":"omo"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d; body: %s", rec.Code, http.StatusCreated, rec.Body.String())
	}
}

func TestListProvidersUsesConfiguredRunner(t *testing.T) {
	bin := t.TempDir()
	runner := filepath.Join(bin, "custom-runner")
	if err := os.WriteFile(runner, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatalf("write configured runner: %v", err)
	}
	t.Setenv("PATH", t.TempDir())
	t.Setenv("CHAT_PI_BINARY", runner)
	srv, _, _ := newChatCreateTestServer(t)

	rec := httptest.NewRecorder()
	srv.handleListProviders(rec, httptest.NewRequest(http.MethodGet, "/api/providers", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	var providers []chat.ProviderStatus
	if err := json.NewDecoder(rec.Body).Decode(&providers); err != nil {
		t.Fatalf("decode providers: %v", err)
	}
	if len(providers) != 1 || providers[0].ID != "omo" {
		t.Fatalf("providers = %+v, want exactly one Omo provider", providers)
	}
}

func TestCreateChatRejectsUnavailableProvider(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	srv, st, ws := newChatCreateTestServer(t)

	rec := createChatRequestForTest(t, srv, ws.ID, `{"provider":"omo"}`)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d; body: %s", rec.Code, http.StatusServiceUnavailable, rec.Body.String())
	}
	got, err := st.GetWorkspace(ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Chats) != 0 {
		t.Fatalf("created %d chats with unavailable provider", len(got.Chats))
	}
}

func TestCreateChatRejectsResumeIdentityFromAnotherWorkspace(t *testing.T) {
	installFakeProvider(t, "omo")
	srv, st, ws, agent := newSessionHistoryTestServer(t)
	foreignCwd := t.TempDir()
	foreignPath := writeDiskSession(
		t,
		agent,
		foreignCwd,
		"foreign-session-id",
		"Foreign disk chat",
		time.Now().Add(-time.Minute),
	)

	body, err := json.Marshal(map[string]string{
		"name":           "Foreign disk chat",
		"provider":       "omo",
		"resumeIdentity": foreignPath,
	})
	if err != nil {
		t.Fatalf("encode request: %v", err)
	}

	rec := createChatRequestForTest(t, srv, ws.ID, string(body))
	if rec.Code < 400 || rec.Code >= 500 {
		t.Fatalf("status = %d, want a 4xx; body: %s", rec.Code, rec.Body.String())
	}
	persisted, err := st.GetWorkspace(ws.ID)
	if err != nil {
		t.Fatalf("get workspace: %v", err)
	}
	if len(persisted.Chats) != 0 {
		t.Fatalf("persisted chats = %+v, want none for a foreign resume identity", persisted.Chats)
	}
}

func TestCreateChatWithResumeIdentityPersistsAndDeduplicatesDiscoveredSession(t *testing.T) {
	installFakeProvider(t, "omo")
	srv, st, ws, agent := newSessionHistoryTestServer(t)
	path := writeDiskSession(
		t,
		agent,
		ws.Path,
		"disk-session-id",
		"Imported disk chat",
		time.Now().Add(-time.Minute),
	)
	before := decodeSessionHistoryPage(t, listWorkspaceSessions(t, srv, ws.ID, ""))
	if len(before.Items) != 1 || before.Items[0].ID != "disk-session-id" ||
		before.Items[0].Source != sessionHistorySourceDiscovered {
		t.Fatalf("session history before import = %+v, want the discovered disk session", before.Items)
	}

	body, err := json.Marshal(map[string]string{
		"name":           "Imported disk chat",
		"provider":       "omo",
		"resumeIdentity": path,
	})
	if err != nil {
		t.Fatalf("encode request: %v", err)
	}

	rec := createChatRequestForTest(t, srv, ws.ID, string(body))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d; body: %s", rec.Code, http.StatusCreated, rec.Body.String())
	}
	var created store.Chat
	if err := json.NewDecoder(rec.Body).Decode(&created); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if created.PiSessionID != path {
		t.Fatalf("response resume identity = %q, want %q", created.PiSessionID, path)
	}
	persisted, err := st.GetChat(ws.ID, created.ID)
	if err != nil {
		t.Fatalf("get persisted chat: %v", err)
	}
	if persisted.PiSessionID != path {
		t.Fatalf("persisted resume identity = %q, want %q", persisted.PiSessionID, path)
	}

	page := decodeSessionHistoryPage(t, listWorkspaceSessions(t, srv, ws.ID, ""))
	if len(page.Items) != 1 {
		t.Fatalf("session history = %+v, want one deduplicated stored chat", page.Items)
	}
	if page.Items[0].ID != created.ID || page.Items[0].Source != sessionHistorySourceStored {
		t.Fatalf("session history item = %+v, want stored chat %q", page.Items[0], created.ID)
	}
}
