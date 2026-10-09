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

	// retireUnowned stops an engine this server holds no supervisor for, so a
	// restart still works after the server was replaced or a successor was
	// adopted. nil keeps the strict ErrDaemonNotOwned refusal.
	retireUnowned func(ctx context.Context) error
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
	var stopErr error
	if current == nil || !current.Owned {
		if l.retireUnowned == nil {
			return omorpc.EpochToken{}, omorpc.ErrDaemonNotOwned
		}
		if err := l.retireUnowned(ctx); err != nil {
			if !omorpc.RetirementConfirmed(err) {
				if errors.Is(err, omorpc.ErrRetirementUnconfirmed) {
					l.mu.Lock()
					l.retirementErr = err
					l.mu.Unlock()
				}
				return omorpc.EpochToken{}, err
			}
			stopErr = err
		}
	}

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
	budget, err := omorpc.RestartBudget(runEnsureConfig(&config.Config{}, ""))
	if err != nil {
		return func(context.Context) (string, string, error) { return "", "", err }
	}
	restart := engineRestarterWithBudget(lifecycle, client, budget)
	return func(ctx context.Context) (string, string, error) {
		before, after, _, err := restart(ctx)
		return before, after, err
	}
}

var errEngineRestartNotReady = errors.New("engine did not become ready in time")

func engineRestarterWithBudget(lifecycle *recoveryDaemonLifecycle, client *omorpc.Client, budget time.Duration) func(context.Context) (string, string, <-chan struct{}, error) {
	return func(ctx context.Context) (string, string, <-chan struct{}, error) {
		// Bound the caller across admission, retirement and successor negotiation.
		// Retirement keeps its barrier and bounded cleanup after this caller
		// leaves; the shared reconnect flight keeps its own lifecycle.
		waitCtx, cancel := context.WithDeadlineCause(ctx, time.Now().Add(budget), errEngineRestartNotReady)
		defer cancel()
		before := client.ServerVersion()
		type restartResult struct {
			after string
			err   error
		}
		// A late result never blocks its worker or touches an HTTP response.
		done := make(chan restartResult, 1)
		finished := make(chan struct{})
		go func() {
			retired, err := lifecycle.stopCurrent(context.WithoutCancel(ctx), client)
			if err == nil {
				// The spawn barrier is released before joining recovery.
				err = client.EnsureConnectedAfter(waitCtx, retired)
			}
			if err == nil && !lifecycle.currentOwned() {
				err = omorpc.ErrDaemonNotOwned
			}
			after := ""
			if err == nil {
				after = client.ServerVersion()
			}
			close(finished)
			done <- restartResult{after: after, err: err}
		}()
		select {
		case <-waitCtx.Done():
			return before, "", finished, context.Cause(waitCtx)
		case result := <-done:
			if waitCtx.Err() != nil {
				return before, "", finished, context.Cause(waitCtx)
			}
			return before, result.after, finished, result.err
		}
	}
}

func runEnsureConfig(cfg *config.Config, stateDir string) omorpc.EnsureConfig {
	return omorpc.EnsureConfig{
		BinaryPath:   os.Getenv("CHAT_PI_BINARY"),
		WorkingDir:   cfg.Root,
		StateDir:     stateDir,
		Env:          os.Environ(),
		ReadyTimeout: 17 * time.Second,
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
	ensureCfg := runEnsureConfig(cfg, stateDir)
	restartBudget, err := omorpc.RestartBudget(ensureCfg)
	if err != nil {
		return fmt.Errorf("calculating engine restart budget: %w", err)
	}
	if _, err := omorpc.SocketPathFor(ensureCfg); err == nil {
		recoveryDaemons.retireUnowned = func(ctx context.Context) error {
			return omorpc.RetireUnownedEngine(ctx, ensureCfg)
		}
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
	manager := session.NewManager(session.Config{
		Client: ensured.Client, Store: (*wsbridge.CursorStore)(cursors), NoticeDir: filepath.Join(cursors.StateDir(), "notices"),
		DialAttach: func(ctx context.Context) (*omorpc.Client, error) {
			return omorpc.DialWithConfig(ctx, ensured.Client.SocketPath(), omorpc.Config{NoReconnect: true, EventBuffer: 1024})
		},
	})
	var apiServer *Server
	bridge := wsbridge.New(wsbridge.Config{Context: ctx, Manager: manager, Store: cursors, SendQueue: queue, ServerVersionFunc: ensured.Client.ServerVersion, Logger: logger,
		PrepareChatVersion: func(c context.Context, wsID, chatID string) (uint64, error) {
			return apiServer.prepareChatVersion(c, wsID, chatID)
		},
		ChatVersion: func(id string) uint64 { return apiServer.chatLifecycleVersion(id) }})
	sessions := auth.NewSessionStore(ctx, cfg.Password, logger)
	apiServer = New(ctx, cfg, cursors, sessions, manager, bridge, logger)
	stopWatcher := apiServer.startRPCWatcher(ensured.Client)
	defer stopWatcher()
	apiServer.queue = queue
	// The restart sequence never calls Stop: closing the shared client is
	// terminal for every chat. Owned supervisor groups are stopped; an engine
	// serving this server's socket is also retired by process group when its
	// stable handshaken peer passes the process identity checks. Every stop
	// confirms the retiring group is gone before a successor may spawn on the
	// same client. Restart refuses with ErrDaemonNotOwned if the successor is
	// not owned by this server.
	apiServer.restartEngine = engineRestarterWithBudget(&recoveryDaemons, ensured.Client, restartBudget)

	var cleanup sync.Once
	cleanupAll := func() {
		cleanup.Do(func() {
			cancelRun()
			stopWatcher()
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
