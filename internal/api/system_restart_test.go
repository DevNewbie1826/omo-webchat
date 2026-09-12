package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/auth"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func systemRestartRequest(t *testing.T, s *Server, ctx context.Context, body string, authenticated bool) *http.Request {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, "/api/system/engine/restart", strings.NewReader(body)).WithContext(ctx)
	r.Header.Set("Content-Type", "application/json")
	if authenticated {
		token, err := s.sessions.Create(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		r.AddCookie(&http.Cookie{Name: auth.CookieName, Value: token})
	}
	return r
}

func assertSystemRestartError(t *testing.T, w *httptest.ResponseRecorder, status int) string {
	t.Helper()
	var body struct {
		Error string `json:"error"`
	}
	if w.Code != status || json.Unmarshal(w.Body.Bytes(), &body) != nil || body.Error == "" {
		t.Fatalf("response = %d %s, want %d JSON error", w.Code, w.Body.String(), status)
	}
	return body.Error
}

func TestSystemEngineRestartAuthenticationAndContract(t *testing.T) {
	s, _, _ := newChatCreateTestServer(t)
	calls := 0
	s.restartEngine = func(ctx context.Context) (string, string, error) {
		calls++
		if _, ok := ctx.Deadline(); !ok {
			t.Error("restart context is not bounded")
		}
		if ctx.Err() != nil {
			t.Error("restart context is already canceled")
		}
		return "before-version", "after-version", nil
	}
	handler := s.Handler()
	for _, authenticated := range []bool{false, true} {
		r := systemRestartRequest(t, s, t.Context(), "{}", authenticated)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if !authenticated {
			assertSystemRestartError(t, w, http.StatusUnauthorized)
			if calls != 0 {
				t.Fatal("unauthenticated restart executed")
			}
			continue
		}
		var result struct {
			Restarted           bool   `json:"restarted"`
			EngineVersionBefore string `json:"engineVersionBefore"`
			EngineVersionAfter  string `json:"engineVersionAfter"`
			ActiveChats         int    `json:"activeChats"`
		}
		if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &result) != nil {
			t.Fatalf("success response = %d %s", w.Code, w.Body.String())
		}
		if !result.Restarted || result.EngineVersionBefore != "before-version" || result.EngineVersionAfter != "after-version" || result.ActiveChats != 0 {
			t.Fatalf("success body = %s", w.Body.String())
		}
	}
	if calls != 1 {
		t.Fatalf("restarts = %d", calls)
	}
}

func TestSystemEngineRestartRejectsNonEmptyBodies(t *testing.T) {
	s, _, _ := newChatCreateTestServer(t)
	s.restartEngine = func(context.Context) (string, string, error) {
		t.Fatal("invalid request restarted the engine")
		return "", "", nil
	}
	handler := s.Handler()
	for _, body := range []string{`{"force":true}`, `{"command":"anything"}`, `[]`, `null`, `"x"`, `{} {}`, ``, strings.Repeat("x", 2048)} {
		r := systemRestartRequest(t, s, t.Context(), body, true)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		assertSystemRestartError(t, w, http.StatusBadRequest)
	}
	r := systemRestartRequest(t, s, t.Context(), "{}", true)
	r.Method = http.MethodGet
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET status = %d", w.Code)
	}
}

func awaitSystemRestart(t *testing.T, done <-chan *httptest.ResponseRecorder) *httptest.ResponseRecorder {
	t.Helper()
	select {
	case w := <-done:
		return w
	case <-time.After(10 * time.Second):
		t.Fatal("restart handler did not finish")
		return nil
	}
}

func TestSystemEngineRestartDisconnectAndConcurrentRequests(t *testing.T) {
	s, _, _ := newChatCreateTestServer(t)
	s.ctx = t.Context()
	started := make(chan context.Context, 1)
	release := make(chan struct{})
	var calls atomic.Int32
	s.restartEngine = func(ctx context.Context) (string, string, error) {
		if calls.Add(1) != 1 {
			return "", "", nil
		}
		started <- ctx
		select {
		case <-release:
			return "before", "after", nil
		case <-ctx.Done():
			return "", "", ctx.Err()
		}
	}
	handler := s.Handler()
	requestCtx, disconnect := context.WithCancel(t.Context())
	defer disconnect()
	first := systemRestartRequest(t, s, requestCtx, "{}", true)
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { w := httptest.NewRecorder(); handler.ServeHTTP(w, first); done <- w }()
	var restartCtx context.Context
	select {
	case restartCtx = <-started:
	case <-time.After(10 * time.Second):
		t.Fatal("restart did not start")
	}
	disconnect()
	if restartCtx.Err() != nil {
		t.Fatalf("browser disconnect canceled restart: %v", restartCtx.Err())
	}
	second := httptest.NewRecorder()
	handler.ServeHTTP(second, systemRestartRequest(t, s, t.Context(), "{}", true))
	assertSystemRestartError(t, second, http.StatusConflict)
	if calls.Load() != 1 {
		t.Fatal("concurrent restart started")
	}
	close(release)
	if w := awaitSystemRestart(t, done); w.Code != http.StatusOK {
		t.Fatalf("disconnected result = %d %s", w.Code, w.Body.String())
	}
	third := httptest.NewRecorder()
	handler.ServeHTTP(third, systemRestartRequest(t, s, t.Context(), "{}", true))
	if third.Code != http.StatusOK || calls.Load() != 2 {
		t.Fatalf("mutex not released: %d calls=%d", third.Code, calls.Load())
	}
}

func TestSystemEngineRestartErrorsReleaseMutex(t *testing.T) {
	for _, tc := range []struct {
		name   string
		err    error
		status int
		reason string
	}{
		{"not-owned", omorpc.ErrDaemonNotOwned, http.StatusConflict, "not started by this server"},
		{"restart-failure", errors.New("ERESTART fixture failure"), http.StatusInternalServerError, "ERESTART fixture failure"},
		{"deadline", context.DeadlineExceeded, http.StatusGatewayTimeout, context.DeadlineExceeded.Error()},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, _, _ := newChatCreateTestServer(t)
			calls := 0
			s.restartEngine = func(context.Context) (string, string, error) {
				calls++
				if calls == 1 {
					return "", "", tc.err
				}
				return "before", "after", nil
			}
			handler := s.Handler()
			first := httptest.NewRecorder()
			handler.ServeHTTP(first, systemRestartRequest(t, s, t.Context(), "{}", true))
			message := assertSystemRestartError(t, first, tc.status)
			if !strings.Contains(message, tc.reason) {
				t.Fatalf("lost restart reason: %q", message)
			}
			second := httptest.NewRecorder()
			handler.ServeHTTP(second, systemRestartRequest(t, s, t.Context(), "{}", true))
			if second.Code != http.StatusOK || calls != 2 {
				t.Fatalf("mutex not released: %d calls=%d", second.Code, calls)
			}
		})
	}
}
