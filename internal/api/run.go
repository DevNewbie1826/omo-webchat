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
	"slices"
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

var (
	ensureDaemon         = omorpc.EnsureDaemon
	stopSupervisorDaemon = (*omorpc.EnsuredDaemon).StopSupervisor
)

const daemonStopTimeout = 5 * time.Second

type recoveryDaemonLifecycle struct {
	// barrier covers the complete ensure/publication operation and the complete
	// retiring-generation stop/fence operation. State mu remains separate so
	// shutdown can mark itself while an ensure is in flight.
	barrier sync.Mutex
	mu      sync.Mutex

	// admissionContended is a test observer, installed before lifecycle use.
	// It reports a failed TryLock, never merely arrival before admission.
	admissionContended func(operation string)

	current       *omorpc.EnsuredDaemon
	generation    []*omorpc.EnsuredDaemon
	owned         []*omorpc.EnsuredDaemon
	stopping      bool
	retirementErr error
	logger        *slog.Logger
}

func (l *recoveryDaemonLifecycle) initialize(daemon *omorpc.EnsuredDaemon) {
	l.mu.Lock()
	l.current = daemon
	if daemon != nil && daemon.Owned {
		l.generation = append(l.generation, daemon)
	}
	l.mu.Unlock()
}

func (l *recoveryDaemonLifecycle) lockAdmission(operation string) {
	if l.admissionContended != nil {
		if l.barrier.TryLock() {
			return
		}
		l.admissionContended(operation)
	}
	l.barrier.Lock()
}

func (l *recoveryDaemonLifecycle) ensure(ctx context.Context, fn func(context.Context) (*omorpc.EnsuredDaemon, error)) error {
	l.lockAdmission("ensure")
	defer l.barrier.Unlock()
	l.mu.Lock()
	retirementErr := l.retirementErr
	l.mu.Unlock()
	if retirementErr != nil {
		return retirementErr
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	daemon, err := fn(ctx)
	if err != nil {
		return err
	}
	l.retainLocked(daemon)
	return nil
}

func (l *recoveryDaemonLifecycle) retain(daemon *omorpc.EnsuredDaemon) {
	l.lockAdmission("retain")
	defer l.barrier.Unlock()
	l.retainLocked(daemon)
}

func (l *recoveryDaemonLifecycle) retainLocked(daemon *omorpc.EnsuredDaemon) {
	if daemon == nil {
		return
	}
	// This client only proved readiness. The shared client remains open while
	// the ownership handle is retained for replacement and final teardown.
	_ = daemon.Close()
	l.mu.Lock()
	if !l.stopping {
		l.current = daemon
		if daemon.Owned {
			l.generation = append(l.generation, daemon)
			l.owned = append(l.owned, daemon)
		}
		l.mu.Unlock()
		return
	}
	l.mu.Unlock()
	if daemon.Owned {
		l.stopDaemon(daemon)
	}
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

// stopCurrent joins any recovery already holding barrier, validates ownership
// of the current ensured endpoint, and keeps further spawning excluded until
// all retiring groups, endpoint cleanup, runtime-cache invalidation, and the
// exact transport fence have completed.
func (l *recoveryDaemonLifecycle) stopCurrent(ctx context.Context, client *omorpc.Client) (omorpc.EpochToken, error) {
	l.lockAdmission("stopCurrent")
	defer l.barrier.Unlock()

	l.mu.Lock()
	current := l.current
	generation := slices.Clone(l.generation)
	l.mu.Unlock()
	if current == nil || !current.Owned {
		return omorpc.EpochToken{}, omorpc.ErrDaemonNotOwned
	}

	var stopErr error
	var unresolved error
	for _, daemon := range generation {
		if err := stopSupervisorDaemon(daemon, ctx); err != nil {
			stopErr = errors.Join(stopErr, err)
			if !omorpc.RetirementConfirmed(err) {
				unresolved = errors.Join(unresolved, err)
			}
		}
	}
	if unresolved != nil {
		l.mu.Lock()
		l.retirementErr = unresolved
		l.mu.Unlock()
		return omorpc.EpochToken{}, stopErr
	}
	retired := client.FenceConnectionGeneration()
	l.mu.Lock()
	l.current = nil
	l.generation = nil
	l.retirementErr = nil
	l.mu.Unlock()
	return retired, stopErr
}

func (l *recoveryDaemonLifecycle) currentOwned() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.current != nil && l.current.Owned
}

func (l *recoveryDaemonLifecycle) stopDaemon(daemon *omorpc.EnsuredDaemon) {
	if err := daemon.StopBounded(daemonStopTimeout); err != nil {
		l.logger.Error("stopping recovery daemon", "err", err)
	}
}

func engineRestarter(lifecycle *recoveryDaemonLifecycle, client *omorpc.Client) func(context.Context) (string, string, error) {
	return func(ctx context.Context) (string, string, error) {
		before := client.ServerVersion()
		retired, err := lifecycle.stopCurrent(ctx, client)
		if err != nil {
			return before, "", err
		}
		// stopCurrent releases the spawn barrier before this wait. A reconnect
		// flight may therefore run its own ensure hook without deadlocking behind
		// the restart that is waiting for it.
		if err := client.EnsureConnectedAfter(ctx, retired); err != nil {
			return before, "", err
		}
		if !lifecycle.currentOwned() {
			return before, "", omorpc.ErrDaemonNotOwned
		}
		return before, client.ServerVersion(), nil
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
		BinaryPath: os.Getenv("CHAT_PI_BINARY"),
		WorkingDir: cfg.Root,
		StateDir:   stateDir,
		Env:        os.Environ(),
	}
	// The long-lived client re-runs this ensure step when a reconnect dials a
	// missing socket path, so a vanished socket file recovers without a
	// server restart.
	ensureCfg.OnDialNotExist = func(ctx context.Context) error {
		return recoveryDaemons.ensure(ctx, func(ctx context.Context) (*omorpc.EnsuredDaemon, error) {
			return ensureDaemon(ctx, ensureCfg)
		})
	}
	ensured, err := ensureDaemon(ctx, ensureCfg)
	if err != nil {
		return fmt.Errorf("starting required omo daemon: %w", err)
	}
	recoveryDaemons.initialize(ensured)
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
	bridge := wsbridge.New(wsbridge.Config{Context: ctx, Manager: manager, Store: cursors, SendQueue: queue, ServerVersionFunc: ensured.Client.ServerVersion, Logger: logger,
		PrepareChatVersion: func(c context.Context, wsID, chatID string) (uint64, error) {
			return apiServer.prepareChatVersion(c, wsID, chatID)
		},
		ChatVersion: func(id string) uint64 { return apiServer.chatLifecycleVersion(id) }})
	sessions := auth.NewSessionStore(ctx, cfg.Password, logger)
	apiServer = New(ctx, cfg, cursors, sessions, manager, bridge, logger)
	apiServer.queue = queue
	// The restart sequence never calls Stop: closing the shared client is
	// terminal for every chat. StopSupervisor only terminates the owned
	// supervisor process groups, so the reconnect hook can spawn a successor
	// engine and re-establish the transport on the same client. The ensured
	// handle is checked first: a foreign engine must be refused before any
	// signal is sent, and every stop confirms its process group is gone
	// before a successor may spawn.
	apiServer.restartEngine = engineRestarter(&recoveryDaemons, ensured.Client)

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
	ln, err := net.Listen("tcp", srv.Addr)
	if err != nil {
		return fmt.Errorf("http server: %w", err)
	}
	logger.Info("listening", "addr", ln.Addr().String(), "root", cfg.Root)
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
