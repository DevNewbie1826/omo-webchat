package api

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/auth"
	"github.com/DevNewbie1826/omo-webchat/internal/chat"
	"github.com/DevNewbie1826/omo-webchat/internal/config"
)

func TestHandlerListsLiveSessionsWhenAuthenticated(t *testing.T) {
	// Given
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	sessions := auth.NewSessionStore(t.Context(), "pw", logger)
	server := New(t.Context(), &config.Config{}, nil, sessions, logger)
	t.Cleanup(server.chats.CloseAll)
	handler := server.Handler()

	// Then
	unauthorized := httptest.NewRecorder()
	handler.ServeHTTP(unauthorized, httptest.NewRequest(http.MethodGet, "/api/sessions/live", nil))
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status = %d, want %d", unauthorized.Code, http.StatusUnauthorized)
	}

	if _, err := exec.LookPath("node"); err != nil {
		t.Skipf("node not in PATH: %v", err)
	}
	// The multi-session mock tolerates the --multi-session launch flag the
	// shared provider appends and answers open_session, so both sessions run
	// live on one shared provider process.
	if _, started, err := server.chats.Acquire(t.Context(), chat.SessionOptions{ID: "chat-live", Binary: "node", Args: []string{mockPiPath(t)}, Env: os.Environ()}); err != nil {
		t.Fatalf("acquire live session: %v", err)
	} else if !started {
		t.Fatal("first acquire did not start a live session")
	}
	if _, started, err := server.chats.Acquire(t.Context(), chat.SessionOptions{ID: "chat-live-2", Binary: "node", Args: []string{mockPiPath(t)}, Env: os.Environ()}); err != nil {
		t.Fatalf("acquire second live session: %v", err)
	} else if !started {
		t.Fatal("second acquire did not start a live session")
	}
	token, err := sessions.Create(t.Context())
	if err != nil {
		t.Fatalf("creating auth session: %v", err)
	}

	// When
	request := httptest.NewRequest(http.MethodGet, "/api/sessions/live", nil)
	request.AddCookie(&http.Cookie{Name: auth.CookieName, Value: token})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	// Then
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}
	if got, want := recorder.Body.String(), "{\"sessions\":[\"chat-live\",\"chat-live-2\"]}\n"; got != want {
		t.Fatalf("body = %q, want %q", got, want)
	}

	// Ending one chat session must drop exactly that session from the live
	// list while the sibling on the shared provider process stays live.
	server.chats.Stop("chat-live")
	recorder = httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodGet, "/api/sessions/live", nil)
	request.AddCookie(&http.Cookie{Name: auth.CookieName, Value: token})
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status after stop = %d, want %d: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}
	if got, want := recorder.Body.String(), "{\"sessions\":[\"chat-live-2\"]}\n"; got != want {
		t.Fatalf("body after stop = %q, want %q", got, want)
	}
}
