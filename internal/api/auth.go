package api

import (
	"net/http"

	"github.com/DevNewbie1826/omo-webchat/internal/auth"
)

type loginRequest struct {
	Password string `json:"password"`
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)

	var req loginRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	authenticated, banned := s.sessions.Authenticate(ip, req.Password)
	if banned {
		writeError(w, http.StatusTooManyRequests, "too many failed attempts, try again later")
		return
	}
	if !authenticated {
		writeError(w, http.StatusUnauthorized, "invalid password")
		return
	}

	token, err := s.sessions.Create(r.Context())
	if err != nil {
		s.logger.Error("creating session token", "err", err)
		writeError(w, http.StatusInternalServerError, "internal server error")
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     auth.CookieName,
		Value:    token,
		Path:     "/",
		MaxAge:   int(auth.SessionTTL.Seconds()),
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
	})
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie(auth.CookieName); err == nil {
		s.sessions.Revoke(cookie.Value)
	}
	http.SetCookie(w, &http.Cookie{
		Name:     auth.CookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
	})
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleAuthCheck only runs behind the auth middleware, so reaching it means
// the session is valid.
func (s *Server) handleAuthCheck(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
