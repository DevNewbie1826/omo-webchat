package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/auth"
	"github.com/DevNewbie1826/omo-webchat/internal/config"
	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
	"github.com/DevNewbie1826/omo-webchat/internal/wsbridge"
)

var ensureDaemon = omorpc.EnsureDaemon

// Run requires the omo daemon, opens the cursor metadata store, performs the
// read-only v1 import, and serves the sole v2 stack until ctx is cancelled.
func Run(ctx context.Context, cfg *config.Config, logger *slog.Logger, onReady func() error) error {
	ctx, cancelRun := context.WithCancel(ctx)
	defer cancelRun()
	stateDir := cfg.StateDir
	var err error
	if stateDir == "" {
		stateDir, err = cursorstore.StateDir()
		if err != nil {
			return fmt.Errorf("resolving state directory: %w", err)
		}
	}
	ensured, err := ensureDaemon(ctx, omorpc.EnsureConfig{
		WorkingDir: cfg.Root,
		StateDir:   stateDir,
		Env:        os.Environ(),
	})
	if err != nil {
		return fmt.Errorf("starting required omo daemon: %w", err)
	}
	var stopDaemonOnce sync.Once
	stopDaemon := func() {
		stopDaemonOnce.Do(func() {
			if e := ensured.StopBounded(5 * time.Second); e != nil {
				logger.Error("closing provider client", "err", e)
			}
		})
	}
	// Install owned-process teardown immediately: every failure after ensure,
	// including metadata initialization, must terminate a spawned supervisor.
	defer stopDaemon()
	cursors, err := cursorstore.Open(filepath.Join(stateDir, "state-v2.json"))
	if err != nil {
		return fmt.Errorf("opening cursor store: %w", err)
	}
	summary, err := cursorstore.MigrateV1FromStateDir(stateDir, cfg.StateDir == "", cursors)
	if err != nil {
		return fmt.Errorf("migrating v1 metadata: %w", err)
	}
	logger.Info("v1 metadata migration complete", "workspaces", summary.Workspaces, "chats", summary.Chats, "skipped", summary.Skipped)
	manager := session.NewManager(session.Config{Client: ensured.Client, Store: (*wsbridge.CursorStore)(cursors)})
	var apiServer *Server
	bridge := wsbridge.New(wsbridge.Config{Context: ctx, Manager: manager, Store: cursors, ServerVersion: ensured.Client.ServerVersion(), Logger: logger,
		PrepareChatVersion: func(c context.Context, wsID, chatID string) (uint64, error) {
			return apiServer.prepareChatVersion(c, wsID, chatID)
		},
		ChatVersion: func(id string) uint64 { return apiServer.chatLifecycleVersion(id) }})
	sessions := auth.NewSessionStore(ctx, cfg.Password, logger)
	apiServer = New(ctx, cfg, cursors, sessions, manager, bridge, logger)

	var cleanup sync.Once
	cleanupAll := func() {
		cleanup.Do(func() {
			cancelRun()
			bridge.CloseConnections()
			managerCtx, cancelManager := context.WithTimeout(context.Background(), 5*time.Second)
			if e := manager.CloseAll(managerCtx); e != nil {
				logger.Error("closing sessions", "err", e)
			}
			cancelManager()
			stopDaemon()
		})
	}
	defer cleanupAll()
	srv := &http.Server{Addr: net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port)), Handler: apiServer.Handler(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		cleanupAll()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if e := srv.Shutdown(shutdownCtx); e != nil {
			logger.Error("graceful shutdown failed", "err", e)
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
	if err = srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("http server: %w", err)
	}
	return nil
}
