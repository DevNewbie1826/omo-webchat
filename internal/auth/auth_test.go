package auth

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

type fakeClock struct {
	now time.Time
}

func (c *fakeClock) Now() time.Time {
	return c.now
}

func (c *fakeClock) Advance(d time.Duration) {
	c.now = c.now.Add(d)
}

func newTestStore(t *testing.T, clock *fakeClock) *SessionStore {
	t.Helper()
	return newSessionStore(t.Context(), "correct-password", slog.New(slog.NewTextHandler(io.Discard, nil)), clock.Now)
}

func newFakeClock() *fakeClock {
	return &fakeClock{now: time.Date(2026, time.August, 29, 12, 0, 0, 0, time.UTC)}
}

func requireRejected(t *testing.T, store *SessionStore, ip string) {
	t.Helper()
	authenticated, banned := store.Authenticate(ip, "wrong-password")
	if authenticated || banned {
		t.Fatalf("failed attempt = (%v, %v), want (false, false)", authenticated, banned)
	}
}

func requireBanned(t *testing.T, store *SessionStore, ip string) {
	t.Helper()
	authenticated, banned := store.Authenticate(ip, "wrong-password")
	if authenticated || !banned {
		t.Fatalf("banned attempt = (%v, %v), want (false, true)", authenticated, banned)
	}
}

func TestFailuresSurviveCleanupAndAccumulateToBan(t *testing.T) {
	clock := newFakeClock()
	store := newTestStore(t, clock)

	for range maxFailures / 2 {
		for range 2 {
			requireRejected(t, store, "192.0.2.1")
		}
		clock.Advance(cleanupEvery)
		store.purgeExpired()
	}

	requireBanned(t, store, "192.0.2.1")
}

func TestFailureCountExpiresAfterWindow(t *testing.T) {
	clock := newFakeClock()
	store := newTestStore(t, clock)
	const ip = "192.0.2.2"

	for range maxFailures - 1 {
		requireRejected(t, store, ip)
	}
	clock.Advance(failureWindow)
	store.purgeExpired()

	store.mu.Lock()
	_, exists := store.failures[ip]
	store.mu.Unlock()
	if exists {
		t.Fatal("failure record survived the counting window")
	}

	for range maxFailures - 1 {
		requireRejected(t, store, ip)
	}
	requireRejected(t, store, ip)
	requireBanned(t, store, ip)
}

func TestBanExpires(t *testing.T) {
	clock := newFakeClock()
	store := newTestStore(t, clock)
	const ip = "192.0.2.3"

	for range maxFailures {
		requireRejected(t, store, ip)
	}
	requireBanned(t, store, ip)

	clock.Advance(banDuration)
	store.purgeExpired()
	requireRejected(t, store, ip)
}

func TestSuccessfulLoginResetsFailureCount(t *testing.T) {
	clock := newFakeClock()
	store := newTestStore(t, clock)
	const ip = "192.0.2.4"

	for range maxFailures - 1 {
		requireRejected(t, store, ip)
	}
	authenticated, banned := store.Authenticate(ip, "correct-password")
	if !authenticated || banned {
		t.Fatalf("successful attempt = (%v, %v), want (true, false)", authenticated, banned)
	}

	for range maxFailures - 1 {
		requireRejected(t, store, ip)
	}
	requireRejected(t, store, ip)
	requireBanned(t, store, ip)
}

func TestTokenExpiry(t *testing.T) {
	clock := newFakeClock()
	store := newTestStore(t, clock)
	token, err := store.Create(t.Context())
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	clock.Advance(SessionTTL + time.Nanosecond)
	store.purgeExpired()
	if store.Validate(token) {
		t.Fatal("Validate() accepted an expired token")
	}
}

func TestValidationSlidesTokenTTL(t *testing.T) {
	clock := newFakeClock()
	store := newTestStore(t, clock)
	token, err := store.Create(t.Context())
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	clock.Advance(18 * time.Hour)
	if !store.Validate(token) {
		t.Fatal("Validate() rejected a live token")
	}
	clock.Advance(18 * time.Hour)
	if !store.Validate(token) {
		t.Fatal("Validate() did not extend the token TTL")
	}
	clock.Advance(SessionTTL + time.Nanosecond)
	if store.Validate(token) {
		t.Fatal("Validate() accepted a token after its sliding TTL elapsed")
	}
}

func TestRevoke(t *testing.T) {
	clock := newFakeClock()
	store := newTestStore(t, clock)
	token, err := store.Create(t.Context())
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if !store.Validate(token) {
		t.Fatal("Validate() rejected a newly created token")
	}

	store.Revoke(token)
	if store.Validate(token) {
		t.Fatal("Validate() accepted a revoked token")
	}
	if store.Validate("") {
		t.Fatal("Validate() accepted an empty token")
	}
}

func TestAuthenticateConcurrentFailuresBanAtThreshold(t *testing.T) {
	clock := newFakeClock()
	store := newTestStore(t, clock)

	const attempts = maxFailures * 3
	start := make(chan struct{})
	results := make(chan struct {
		authenticated bool
		banned        bool
	}, attempts)
	var wg sync.WaitGroup
	for range attempts {
		wg.Go(func() {
			<-start
			authenticated, banned := store.Authenticate("192.0.2.5", "wrong-password")
			results <- struct {
				authenticated bool
				banned        bool
			}{authenticated, banned}
		})
	}

	close(start)
	wg.Wait()
	close(results)

	var admitted, rejected int
	for result := range results {
		if result.authenticated {
			t.Error("incorrect password was authenticated")
		}
		if result.banned {
			rejected++
		} else {
			admitted++
		}
	}
	if admitted != maxFailures {
		t.Fatalf("failed attempts admitted = %d, want %d", admitted, maxFailures)
	}
	if rejected != attempts-maxFailures {
		t.Fatalf("failed attempts rejected as banned = %d, want %d", rejected, attempts-maxFailures)
	}
}

func TestMiddlewareRequiresValidSession(t *testing.T) {
	clock := newFakeClock()
	store := newTestStore(t, clock)
	handler := store.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	unauthorized := httptest.NewRecorder()
	handler.ServeHTTP(unauthorized, httptest.NewRequest(http.MethodGet, "/", nil))
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("request without token status = %d, want %d", unauthorized.Code, http.StatusUnauthorized)
	}

	token, err := store.Create(t.Context())
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	authorized := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.AddCookie(&http.Cookie{Name: CookieName, Value: token})
	handler.ServeHTTP(authorized, request)
	if authorized.Code != http.StatusNoContent {
		t.Fatalf("request with token status = %d, want %d", authorized.Code, http.StatusNoContent)
	}
}
