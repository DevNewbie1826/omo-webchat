package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/auth"
	"github.com/DevNewbie1826/omo-webchat/internal/config"
	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	v2session "github.com/DevNewbie1826/omo-webchat/internal/session"
	"github.com/DevNewbie1826/omo-webchat/internal/store"
	"github.com/DevNewbie1826/omo-webchat/internal/wsbridge"
)

type v2ChatPreparerStore interface {
	SaveWorkspace(cursorstore.Workspace) error
	GetChat(string) (cursorstore.Chat, error)
	SaveChat(cursorstore.Chat) error
}

// prepareV2Chat mirrors launch metadata while holding the same lifecycle lock
// as deletion, so a deleted v1 chat cannot be republished into the v2 store.
func (s *Server) prepareV2Chat(cursors v2ChatPreparerStore, wsID, chatID string) error {
	_, err := s.prepareV2ChatVersion(cursors, wsID, chatID)
	return err
}

// prepareV2ChatVersion captures the deletion generation in the same critical
// section as metadata preparation. The bridge later validates it lock-free,
// avoiding a chatLifecycleMu -> manager-flight lock inversion.
func (s *Server) prepareV2ChatVersion(cursors v2ChatPreparerStore, wsID, chatID string) (uint64, error) {
	s.chatLifecycleMu.Lock()
	defer s.chatLifecycleMu.Unlock()
	if s.chatDeleting[chatID] {
		return 0, wsbridge.ErrChatDeleted
	}

	ws, err := s.store.GetWorkspace(wsID)
	if err != nil {
		return 0, err
	}
	chat, err := s.store.GetChat(wsID, chatID)
	if err != nil {
		return 0, err
	}
	if err := cursors.SaveWorkspace(cursorstore.Workspace{ID: ws.ID, Name: ws.Name, Path: ws.Path}); err != nil {
		return 0, err
	}
	cwd := chat.Cwd
	if cwd == "" {
		cwd = ws.Path
	}
	current, err := cursors.GetChat(chat.ID)
	if err == nil {
		current.WorkspaceID, current.CWD, current.Name = ws.ID, cwd, chat.Name
		if err := cursors.SaveChat(current); err != nil {
			return 0, err
		}
	} else if err := cursors.SaveChat(cursorstore.Chat{ID: chat.ID, WorkspaceID: ws.ID, CWD: cwd, Name: chat.Name, NameSource: cursorstore.NameSourceAuto, CreatedAt: chat.CreatedAt}); err != nil {
		return 0, err
	}
	return s.chatLifecycleVersion(chatID), nil
}

func (s *Server) chatLifecycleVersion(chatID string) uint64 {
	if value, ok := s.chatLifecycleGeneration.Load(chatID); ok {
		return value.(uint64)
	}
	return 0
}

// bumpChatLifecycleVersion is called only while chatLifecycleMu is held.
func (s *Server) bumpChatLifecycleVersion(chatID string) {
	s.chatLifecycleGeneration.Store(chatID, s.chatLifecycleVersion(chatID)+1)
}

// Run initializes the store, session store, and HTTP server, then serves until
// ctx is cancelled.
func Run(ctx context.Context, cfg *config.Config, logger *slog.Logger, onReady func() error) error {
	ctx, cancelRun := context.WithCancel(ctx)
	defer cancelRun()
	var (
		st  *store.Store
		err error
	)
	if cfg.StateDir != "" {
		st, err = store.LoadDir(cfg.StateDir, logger)
	} else {
		st, err = store.Load(ctx, logger)
	}
	if err != nil {
		return fmt.Errorf("loading store: %w", err)
	}
	sessions := auth.NewSessionStore(ctx, cfg.Password, logger)
	apiServer := New(ctx, cfg, st, sessions, logger)

	var (
		v2Manager *v2session.Manager
		v2Bridge  *wsbridge.Handler
		ensured   *omorpc.EnsuredDaemon
		v2Cleanup sync.Once
	)
	closeV2 := func() {
		v2Cleanup.Do(func() {
			apiServer.installV2(nil, nil, wsbridge.Unavailable("server stopped"))
			if v2Bridge != nil {
				v2Bridge.CloseConnections()
			}
			if v2Manager != nil {
				managerCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				if closeErr := v2Manager.CloseAll(managerCtx); closeErr != nil {
					logger.Error("closing v2 sessions", "err", closeErr)
				}
				cancel()
			}
			if ensured != nil {
				clientCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				if stopErr := ensured.Stop(clientCtx); stopErr != nil {
					logger.Error("closing v2 provider client", "err", stopErr)
				}
				cancel()
			}
		})
	}
	var cleanup sync.Once
	cleanupAll := func() {
		cleanup.Do(func() {
			cancelRun()
			apiServer.CloseConnections()
			apiServer.chats.CloseAll()
			closeV2()
		})
	}
	// Cleanup is established before each acquisition below can make an error
	// return observable (bind/readiness/Serve included).
	defer cleanupAll()

	stateDir := cfg.StateDir
	if stateDir == "" {
		stateDir, err = store.StateDir()
	}
	if err == nil {
		var cursors *cursorstore.Store
		cursors, err = cursorstore.Open(filepath.Join(stateDir, "state-v2.json"))
		if err == nil {
			ensured, err = omorpc.EnsureDaemon(ctx, omorpc.EnsureConfig{WorkingDir: cfg.Root})
			if err == nil {
				v2Manager = v2session.NewManager(v2session.Config{Client: ensured.Client, Store: (*wsbridge.CursorStore)(cursors)})
				prepareChat := func(_ context.Context, wsID, chatID string) (uint64, error) {
					return apiServer.prepareV2ChatVersion(cursors, wsID, chatID)
				}
				v2Bridge = wsbridge.New(wsbridge.Config{
					Context: ctx, Manager: v2Manager, Store: cursors,
					ServerVersion: ensured.Client.ServerVersion(), Logger: logger,
					PrepareChatVersion: prepareChat, ChatVersion: apiServer.chatLifecycleVersion,
				})
				apiServer.installV2(v2Manager, cursors, v2Bridge)
			}
		}
	}
	if err != nil {
		logger.Error("v2 websocket bridge unavailable", "err", err)
		apiServer.installV2(nil, nil, wsbridge.Unavailable(err.Error()))
	}

	srv := &http.Server{
		Addr:              net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port)),
		Handler:           apiServer.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		<-ctx.Done()
		cleanupAll()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if shutdownErr := srv.Shutdown(shutdownCtx); shutdownErr != nil {
			logger.Error("graceful shutdown failed", "err", shutdownErr)
		}
	}()

	logger.Info("listening", "addr", srv.Addr, "root", cfg.Root)
	ln, err := net.Listen("tcp", srv.Addr)
	if err != nil {
		return fmt.Errorf("http server: %w", err)
	}
	if onReady != nil {
		if err := onReady(); err != nil {
			_ = ln.Close()
			return fmt.Errorf("daemon readiness: %w", err)
		}
	}
	serveErr := srv.Serve(ln)
	if serveErr != nil {
		cleanupAll()
		if !errors.Is(serveErr, http.ErrServerClosed) {
			return fmt.Errorf("http server: %w", serveErr)
		}
	}
	return nil
}
