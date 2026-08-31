// Package auth implements password login, session tokens, and brute-force protection.
package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"log/slog"
	"sync"
	"time"
)

const (
	// CookieName is the session cookie name.
	CookieName = "th_session"
	// SessionTTL is the sliding lifetime of a session token.
	SessionTTL = 24 * time.Hour

	tokenBytes  = 32
	maxFailures = 10
	// failureWindow is the fixed period, starting with the first failure, in
	// which ten failures trigger a ban. A ban then lasts for banDuration.
	failureWindow = time.Hour
	banDuration   = time.Hour
	cleanupEvery  = 10 * time.Minute
)

type session struct {
	expiresAt time.Time
}

type failureRecord struct {
	count          int
	countExpiresAt time.Time
	bannedUntil    time.Time
}

// SessionStore issues and validates session tokens, and tracks login failures per IP.
type SessionStore struct {
	passwordHash [sha256.Size]byte
	logger       *slog.Logger
	now          func() time.Time

	mu       sync.Mutex
	sessions map[string]session
	failures map[string]*failureRecord
}

// NewSessionStore creates a store for the given access password and starts a
// janitor goroutine that stops when ctx is cancelled.
func NewSessionStore(ctx context.Context, password string, logger *slog.Logger) *SessionStore {
	return newSessionStore(ctx, password, logger, time.Now)
}

func newSessionStore(ctx context.Context, password string, logger *slog.Logger, now func() time.Time) *SessionStore {
	s := &SessionStore{
		passwordHash: sha256.Sum256([]byte(password)),
		logger:       logger,
		now:          now,
		sessions:     make(map[string]session),
		failures:     make(map[string]*failureRecord),
	}
	go s.janitor(ctx)
	return s
}

// Create issues a new random token valid for SessionTTL.
func (s *SessionStore) Create(ctx context.Context) (string, error) {
	raw := make([]byte, tokenBytes)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("generating session token: %w", err)
	}
	token := hex.EncodeToString(raw)
	s.mu.Lock()
	s.sessions[token] = session{expiresAt: s.now().Add(SessionTTL)}
	s.mu.Unlock()
	return token, nil
}

// Validate reports whether token is live and extends its TTL (sliding expiry).
func (s *SessionStore) Validate(token string) bool {
	if token == "" {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[token]
	if !ok || s.now().After(sess.expiresAt) {
		delete(s.sessions, token)
		return false
	}
	sess.expiresAt = s.now().Add(SessionTTL)
	s.sessions[token] = sess
	return true
}

// Revoke invalidates a token.
func (s *SessionStore) Revoke(token string) {
	s.mu.Lock()
	delete(s.sessions, token)
	s.mu.Unlock()
}

// Authenticate atomically checks the ban state and records the result of one
// password attempt. It returns whether the password was accepted and whether
// the IP was already banned.
func (s *SessionStore) Authenticate(ip, candidate string) (authenticated, banned bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.now()
	rec := s.failures[ip]
	if rec != nil {
		switch {
		case !rec.bannedUntil.IsZero():
			if now.Before(rec.bannedUntil) {
				return false, true
			}
			delete(s.failures, ip)
			rec = nil
		case !rec.countExpiresAt.IsZero() && !now.Before(rec.countExpiresAt):
			delete(s.failures, ip)
			rec = nil
		}
	}

	got := sha256.Sum256([]byte(candidate))
	if subtle.ConstantTimeCompare(got[:], s.passwordHash[:]) == 1 {
		delete(s.failures, ip)
		return true, false
	}

	if rec == nil {
		rec = &failureRecord{countExpiresAt: now.Add(failureWindow)}
		s.failures[ip] = rec
	}
	rec.count++
	if rec.count >= maxFailures {
		rec.count = 0
		rec.countExpiresAt = time.Time{}
		rec.bannedUntil = now.Add(banDuration)
		s.logger.Warn("banning ip after repeated login failures", "ip", ip, "ban", banDuration)
	}
	return false, false
}

func (s *SessionStore) janitor(ctx context.Context) {
	ticker := time.NewTicker(cleanupEvery)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.purgeExpired()
		}
	}
}

func (s *SessionStore) purgeExpired() {
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	for token, sess := range s.sessions {
		if now.After(sess.expiresAt) {
			delete(s.sessions, token)
		}
	}
	for ip, rec := range s.failures {
		expiresAt := rec.countExpiresAt
		if !rec.bannedUntil.IsZero() {
			expiresAt = rec.bannedUntil
		}
		if !expiresAt.IsZero() && !now.Before(expiresAt) {
			delete(s.failures, ip)
		}
	}
}
