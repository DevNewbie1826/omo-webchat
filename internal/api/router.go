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
	"time"

	"github.com/lxzan/gws"

	"github.com/DevNewbie1826/omo-webchat/frontend"
	"github.com/DevNewbie1826/omo-webchat/internal/auth"
	"github.com/DevNewbie1826/omo-webchat/internal/chat"
	"github.com/DevNewbie1826/omo-webchat/internal/config"
	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	v2session "github.com/DevNewbie1826/omo-webchat/internal/session"
	"github.com/DevNewbie1826/omo-webchat/internal/store"
	"github.com/DevNewbie1826/omo-webchat/internal/wsbridge"
)

const chatOpenTimeout = 15 * time.Second

// Server holds shared dependencies for all HTTP handlers.
type Server struct {
	gws.BuiltinEventHandler
	cfg                     *config.Config
	store                   *store.Store
	sessions                *auth.SessionStore
	chats                   *chat.Manager
	logger                  *slog.Logger
	upgrader                *gws.Upgrader
	ctx                     context.Context
	conns                   sync.Map
	chatLifecycleMu         sync.Mutex
	chatLifecycleGeneration sync.Map // chat id -> uint64; lock-free publication validation
	chatDeleting            map[string]bool
	afterChatLookup         func()
	beforeChatDelete        func()
	afterV2ChatStop         func()
	beforeWorkspaceDelete   func()
	openChatContext         func(context.Context, time.Duration) (context.Context, context.CancelFunc)
	v2Mu                    sync.RWMutex
	v2Manager               *v2session.Manager
	v2Store                 *cursorstore.Store
	v2Handler               http.Handler
}

// New creates the API server.
func New(ctx context.Context, cfg *config.Config, st *store.Store, sessions *auth.SessionStore, logger *slog.Logger) *Server {
	s := &Server{
		ctx:             ctx,
		cfg:             cfg,
		store:           st,
		sessions:        sessions,
		logger:          logger,
		chats:           chat.NewManagerWithLogger(logger),
		chatDeleting:    make(map[string]bool),
		openChatContext: context.WithTimeout,
	}
	s.upgrader = gws.NewUpgrader(s, &gws.ServerOption{
		Recovery: gws.Recovery,
		// Chat history replay is multi-megabyte JSON and dominates chat-open latency; defaults keep the low-memory no-context-takeover profile.
		PermessageDeflate: gws.PermessageDeflate{Enabled: true},
		Authorize: func(r *http.Request, _ gws.SessionStorage) bool {
			return wsOriginAllowed(r)
		},
	})
	return s
}

// Handler builds the root mux: public login, authenticated /api/*, static SPA.
func (s *Server) newChatOpenContext(parent context.Context) (context.Context, context.CancelFunc) {
	factory := s.openChatContext
	if factory == nil {
		factory = context.WithTimeout
	}
	return factory(parent, chatOpenTimeout)
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

	protected.HandleFunc("GET /api/ws", s.handleWS)
	// Resolve the atomically installed v2 stack at request time. Startup may
	// replace a diagnostic 503 after this mux has already been constructed.
	protected.HandleFunc("GET /api/v2/ws", func(w http.ResponseWriter, r *http.Request) {
		s.v2Endpoint().ServeHTTP(w, r)
	})

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

// staticHandler serves the embedded frontend with SPA fallback to index.html.
func (s *Server) installV2(manager *v2session.Manager, cursors *cursorstore.Store, handler http.Handler) {
	s.v2Mu.Lock()
	s.v2Manager, s.v2Store, s.v2Handler = manager, cursors, handler
	s.v2Mu.Unlock()
}

func (s *Server) v2Stack() (*v2session.Manager, *cursorstore.Store) {
	s.v2Mu.RLock()
	defer s.v2Mu.RUnlock()
	return s.v2Manager, s.v2Store
}

func (s *Server) v2Endpoint() http.Handler {
	s.v2Mu.RLock()
	defer s.v2Mu.RUnlock()
	if s.v2Handler != nil {
		return s.v2Handler
	}
	return wsbridge.Unavailable("provider daemon initialization pending")
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
			// Content-hashed assets are immutable; everything else (favicon,
			// fonts) gets a short cache. index.html is handled by the SPA
			// fallback below with no-cache so a rebuild is always picked up.
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
	r.Body = http.MaxBytesReader(nil, r.Body, 1<<20) // 1 MiB
	return json.NewDecoder(r.Body).Decode(v)
}

// writeStoreError maps store sentinel errors to HTTP responses.
func (s *Server) writeStoreError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "not found")
	case errors.Is(err, store.ErrDuplicate):
		writeError(w, http.StatusConflict, "name already in use")
	default:
		s.logger.Error("store operation failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal server error")
	}
}

// clientIP extracts the client address from the TCP connection.
// X-Forwarded-For is intentionally NOT trusted — there is no trusted-proxy
// configuration, so honoring it would let any client spoof their IP and
// bypass per-IP rate limiting.
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
