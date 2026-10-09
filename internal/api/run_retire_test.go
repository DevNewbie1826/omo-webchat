package api

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/auth"
	"github.com/DevNewbie1826/omo-webchat/internal/config"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
)

func newRetireTestDaemon(t *testing.T) *omorpctest.Daemon {
	t.Helper()
	dir, err := os.MkdirTemp("", "api-retire-*")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	daemon := omorpctest.New(dir)
	if err := daemon.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(daemon.Stop)
	return daemon
}

func TestStopCurrentRetiresAdoptedDaemonWhenRetirerInstalled(t *testing.T) {
	foreignDaemon := newRetireTestDaemon(t)
	foreign, err := omorpc.Dial(t.Context(), foreignDaemon.SocketPath())
	if err != nil {
		t.Fatalf("dial adopted daemon: %v", err)
	}
	t.Cleanup(func() { _ = foreign.Close() })
	retired := 0
	lifecycle := recoveryDaemonLifecycle{
		logger:        slog.New(slog.NewTextHandler(io.Discard, nil)),
		retireUnowned: func(context.Context) error { retired++; return nil },
	}
	lifecycle.initialize(&omorpc.EnsuredDaemon{Client: foreign})

	if _, err := lifecycle.stopCurrent(t.Context(), foreign); err != nil {
		t.Fatalf("stopCurrent on adopted daemon = %v, want nil", err)
	}
	if retired != 1 {
		t.Fatalf("retireUnowned calls = %d, want 1", retired)
	}
	if lifecycle.current != nil {
		t.Fatal("stopCurrent kept the retired adopted daemon as current")
	}
}

func TestStopCurrentReportsAdoptedDaemonRetirementFailure(t *testing.T) {
	foreignDaemon := newRetireTestDaemon(t)
	foreign, err := omorpc.Dial(t.Context(), foreignDaemon.SocketPath())
	if err != nil {
		t.Fatalf("dial adopted daemon: %v", err)
	}
	t.Cleanup(func() { _ = foreign.Close() })
	retireErr := errors.New("engine did not exit")
	adopted := &omorpc.EnsuredDaemon{Client: foreign}
	lifecycle := recoveryDaemonLifecycle{
		logger:        slog.New(slog.NewTextHandler(io.Discard, nil)),
		retireUnowned: func(context.Context) error { return retireErr },
	}
	lifecycle.initialize(adopted)

	if _, err := lifecycle.stopCurrent(t.Context(), foreign); !errors.Is(err, retireErr) {
		t.Fatalf("stopCurrent = %v, want retirement failure", err)
	}
	if lifecycle.current != adopted {
		t.Fatal("failed retirement must keep the adopted daemon as current")
	}
}

func TestStopCurrentWithoutCurrentDaemonRetiresEndpoint(t *testing.T) {
	retired := 0
	lifecycle := recoveryDaemonLifecycle{
		logger:        slog.New(slog.NewTextHandler(io.Discard, nil)),
		retireUnowned: func(context.Context) error { retired++; return nil },
	}
	foreignDaemon := newRetireTestDaemon(t)
	client, err := omorpc.Dial(t.Context(), foreignDaemon.SocketPath())
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })

	if _, err := lifecycle.stopCurrent(t.Context(), client); err != nil {
		t.Fatalf("stopCurrent with no current daemon = %v, want nil", err)
	}
	if retired != 1 {
		t.Fatalf("retireUnowned calls = %d, want 1", retired)
	}
}

func TestEngineRestartRefusesUnownedSuccessor(t *testing.T) {
	daemon := newRetireTestDaemon(t)
	var retired atomic.Int32
	var published atomic.Int32
	lifecycle := recoveryDaemonLifecycle{
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		retireUnowned: func(context.Context) error {
			retired.Add(1)
			daemon.Stop()
			return nil
		},
	}
	client, err := omorpc.DialWithConfig(t.Context(), daemon.SocketPath(), omorpc.Config{
		OnDialNotExist: func(ctx context.Context) error {
			return lifecycle.ensure(ctx, func(ctx context.Context) (*omorpc.EnsuredDaemon, error) {
				daemon.SetServerVersion("successor-version")
				if err := daemon.Start(); err != nil {
					return nil, err
				}
				successor, err := omorpc.Dial(ctx, daemon.SocketPath())
				if err != nil {
					return nil, err
				}
				published.Add(1)
				return &omorpc.EnsuredDaemon{Client: successor}, nil
			})
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	lifecycle.initialize(&omorpc.EnsuredDaemon{Client: client})
	s, _, _ := newChatCreateTestServer(t)
	returned := make(chan error, 1)
	restart := engineRestarter(&lifecycle, client)
	s.restartEngine = func(ctx context.Context) (string, string, error) {
		before, after, err := restart(ctx)
		returned <- err
		return before, after, err
	}
	server := httptest.NewServer(s.Handler())
	t.Cleanup(server.Close)
	token, err := s.sessions.Create(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequestWithContext(t.Context(), http.MethodPost, server.URL+"/api/system/engine/restart", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.AddCookie(&http.Cookie{Name: auth.CookieName, Value: token})

	t.Logf("HTTP scenario: POST %s body={} authenticated; PASS=409 and ErrDaemonNotOwned after successor negotiation", request.URL)
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	capture, err := httputil.DumpResponse(response, true)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("POST /api/system/engine/restart response:\n%s", capture)
	if err := <-returned; !errors.Is(err, omorpc.ErrDaemonNotOwned) {
		t.Fatalf("restart after unowned successor = %v, want ErrDaemonNotOwned", err)
	}
	if response.StatusCode != http.StatusConflict {
		t.Fatalf("unowned successor HTTP status = %d, want 409", response.StatusCode)
	}
	if retired.Load() != 1 || published.Load() != 1 || lifecycle.currentOwned() {
		t.Fatalf("branch not reached: retired=%d published=%d owned=%v", retired.Load(), published.Load(), lifecycle.currentOwned())
	}
	if client.ServerVersion() != "successor-version" {
		t.Fatal("restart refused before negotiating the successor")
	}
}

func TestStopCurrentUnconfirmedUnownedRetirementRejectsRecovery(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	var workers sync.WaitGroup
	defer func() { cancel(); workers.Wait() }()
	await := func(ch <-chan struct{}, message string) {
		t.Helper()
		select {
		case <-ch:
		case <-ctx.Done():
			t.Fatal(message)
		}
	}
	result := func(ch <-chan error) error {
		t.Helper()
		select {
		case err := <-ch:
			return err
		case <-ctx.Done():
			t.Fatal("unowned retirement operation did not finish")
			return ctx.Err()
		}
	}
	stopEntered := make(chan struct{})
	releaseStop := make(chan struct{})
	wantErr := errors.New("unowned group retirement unconfirmed")
	lifecycle := recoveryDaemonLifecycle{
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		retireUnowned: func(ctx context.Context) error {
			close(stopEntered)
			select {
			case <-releaseStop:
				return wantErr
			case <-ctx.Done():
				return ctx.Err()
			}
		},
	}
	lifecycle.initialize(&omorpc.EnsuredDaemon{})
	contended := make(chan struct{})
	lifecycle.admissionContended = func(operation string) {
		if operation == "ensure" {
			close(contended)
		}
	}
	stopped := make(chan error, 1)
	workers.Add(1)
	go func() {
		defer workers.Done()
		_, err := lifecycle.stopCurrent(ctx, nil)
		stopped <- err
	}()
	await(stopEntered, "unowned retirement did not enter failure gate")
	spawned := make(chan struct{})
	recovered := make(chan error, 1)
	workers.Add(1)
	go func() {
		defer workers.Done()
		recovered <- lifecycle.ensure(ctx, func(context.Context) (*omorpc.EnsuredDaemon, error) {
			close(spawned)
			return nil, nil
		})
	}()
	await(contended, "recovery did not contend on unowned retirement")
	close(releaseStop)
	if err := result(stopped); !errors.Is(err, wantErr) {
		t.Fatalf("unowned stopCurrent = %v, want unconfirmed retirement", err)
	}
	if err := result(recovered); !errors.Is(err, wantErr) {
		t.Fatalf("recovery admission = %v, want preserved unowned retirement error", err)
	}
	select {
	case <-spawned:
		t.Fatal("recovery spawned beside an unconfirmed unowned group")
	default:
	}
}

func TestRestartBudgetProductionEnsureConfig(t *testing.T) {
	cfg := runEnsureConfig(&config.Config{Root: t.TempDir()}, t.TempDir())
	budget, err := omorpc.RestartBudget(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("ReadyTimeout=%s RestartBudget=%s HTTPTimeout=%s margin=%s", cfg.ReadyTimeout, budget, engineRestartTimeout, engineRestartTimeout-budget)
	if budget+15*time.Second > engineRestartTimeout {
		t.Fatalf("production restart budget %s + 15s exceeds HTTP limit %s (ReadyTimeout=%s)", budget, engineRestartTimeout, cfg.ReadyTimeout)
	}
}
