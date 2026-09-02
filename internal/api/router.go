// Package api implements the HTTP API, WebSocket bridge, and static serving.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"path"
	"strings"
	"sync"

	"github.com/DevNewbie1826/omo-webchat/frontend"
	"github.com/DevNewbie1826/omo-webchat/internal/auth"
	"github.com/DevNewbie1826/omo-webchat/internal/config"
	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
)

const maxChatLifecycleGenerationRecords = 1024

type chatLifecycleGenerationRecord struct {
	chatID     string
	generation uint64
}

// Server holds the single v2 stack shared by all HTTP handlers.
type Server struct {
	cfg      *config.Config
	cursors  *cursorstore.Store
	sessions *auth.SessionStore
	manager  *session.Manager
	bridge   http.Handler
	logger   *slog.Logger
	ctx      context.Context

	chatLifecycleMu             sync.Mutex
	chatLifecycleGeneration     sync.Map
	chatLifecycleGenerationFIFO []chatLifecycleGenerationRecord
	chatDeleting                map[string]bool
}

// New creates the API server around the required v2 stack.
func New(ctx context.Context, cfg *config.Config, cursors *cursorstore.Store, sessions *auth.SessionStore, manager *session.Manager, bridge http.Handler, logger *slog.Logger) *Server {
	return &Server{ctx: ctx, cfg: cfg, cursors: cursors, sessions: sessions, manager: manager, bridge: bridge, logger: logger, chatDeleting: make(map[string]bool)}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/login", s.handleLogin)

	protected := http.NewServeMux()
	protected.HandleFunc("POST /api/logout", s.handleLogout)
	protected.HandleFunc("GET /api/auth/check", s.handleAuthCheck)
	protected.HandleFunc("GET /api/workspaces", s.handleListWorkspaces)
	protected.HandleFunc("POST /api/workspaces", s.handleCreateWorkspace)
	protected.HandleFunc("DELETE /api/workspaces/{wsId}", s.handleDeleteWorkspace)
	protected.HandleFunc("PATCH /api/workspaces/{wsId}", s.handleRenameWorkspace)
	protected.HandleFunc("GET /api/workspaces/{wsId}/sessions", s.handleListWorkspaceSessions)
	protected.HandleFunc("POST /api/workspaces/{wsId}/chats", s.handleCreateChat)
	protected.HandleFunc("DELETE /api/workspaces/{wsId}/chats/{chatId}", s.handleDeleteChat)
	protected.HandleFunc("PATCH /api/workspaces/{wsId}/chats/{chatId}", s.handleRenameChat)
	protected.HandleFunc("POST /api/workspaces/{wsId}/chats/{chatId}/upload", s.handleUpload)
	protected.HandleFunc("GET /api/providers", s.handleListProviders)
	protected.HandleFunc("GET /api/sessions/live", s.handleListLiveSessions)
	protected.Handle("GET /api/v2/ws", s.bridge)
	protected.HandleFunc("GET /api/fs/browse", s.handleBrowse)
	protected.HandleFunc("GET /api/fs/list", s.handleList)
	protected.HandleFunc("GET /api/fs/download", s.handleDownload)
	protected.HandleFunc("GET /api/fs/read", s.handleReadFile)
	protected.HandleFunc("GET /api/fs/search", s.handleSearch)
	protected.HandleFunc("POST /api/fs/write", s.handleWriteFile)
	protected.HandleFunc("POST /api/fs/mkdir", s.handleMakeDir)
	protected.HandleFunc("GET /api/layout", s.handleGetLayout)
	protected.HandleFunc("PUT /api/layout", s.handleSetLayout)
	protected.HandleFunc("GET /api/system/stats", s.handleSystemStats)

	mux.Handle("/api/", s.sessions.Middleware(protected))
	mux.Handle("/", s.staticHandler())
	return mux
}

func (s *Server) staticHandler() http.Handler {
	sub, err := fs.Sub(frontend.Dist, "dist")
	if err != nil {
		s.logger.Error("embedded frontend missing dist/", "err", err)
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

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if v != nil {
		_ = json.NewEncoder(w).Encode(v)
	}
}
func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
func decodeJSON(r *http.Request, v any) error {
	r.Body = http.MaxBytesReader(nil, r.Body, 1<<20)
	return json.NewDecoder(r.Body).Decode(v)
}
func (s *Server) writeStoreError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, cursorstore.ErrNotFound):
		writeError(w, http.StatusNotFound, "not found")
	default:
		s.logger.Error("store operation failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal server error")
	}
}
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
