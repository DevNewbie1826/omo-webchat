//go:build darwin || linux

package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/auth"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func TestSystemEngineRestartTimeoutKeepsInstallationExcluded(t *testing.T) {
	// Given: real owned retirement holds its live process group behind a gate.
	cfg, pidPath := ownedRecoveryEnsureConfig(t)
	owned, err := omorpc.EnsureDaemon(t.Context(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := owned.StopBounded(daemonStopTimeout); err != nil {
			t.Error(err)
		}
	}()
	if !owned.Owned {
		t.Fatal("initial supervisor not owned")
	}
	raw, err := os.ReadFile(pidPath)
	if err != nil {
		t.Fatal(err)
	}
	var pid int
	if _, err := fmt.Sscanf(string(raw), "%d", &pid); err != nil {
		t.Fatal(err)
	}
	lifecycle := recoveryDaemonLifecycle{}
	lifecycle.initialize(owned)
	schedule := newRestartSchedule(t)
	defer schedule.close()
	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	cleaned := make(chan error, 1)
	oldStop := stopSupervisorDaemon
	stopSupervisorDaemon = func(d *omorpc.EnsuredDaemon, ctx context.Context) error {
		close(entered)
		if err := schedule.gate(ctx, release); err != nil {
			cleaned <- err
			return err
		}
		err := oldStop(d, ctx)
		cleaned <- err
		return err
	}
	defer func() { stopSupervisorDaemon = oldStop }()
	s, _, _ := newChatCreateTestServer(t)
	restart := engineRestarterWithBudget(&lifecycle, owned.Client, 500*time.Millisecond)
	completion := make(chan (<-chan struct{}), 1)
	s.restartEngine = func(ctx context.Context) (string, string, <-chan struct{}, error) {
		before, after, finished, err := restart(ctx)
		completion <- finished
		return before, after, finished, err
	}
	var finished <-chan struct{}
	var updates atomic.Int32
	s.updateInstallation = func(context.Context) error { updates.Add(1); return nil }
	server := httptest.NewServer(s.Handler())
	defer server.Close()
	defer func() {
		unblock()
		if err := awaitRestartResult(t, cleaned); err != nil {
			t.Error(err)
		}
		if finished != nil {
			awaitRestartSignal(t, finished, "restart worker did not finish during cleanup")
		}
		if err := lifecycle.ensure(schedule.ctx, func(context.Context) (*omorpc.EnsuredDaemon, error) {
			return nil, nil
		}); err != nil {
			t.Error(err)
		}
		t.Logf("cleanup: retirement gate released, old group %d drained, barrier joined; HTTP listener %s closes on return", pid, server.URL)
	}()
	token, err := s.sessions.Create(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	post := func(path string) (int, string, time.Duration) {
		t.Helper()
		ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
		defer cancel()
		request, err := http.NewRequestWithContext(ctx, http.MethodPost, server.URL+path, strings.NewReader("{}"))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Content-Type", "application/json")
		request.AddCookie(&http.Cookie{Name: auth.CookieName, Value: token})
		t.Logf("HTTP scenario: POST %s Content-Type=application/json Cookie=authenticated body={}", request.URL)
		started := time.Now()
		response, err := server.Client().Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		capture, err := httputil.DumpResponse(response, true)
		if err != nil {
			t.Fatal(err)
		}
		elapsed := time.Since(started)
		t.Logf("elapsed=%s; response:\n%s", elapsed, capture)
		return response.StatusCode, string(capture), elapsed
	}

	// When: the caller's budget expires without releasing owned retirement.
	t.Log("PASS=restart500 within2s while gated; update409/installer0 and second restart409; release/join then update200/installer1")
	status, body, elapsed := post("/api/system/engine/restart")
	finished = <-completion
	awaitRestartSignal(t, entered, "retirement gate not entered")
	if status != http.StatusInternalServerError || !strings.Contains(body, errEngineRestartNotReady.Error()) || elapsed > 2*time.Second {
		t.Fatalf("restart status=%d elapsed=%s, want500 not-ready within2s", status, elapsed)
	}
	if err := syscall.Kill(-pid, 0); err != nil {
		t.Fatalf("old group not live at gate: %v", err)
	}

	// Then: adjacent installation and restart stay excluded until completion.
	updateStatus, _, _ := post("/api/system/update")
	select {
	case <-release:
		t.Fatal("retirement gate released before update observation")
	default:
	}
	t.Logf("retirement gate held=true oldGroup=%d live=true installerCalls=%d updateHTTP=%d", pid, updates.Load(), updateStatus)
	if updateStatus != http.StatusConflict || updates.Load() != 0 {
		t.Fatalf("installation overlapped unfinished restart: update HTTP%d installerCalls=%d while old retirement gated", updateStatus, updates.Load())
	}
	secondStatus, _, _ := post("/api/system/engine/restart")
	if secondStatus != http.StatusConflict {
		t.Fatalf("second restart HTTP%d while retirement gated, want409", secondStatus)
	}
	unblock()
	awaitRestartSignal(t, finished, "restart worker did not finish after gate release")
	if err := lifecycle.ensure(schedule.ctx, func(context.Context) (*omorpc.EnsuredDaemon, error) {
		return nil, nil
	}); err != nil {
		t.Fatal(err)
	}
	unlocked := make(chan struct{})
	schedule.start(func() {
		s.updateMu.Lock()
		s.updateMu.Unlock()
		close(unlocked)
	})
	awaitRestartSignal(t, unlocked, "installation exclusion not released after restart completion")
	if err := syscall.Kill(-pid, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("cleanup old group %d: %v", pid, err)
	}
	updateStatus, _, _ = post("/api/system/update")
	if updateStatus != http.StatusOK || updates.Load() != 1 {
		t.Fatalf("installation not admitted after completion: HTTP%d installerCalls=%d, want200 and1", updateStatus, updates.Load())
	}
}
