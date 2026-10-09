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
	wantErr := errors.Join(omorpc.ErrRetirementUnconfirmed, errors.New("unowned group retirement unconfirmed"))
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

func TestStopCurrentRefusedUnownedRetirementAllowsRecovery(t *testing.T) {
	// Given: the unsupported-platform callback refuses without signaling.
	lifecycle := recoveryDaemonLifecycle{
		retireUnowned: func(context.Context) error { return omorpc.ErrDaemonNotOwned },
	}
	adopted := &omorpc.EnsuredDaemon{}
	lifecycle.initialize(adopted)

	// When: restart refuses, then the adopted endpoint disappears.
	if _, err := lifecycle.stopCurrent(t.Context(), nil); !errors.Is(err, omorpc.ErrDaemonNotOwned) {
		t.Fatalf("unsupported retirement = %v, want ErrDaemonNotOwned", err)
	}
	entered := false
	probeErr := errors.New("missing endpoint ensure entered")
	err := lifecycle.ensure(t.Context(), func(context.Context) (*omorpc.EnsuredDaemon, error) {
		entered = true
		return nil, probeErr
	})

	// Then: recovery enters its real lifecycle ensure boundary, not the fence.
	if !entered || !errors.Is(err, probeErr) {
		t.Fatalf("recovery after no-signal refusal: ensure entered=%v error=%v, want entered and probe error", entered, err)
	}
	lifecycle.mu.Lock()
	defer lifecycle.mu.Unlock()
	if lifecycle.retirementErr != nil || lifecycle.current != adopted {
		t.Fatal("no-signal refusal changed retirement state")
	}
	t.Log("unsupported-platform refusal preserved missing-endpoint ensure admission")
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

func TestEngineRestartBoundsStalledSuccessorNegotiation(t *testing.T) {
	for _, tc := range []struct {
		name          string
		callerTimeout time.Duration
		wantStatus    int
		wantErr       error
		waitLimit     time.Duration
	}{
		{"restart-budget", 5 * time.Second, http.StatusInternalServerError, errEngineRestartNotReady, 2 * time.Second},
		{"earlier-caller-deadline", time.Second, http.StatusGatewayTimeout, context.DeadlineExceeded, time.Second},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// Given: readiness succeeds on the real RPC socket; only the shared
			// client's subsequent negotiation is held behind an explicit gate.
			const budget = 2 * time.Second
			const slack = 500 * time.Millisecond
			daemon := newRetireTestDaemon(t)
			var release func()
			var releaseMu sync.Mutex
			releaseNegotiation := func() {
				releaseMu.Lock()
				defer releaseMu.Unlock()
				if release != nil {
					release()
				}
			}
			lifecycle := recoveryDaemonLifecycle{
				logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
				retireUnowned: func(context.Context) error {
					daemon.Stop()
					return nil
				},
			}
			client, err := omorpc.DialWithConfig(t.Context(), daemon.SocketPath(), omorpc.Config{
				OnDialNotExist: func(ctx context.Context) error {
					return lifecycle.ensure(ctx, func(ctx context.Context) (*omorpc.EnsuredDaemon, error) {
						daemon.SetServerVersion("budget-successor")
						if err := daemon.Start(); err != nil {
							return nil, err
						}
						probe, err := omorpc.Dial(ctx, daemon.SocketPath())
						if err != nil {
							return nil, err
						}
						releaseMu.Lock()
						release = daemon.BlockHandler("get_protocol_info")
						releaseMu.Unlock()
						return &omorpc.EnsuredDaemon{Client: probe, Owned: true}, nil
					})
				},
			})
			if err != nil {
				t.Fatal(err)
			}
			defer func() {
				releaseNegotiation()
				if err := client.Close(); err != nil {
					t.Error(err)
				}
				daemon.Stop()
				t.Log("cleanup: negotiation gate released, shared client joined, RPC listener closed")
			}()
			lifecycle.initialize(&omorpc.EnsuredDaemon{Client: client})
			s, _, _ := newChatCreateTestServer(t)
			callerCtx, cancelCaller := context.WithTimeout(t.Context(), tc.callerTimeout)
			defer cancelCaller()
			s.ctx = callerCtx
			restart := engineRestarterWithBudget(&lifecycle, client, budget)
			returned := make(chan error, 1)
			s.restartEngine = func(ctx context.Context) (string, string, error) {
				before, after, err := restart(ctx)
				returned <- err
				return before, after, err
			}
			server := httptest.NewServer(s.Handler())
			defer func() {
				cancelCaller()
				releaseNegotiation()
				server.Close()
				t.Logf("cleanup: HTTP listener %s closed and handlers joined", server.URL)
			}()
			token, err := s.sessions.Create(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			requestCtx, cancelRequest := context.WithTimeout(t.Context(), 8*time.Second)
			defer cancelRequest()
			request, err := http.NewRequestWithContext(requestCtx, http.MethodPost, server.URL+"/api/system/engine/restart", strings.NewReader("{}"))
			if err != nil {
				t.Fatal(err)
			}
			request.Header.Set("Content-Type", "application/json")
			request.AddCookie(&http.Cookie{Name: auth.CookieName, Value: token})
			t.Logf("HTTP scenario: POST %s Content-Type=application/json Cookie=authenticated body={}; PASS=status%d within %s+%s, then shared flight completes after release", request.URL, tc.wantStatus, tc.waitLimit, slack)

			// When: the request feed is installed before triggering the real HTTP
			// call; its third handshake proves the readiness/negotiation branch.
			type responseResult struct {
				response *http.Response
				err      error
			}
			done := make(chan responseResult, 1)
			started := time.Now()
			go func() {
				response, err := server.Client().Do(request)
				done <- responseResult{response: response, err: err}
			}()
			reached := daemon.AwaitRequestCount("get_protocol_info", 3, 5*time.Second)
			got := <-done
			elapsed := time.Since(started)
			if got.err != nil {
				t.Fatal(got.err)
			}
			defer got.response.Body.Close()
			capture, err := httputil.DumpResponse(got.response, true)
			if err != nil {
				t.Fatal(err)
			}
			t.Logf("successor readiness and stalled shared handshake reached=%v; elapsed=%s; response:\n%s", reached, elapsed, capture)
			if !reached {
				t.Fatal("successor shared negotiation gate was not reached")
			}

			// Then: the restart returns on its own budget (or earlier parent),
			// without cancelling the shared reconnect flight.
			if got.response.StatusCode != tc.wantStatus || elapsed > tc.waitLimit+slack {
				t.Errorf("restart timing/status: got HTTP%d in %s, want HTTP%d within %s", got.response.StatusCode, elapsed, tc.wantStatus, tc.waitLimit+slack)
			}
			if err := <-returned; !errors.Is(err, tc.wantErr) {
				t.Errorf("restart error = %v, want %v", err, tc.wantErr)
			}
			releaseNegotiation()
			lateCtx, cancelLate := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancelLate()
			if err := client.EnsureConnected(lateCtx); err != nil {
				t.Fatal(err)
			}
			if !lifecycle.currentOwned() || client.ServerVersion() != "budget-successor" {
				t.Fatal("the background flight did not negotiate the owned successor after release")
			}
			t.Log("shared flight completed after HTTP response: owned=true version=budget-successor")
		})
	}
}
