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
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/auth"
	"github.com/DevNewbie1826/omo-webchat/internal/config"
	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	v2session "github.com/DevNewbie1826/omo-webchat/internal/session"
	"github.com/DevNewbie1826/omo-webchat/internal/store"
	"github.com/DevNewbie1826/omo-webchat/internal/wsbridge"
)

// Run initializes the store, session store, and HTTP server, then serves until
// ctx is cancelled.
func Run(ctx context.Context, cfg *config.Config, logger *slog.Logger, onReady func() error) error {
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

	// The v2 endpoint is optional at startup failure, but never inert: publish a
	// diagnostic 503 first, then replace it atomically after the independent
	// cursor/session stack is ready.
	removeV2 := wsbridge.InstallUnavailable("provider daemon initialization pending")
	var (
		v2Manager *v2session.Manager
		ensured   *omorpc.EnsuredDaemon
	)
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
				prepareChat := func(_ context.Context, wsID, chatID string) error {
					ws, lookupErr := st.GetWorkspace(wsID)
					if lookupErr != nil {
						return lookupErr
					}
					chat, lookupErr := st.GetChat(wsID, chatID)
					if lookupErr != nil {
						return lookupErr
					}
					if saveErr := cursors.SaveWorkspace(cursorstore.Workspace{ID: ws.ID, Name: ws.Name, Path: ws.Path}); saveErr != nil {
						return saveErr
					}
					cwd := chat.Cwd
					if cwd == "" {
						cwd = ws.Path
					}
					current, getErr := cursors.GetChat(chat.ID)
					if getErr == nil {
						current.WorkspaceID, current.CWD, current.Name = ws.ID, cwd, chat.Name
						return cursors.SaveChat(current)
					}
					return cursors.SaveChat(cursorstore.Chat{ID: chat.ID, WorkspaceID: ws.ID, CWD: cwd, Name: chat.Name, NameSource: cursorstore.NameSourceAuto, CreatedAt: chat.CreatedAt})
				}
				removeV2()
				removeV2 = wsbridge.InstallDefault(wsbridge.New(wsbridge.Config{
					Context: ctx, Manager: v2Manager, Store: cursors,
					ServerVersion: ensured.Client.ServerVersion(), Logger: logger, PrepareChat: prepareChat,
				}))
			}
		}
	}
	if err != nil {
		logger.Error("v2 websocket bridge unavailable", "err", err)
		removeV2()
		removeV2 = wsbridge.InstallUnavailable(err.Error())
	}

	srv := &http.Server{
		Addr:              net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port)),
		Handler:           apiServer.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		<-ctx.Done()
		// Settle and close logical provider sessions before the HTTP shutdown
		// returns. CloseAll marks shared-provider termination intentional, so a
		// normal server stop never leaks a synthetic pi_eof to clients.
		apiServer.chats.CloseAll()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if v2Manager != nil {
			if err := v2Manager.CloseAll(shutdownCtx); err != nil {
				logger.Error("closing v2 sessions", "err", err)
			}
		}
		removeV2()
		if ensured != nil {
			if err := ensured.Stop(shutdownCtx); err != nil {
				logger.Error("closing v2 provider client", "err", err)
			}
		}
		if err := srv.Shutdown(shutdownCtx); err != nil {
			logger.Error("graceful shutdown failed", "err", err)
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
	if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("http server: %w", err)
	}
	return nil
}
