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
)

func systemUpdateRequest(t *testing.T, s *Server, ctx context.Context, body string, authenticated bool) *http.Request {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, "/api/system/update", strings.NewReader(body)).WithContext(ctx)
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

func assertSystemUpdateError(t *testing.T, w *httptest.ResponseRecorder, status int) string {
	t.Helper()
	var body struct {
		Error string `json:"error"`
	}
	if w.Code != status || json.Unmarshal(w.Body.Bytes(), &body) != nil || body.Error == "" {
		t.Fatalf("response = %d %s, want %d JSON error", w.Code, w.Body.String(), status)
	}
	return body.Error
}

func TestSystemUpdateAuthenticationAndContract(t *testing.T) {
	s, _, _ := newChatCreateTestServer(t)
	calls := 0
	s.updateInstallation = func(ctx context.Context) error {
		calls++
		if _, ok := ctx.Deadline(); !ok {
			t.Error("installation context is not bounded")
		}
		return nil
	}
	handler := s.Handler()
	for _, authenticated := range []bool{false, true} {
		r := systemUpdateRequest(t, s, t.Context(), "{}", authenticated)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if !authenticated {
			assertSystemUpdateError(t, w, http.StatusUnauthorized)
			if calls != 0 {
				t.Fatal("unauthenticated update executed")
			}
			continue
		}
		var result struct {
			RestartRequired bool `json:"restartRequired"`
		}
		if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &result) != nil || !result.RestartRequired {
			t.Fatalf("success response = %d %s", w.Code, w.Body.String())
		}
	}
	if calls != 1 {
		t.Fatalf("updates = %d", calls)
	}
}

func TestSystemUpdateRejectsRequestCommands(t *testing.T) {
	s, _, _ := newChatCreateTestServer(t)
	s.updateInstallation = func(context.Context) error { t.Fatal("invalid request started installer"); return nil }
	handler := s.Handler()
	for _, body := range []string{`{"command":"npm","args":["anything"]}`, `{"version":"latest"}`, `[]`, `null`, `{} {}`, ``, strings.Repeat("x", 2048)} {
		r := systemUpdateRequest(t, s, t.Context(), body, true)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		assertSystemUpdateError(t, w, http.StatusBadRequest)
	}
	r := systemUpdateRequest(t, s, t.Context(), "{}", true)
	r.Method = http.MethodGet
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET status = %d", w.Code)
	}
}

func awaitSystemUpdate(t *testing.T, done <-chan *httptest.ResponseRecorder) *httptest.ResponseRecorder {
	t.Helper()
	select {
	case w := <-done:
		return w
	case <-time.After(10 * time.Second):
		t.Fatal("update handler did not finish")
		return nil
	}
}

func TestSystemUpdateDisconnectAndConcurrentRequests(t *testing.T) {
	s, _, _ := newChatCreateTestServer(t)
	s.ctx = t.Context()
	started := make(chan context.Context, 1)
	release := make(chan struct{})
	var calls atomic.Int32
	s.updateInstallation = func(ctx context.Context) error {
		if calls.Add(1) != 1 {
			return nil
		}
		started <- ctx
		select {
		case <-release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	handler := s.Handler()
	requestCtx, disconnect := context.WithCancel(t.Context())
	defer disconnect()
	first := systemUpdateRequest(t, s, requestCtx, "{}", true)
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { w := httptest.NewRecorder(); handler.ServeHTTP(w, first); done <- w }()
	var installationCtx context.Context
	select {
	case installationCtx = <-started:
	case <-time.After(10 * time.Second):
		t.Fatal("update did not start")
	}
	disconnect()
	if installationCtx.Err() != nil {
		t.Fatalf("browser disconnect canceled installation: %v", installationCtx.Err())
	}
	second := httptest.NewRecorder()
	handler.ServeHTTP(second, systemUpdateRequest(t, s, t.Context(), "{}", true))
	assertSystemUpdateError(t, second, http.StatusConflict)
	if calls.Load() != 1 {
		t.Fatal("concurrent installer started")
	}
	close(release)
	if w := awaitSystemUpdate(t, done); w.Code != http.StatusOK {
		t.Fatalf("disconnected result = %d %s", w.Code, w.Body.String())
	}
	third := httptest.NewRecorder()
	handler.ServeHTTP(third, systemUpdateRequest(t, s, t.Context(), "{}", true))
	if third.Code != http.StatusOK || calls.Load() != 2 {
		t.Fatalf("mutex not released: %d calls=%d", third.Code, calls.Load())
	}
}

func TestSystemUpdateErrorsReleaseMutex(t *testing.T) {
	for _, tc := range []struct {
		name   string
		err    error
		status int
	}{
		{"installation", errors.New("EUPDATE fixture failure"), http.StatusInternalServerError},
		{"timeout", context.DeadlineExceeded, http.StatusGatewayTimeout},
		{"shutdown", context.Canceled, http.StatusServiceUnavailable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, _, _ := newChatCreateTestServer(t)
			calls := 0
			s.updateInstallation = func(context.Context) error {
				calls++
				if calls == 1 {
					return tc.err
				}
				return nil
			}
			handler := s.Handler()
			first := httptest.NewRecorder()
			handler.ServeHTTP(first, systemUpdateRequest(t, s, t.Context(), "{}", true))
			message := assertSystemUpdateError(t, first, tc.status)
			if !strings.Contains(message, tc.err.Error()) {
				t.Fatalf("lost installer error: %q", message)
			}
			second := httptest.NewRecorder()
			handler.ServeHTTP(second, systemUpdateRequest(t, s, t.Context(), "{}", true))
			if second.Code != http.StatusOK || calls != 2 {
				t.Fatalf("mutex not released: %d calls=%d", second.Code, calls)
			}
		})
	}
}

func TestSystemUpdateServerCancellation(t *testing.T) {
	s, _, _ := newChatCreateTestServer(t)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	s.ctx = ctx
	started := make(chan struct{})
	s.updateInstallation = func(ctx context.Context) error { close(started); <-ctx.Done(); return ctx.Err() }
	handler := s.Handler()
	request := systemUpdateRequest(t, s, t.Context(), "{}", true)
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { w := httptest.NewRecorder(); handler.ServeHTTP(w, request); done <- w }()
	select {
	case <-started:
	case <-time.After(10 * time.Second):
		t.Fatal("installation did not start")
	}
	cancel()
	assertSystemUpdateError(t, awaitSystemUpdate(t, done), http.StatusServiceUnavailable)
	if !s.updateMu.TryLock() {
		t.Fatal("canceled installation kept mutex")
	}
	s.updateMu.Unlock()
}
