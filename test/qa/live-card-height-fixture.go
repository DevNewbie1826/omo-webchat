//go:build ignore

// Command live-card-height-fixture serves the built SPA (embedded fresh from
// frontend/dist when the QA script builds this binary right after
// `npm run build`) behind a loopback-only stub of the API surface the SPA
// needs on boot. It needs no real omo engine: GET /api/sessions/live answers
// exactly four fixed lean rows (shape mirrored from
// internal/session/live_summary.go) chosen so three cards render the
// conditional .th-overview-card-meta line and one ("Idle attached") has no
// work at all — the height divergence under test.
package main

import (
	"bufio"
	"context"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/DevNewbie1826/omo-webchat/frontend"
	"github.com/DevNewbie1826/omo-webchat/internal/auth"
)

const password = "live-card-height-qa"

// leanLiveValues mirrors internal/session.LiveValues at the REST boundary;
// json tags are copied verbatim so the SPA's lean parser sees the same wire
// shape GET /api/sessions/live produces in production.
type leanLiveValues struct {
	LastActivityMS *int64        `json:"last_activity_ms,omitempty"`
	Running        leanRunning   `json:"running"`
	Done           int64         `json:"done"`
	DagDone        int64         `json:"dag_done"`
	DagTotal       int64         `json:"dag_total"`
	Truncated      leanTruncated `json:"truncated"`
	LastLine       *string       `json:"last_line,omitempty"`
}

type leanRunning struct {
	Agents int64 `json:"agents"`
	Tasks  int64 `json:"tasks"`
	Dag    int64 `json:"dag"`
}

type leanTruncated struct {
	Task bool `json:"task"`
	Dag  bool `json:"dag"`
}

// liveSessionRow mirrors internal/api.liveSessionResponse: id/title/active
// with the lean values embedded inline.
type liveSessionRow struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Active bool   `json:"active"`
	leanLiveValues
}

func int64Ptr(v int64) *int64 { return &v }

// liveRows are the EXACT sessions this fixture publishes. Distinct
// last_activity_ms stamps make the rendered order deterministic (working
// sessions first, newest first; the done-only row sorts last).
func liveRows() []liveSessionRow {
	return []liveSessionRow{
		{ID: "s-agents-dag", Title: "Refactor auth", Active: true, leanLiveValues: leanLiveValues{
			LastActivityMS: int64Ptr(1757906804000),
			Running:        leanRunning{Agents: 2, Tasks: 2, Dag: 0},
			Done:           1, DagDone: 2, DagTotal: 3,
		}},
		{ID: "s-agents-only", Title: "Docs sweep", Active: true, leanLiveValues: leanLiveValues{
			LastActivityMS: int64Ptr(1757906803000),
			Running:        leanRunning{Agents: 1, Tasks: 1, Dag: 0},
		}},
		{ID: "s-main-only", Title: "Idle attached", Active: true, leanLiveValues: leanLiveValues{
			LastActivityMS: int64Ptr(1757906802000),
		}},
		{ID: "s-done-only", Title: "Quiet session", Active: false, leanLiveValues: leanLiveValues{
			LastActivityMS: int64Ptr(1757906801000),
			Done:           3,
		}},
	}
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// handleLogin mirrors internal/api.handleLogin: one password, real cookie
// semantics (name, TTL, strict same-site) through internal/auth.
func handleLogin(sessions *auth.SessionStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Password string `json:"password"`
		}
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		authenticated, banned := sessions.Authenticate(clientIP(r), req.Password)
		if banned {
			writeError(w, http.StatusTooManyRequests, "too many failed attempts, try again later")
			return
		}
		if !authenticated {
			writeError(w, http.StatusUnauthorized, "invalid password")
			return
		}
		token, err := sessions.Create(r.Context())
		if err != nil {
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
}

func handleLogout(sessions *auth.SessionStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if cookie, err := r.Cookie(auth.CookieName); err == nil {
			sessions.Revoke(cookie.Value)
		}
		http.SetCookie(w, &http.Cookie{
			Name: auth.CookieName, Value: "", Path: "/", MaxAge: -1,
			HttpOnly: true, SameSite: http.SameSiteStrictMode,
		})
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	}
}

// staticHandler mirrors internal/api's SPA handler: embedded dist files with
// cache headers, index.html fallback for client routes.
func staticHandler() http.Handler {
	sub, err := fs.Sub(frontend.Dist, "dist")
	if err != nil {
		return http.NotFoundHandler()
	}
	fileServer := http.FileServer(http.FS(sub))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cleaned := path.Clean(strings.TrimPrefix(r.URL.Path, "/"))
		if _, err := fs.Stat(sub, cleaned); err == nil {
			if strings.HasPrefix(cleaned, "assets/") {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			} else {
				w.Header().Set("Cache-Control", "no-cache")
			}
			fileServer.ServeHTTP(w, r)
			return
		}
		index, err := fs.ReadFile(sub, "index.html")
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		_, _ = w.Write(index)
	})
}

const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

const (
	wsOpContinuation byte = 0x0
	wsOpText         byte = 0x1
	wsOpBinary       byte = 0x2
	wsOpClose        byte = 0x8
	wsOpPing         byte = 0x9
	wsOpPong         byte = 0xA
)

// handleWS is a minimal RFC 6455 endpoint so the SPA's live-push socket opens
// cleanly. It answers protocol pings and JSON heartbeats and otherwise
// accepts-and-discards frames: the REST poll of /api/sessions/live is the
// data source for this fixture, so no activity frames are ever pushed.
func handleWS(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet || !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		writeError(w, http.StatusBadRequest, "websocket upgrade required")
		return
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	if key == "" {
		writeError(w, http.StatusBadRequest, "missing Sec-WebSocket-Key")
		return
	}
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		writeError(w, http.StatusInternalServerError, "hijacking unsupported")
		return
	}
	conn, buf, err := hijacker.Hijack()
	if err != nil {
		return
	}
	defer conn.Close()
	sum := sha1.Sum([]byte(key + wsGUID))
	handshake := "HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\nConnection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + base64.StdEncoding.EncodeToString(sum[:]) + "\r\n\r\n"
	if _, err := buf.WriteString(handshake); err != nil {
		return
	}
	if err := buf.Flush(); err != nil {
		return
	}
	serveWSFrames(conn, buf)
}

func serveWSFrames(conn net.Conn, rw *bufio.ReadWriter) {
	_ = conn.SetDeadline(time.Now().Add(10 * time.Minute))
	for {
		op, payload, err := readWSFrame(rw.Reader)
		if err != nil {
			return
		}
		switch op {
		case wsOpClose:
			_ = writeWSFrame(rw.Writer, wsOpClose, payload)
			return
		case wsOpPing:
			if writeWSFrame(rw.Writer, wsOpPong, payload) != nil {
				return
			}
		case wsOpText, wsOpBinary, wsOpContinuation:
			// JSON heartbeat frames keep the client's liveness probe happy;
			// hello/sessions.subscribe are accepted without an answer.
			if strings.Contains(string(payload), `"ping"`) {
				if writeWSFrame(rw.Writer, wsOpText, []byte(`{"type":"pong"}`)) != nil {
					return
				}
			}
		}
	}
}

func readWSFrame(r *bufio.Reader) (byte, []byte, error) {
	var header [2]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return 0, nil, err
	}
	op := header[0] & 0x0F
	masked := header[1]&0x80 != 0
	length := uint64(header[1] & 0x7F)
	switch length {
	case 126:
		var ext [2]byte
		if _, err := io.ReadFull(r, ext[:]); err != nil {
			return 0, nil, err
		}
		length = uint64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err := io.ReadFull(r, ext[:]); err != nil {
			return 0, nil, err
		}
		length = binary.BigEndian.Uint64(ext[:])
	}
	if length > 1<<20 {
		return 0, nil, errors.New("websocket frame too large")
	}
	var mask [4]byte
	if masked {
		if _, err := io.ReadFull(r, mask[:]); err != nil {
			return 0, nil, err
		}
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(r, payload); err != nil {
		return 0, nil, err
	}
	if masked {
		for i := range payload {
			payload[i] ^= mask[i%4]
		}
	}
	return op, payload, nil
}

func writeWSFrame(w *bufio.Writer, op byte, payload []byte) error {
	frame := []byte{0x80 | op}
	switch n := len(payload); {
	case n < 126:
		frame = append(frame, byte(n))
	case n <= 0xFFFF:
		frame = append(frame, 126, byte(n>>8), byte(n))
	default:
		var ext [8]byte
		binary.BigEndian.PutUint64(ext[:], uint64(n))
		frame = append(append(frame, 127), ext[:]...)
	}
	frame = append(frame, payload...)
	if _, err := w.Write(frame); err != nil {
		return err
	}
	return w.Flush()
}

func run() error {
	root := flag.String("root", "", "fresh empty owned root")
	address := flag.String("listen", "127.0.0.1:0", "loopback listen address")
	flag.Parse()
	if !filepath.IsAbs(*root) {
		return errors.New("absolute --root required")
	}
	entries, err := os.ReadDir(*root)
	if err != nil || len(entries) != 0 {
		return errors.New("--root must be an existing empty directory")
	}
	host, _, err := net.SplitHostPort(*address)
	if err != nil || host != "127.0.0.1" {
		return errors.New("loopback listen address required")
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	sessions := auth.NewSessionStore(ctx, password, logger)

	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/login", handleLogin(sessions))

	protected := http.NewServeMux()
	protected.HandleFunc("POST /api/logout", handleLogout(sessions))
	protected.HandleFunc("GET /api/auth/check", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	protected.HandleFunc("GET /api/workspaces", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, []any{})
	})
	protected.HandleFunc("GET /api/workspaces/{wsId}/sessions", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"items": []any{}, "nextCursor": ""})
	})
	protected.HandleFunc("GET /api/layout", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"layout": nil})
	})
	protected.HandleFunc("PUT /api/layout", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	protected.HandleFunc("GET /api/providers", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, []map[string]any{{"id": "omo", "label": "Omo", "binary": "omo", "available": true}})
	})
	protected.HandleFunc("GET /api/sessions/live", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"sessions": liveRows()})
	})
	protected.HandleFunc("GET /api/v2/ws", handleWS)
	protected.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "stub fixture: unsupported API route")
	})

	mux.Handle("/api/", sessions.Middleware(protected))
	mux.Handle("/", staticHandler())

	listener, err := net.Listen("tcp", *address)
	if err != nil {
		return err
	}
	httpServer := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	stopped := make(chan error, 1)
	go func() { stopped <- httpServer.Serve(listener) }()
	fmt.Printf("LIVE_CARD_QA_READY http://%s\n", listener.Addr())
	select {
	case err := <-stopped:
		return err
	case <-ctx.Done():
		shutdown, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		if err := httpServer.Shutdown(shutdown); err != nil {
			return errors.Join(err, httpServer.Close())
		}
		if err := <-stopped; !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	}
	fmt.Println("LIVE_CARD_QA_STOPPED")
	return nil
}

func main() {
	if err := run(); err != nil && !errors.Is(err, io.EOF) {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
