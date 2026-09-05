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
	"github.com/DevNewbie1826/omo-webchat/internal/sendqueue"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
	"github.com/DevNewbie1826/omo-webchat/internal/wsbridge"
)

var ensureDaemon = omorpc.EnsureDaemon

const daemonStopTimeout = 5 * time.Second

type recoveryDaemonLifecycle struct {
	mu       sync.Mutex
	owned    []*omorpc.EnsuredDaemon
	stopping bool
	logger   *slog.Logger
}

func (l *recoveryDaemonLifecycle) retain(daemon *omorpc.EnsuredDaemon) {
	if daemon == nil {
		return
	}
	if !daemon.Owned {
		_ = daemon.Close()
		return
	}

	// The ensure client is only a readiness probe. Retain the ownership handle
	// after closing it so teardown can still stop the process it spawned.
	_ = daemon.Close()
	l.mu.Lock()
	if !l.stopping {
		l.owned = append(l.owned, daemon)
		l.mu.Unlock()
		return
	}
	l.mu.Unlock()
	l.stopDaemon(daemon)
}

func (l *recoveryDaemonLifecycle) stop() {
	l.mu.Lock()
	l.stopping = true
	owned := l.owned
	l.owned = nil
	l.mu.Unlock()

	for _, daemon := range owned {
		l.stopDaemon(daemon)
	}
}

func (l *recoveryDaemonLifecycle) stopDaemon(daemon *omorpc.EnsuredDaemon) {
	if err := daemon.StopBounded(daemonStopTimeout); err != nil {
		l.logger.Error("stopping recovery daemon", "err", err)
	}
}

// Run requires the omo daemon, opens the cursor metadata store, and serves
// the sole v2 stack until ctx is cancelled.
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
	recoveryDaemons := recoveryDaemonLifecycle{logger: logger}
	ensureCfg := omorpc.EnsureConfig{
		WorkingDir: cfg.Root,
		StateDir:   stateDir,
		Env:        os.Environ(),
	}
	// The long-lived client re-runs this ensure step when a reconnect dials a
	// missing socket path, so a vanished socket file recovers without a
	// server restart.
	ensureCfg.OnDialNotExist = func(ctx context.Context) error {
		again, err := ensureDaemon(ctx, ensureCfg)
		if err != nil {
			return err
		}
		recoveryDaemons.retain(again)
		return nil
	}
	ensured, err := ensureDaemon(ctx, ensureCfg)
	if err != nil {
		return fmt.Errorf("starting required omo daemon: %w", err)
	}
	var stopDaemonOnce sync.Once
	stopDaemon := func() {
		stopDaemonOnce.Do(func() {
			if e := ensured.StopBounded(daemonStopTimeout); e != nil {
				logger.Error("closing provider client", "err", e)
			}
		})
	}
	// Install owned-process teardown immediately: every failure after ensure,
	// including metadata initialization, must terminate a spawned supervisor.
	defer stopDaemon()
	defer recoveryDaemons.stop()
	cursors, err := cursorstore.Open(filepath.Join(stateDir, "state-v2.json"))
	if err != nil {
		return fmt.Errorf("opening cursor store: %w", err)
	}
	queue, err := sendqueue.Load(filepath.Join(stateDir, "queue-v1.json"))
	if err != nil {
		return fmt.Errorf("opening send queue: %w", err)
	}
	manager := session.NewManager(session.Config{Client: ensured.Client, Store: (*wsbridge.CursorStore)(cursors)})
	var apiServer *Server
	bridge := wsbridge.New(wsbridge.Config{Context: ctx, Manager: manager, Store: cursors, SendQueue: queue, ServerVersion: ensured.Client.ServerVersion(), Logger: logger,
		PrepareChatVersion: func(c context.Context, wsID, chatID string) (uint64, error) {
			return apiServer.prepareChatVersion(c, wsID, chatID)
		},
		ChatVersion: func(id string) uint64 { return apiServer.chatLifecycleVersion(id) }})
	sessions := auth.NewSessionStore(ctx, cfg.Password, logger)
	apiServer = New(ctx, cfg, cursors, sessions, manager, bridge, logger)
	apiServer.queue = queue

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
			recoveryDaemons.stop()
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
