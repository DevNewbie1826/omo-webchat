//go:build darwin || linux

package api

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/config"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
)

// Keep the real ensure/probe/spawn/ownership path. Only redirect its endpoint
// and supervisor arguments to the existing native test-binary daemon fixture.
// In particular, never replace Run's BinaryPath, WorkingDir, StateDir or hook.
func isolateRunBinaryEnsure(t *testing.T, dir string, observed chan<- *omorpc.EnsuredDaemon) {
	t.Helper()
	old := ensureDaemon
	ensureDaemon = func(ctx context.Context, cfg omorpc.EnsureConfig) (*omorpc.EnsuredDaemon, error) {
		cfg.AgentDir = dir
		cfg.SocketPath = filepath.Join(dir, "d.sock")
		cfg.ArgsTemplate = []string{"-test.run=^TestRunOwnedDaemonHelper$"}
		cfg.Env = append(slices.Clone(cfg.Env), "OMO_API_RUN_HELPER_DIR="+dir)
		daemon, err := omorpc.EnsureDaemon(ctx, cfg)
		if err == nil {
			// Run owns normal teardown. This also reaps a helper if an assertion
			// aborts the readiness callback before Run completes.
			t.Cleanup(func() {
				if err := daemon.StopBounded(daemonStopTimeout); err != nil {
					t.Errorf("cleanup ensured daemon: %v", err)
				}
			})
			observed <- daemon
		}
		return daemon, err
	}
	t.Cleanup(func() { ensureDaemon = old })
}

func runBinaryFixture(t *testing.T) (string, string) {
	t.Helper()
	// Short paths are required by macOS Unix-domain sockets.
	dir, err := os.MkdirTemp("", "api-binary-*")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(dir); err != nil {
			t.Errorf("remove fixture directory: %v", err)
		}
	})
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"omo", "custom supervisor"} {
		if err := os.Symlink(executable, filepath.Join(dir, name)); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", dir)
	t.Setenv("OMO_CODING_AGENT_DIR", dir)
	t.Setenv("OMO_RUNTIME", "automatic")
	return dir, filepath.Join(dir, "custom supervisor")
}

func TestRunBinarySelectionStartupAndReconnect(t *testing.T) {
	for _, tc := range []struct {
		name     string
		override bool
		unset    bool
		recover  bool
	}{
		{name: "unset uses PATH on startup and reconnect", unset: true, recover: true},
		{name: "empty uses PATH on startup and reconnect", recover: true},
		{name: "explicit override survives reconnect", override: true, recover: true},
		{name: "explicit override starts owned daemon", override: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir, custom := runBinaryFixture(t)
			wantBinary := ""
			if tc.override {
				wantBinary = custom
				// A valid PATH default exists, but is deliberately not the override.
			}
			t.Setenv("CHAT_PI_BINARY", wantBinary)
			if tc.unset {
				if err := os.Unsetenv("CHAT_PI_BINARY"); err != nil {
					t.Fatal(err)
				}
			}
			var shared *omorpctest.Daemon
			if tc.recover {
				shared = omorpctest.New(dir)
				if err := shared.Start(); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(shared.Stop)
			}
			observed := make(chan *omorpc.EnsuredDaemon, 2)
			isolateRunBinaryEnsure(t, dir, observed)
			realEnsure := ensureDaemon
			configs := make(chan omorpc.EnsureConfig, 2)
			ensureDaemon = func(ctx context.Context, cfg omorpc.EnsureConfig) (*omorpc.EnsuredDaemon, error) {
				configs <- cfg
				return realEnsure(ctx, cfg)
			}
			cfg := &config.Config{Host: "127.0.0.1", Root: t.TempDir(), StateDir: t.TempDir(), Password: "test"}
			checkConfig := func() error {
				got := <-configs
				if got.BinaryPath != wantBinary {
					return fmt.Errorf("Run -> EnsureDaemon BinaryPath = %q, want %q", got.BinaryPath, wantBinary)
				}
				if got.WorkingDir != cfg.Root || got.StateDir != cfg.StateDir || !slices.Contains(got.Env, "PATH="+dir) || got.OnDialNotExist == nil {
					return errors.New("Run did not preserve working directory, state, environment or reconnect hook")
				}
				return nil
			}
			finished := errors.New("test readiness complete")
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			err := Run(ctx, cfg, slog.New(slog.NewTextHandler(io.Discard, nil)), func() error {
				if err := checkConfig(); err != nil {
					return err
				}
				initial := <-observed
				if initial.Owned == tc.recover {
					return fmt.Errorf("startup Owned = %v, want %v", initial.Owned, !tc.recover)
				}
				if tc.recover {
					// Subscribe before removing the endpoint. A protocol roundtrip on
					// the actual Run client must invoke Run's recovery hook and spawn.
					_, events := initial.Client.CurrentEpoch()
					shared.Stop()
					select {
					case _, ok := <-events:
						if ok {
							return errors.New("expected epoch stream closure")
						}
					case <-ctx.Done():
						return ctx.Err()
					}
					if _, err := os.Stat(shared.SocketPath()); !errors.Is(err, os.ErrNotExist) {
						return fmt.Errorf("missing-socket precondition: %v", err)
					}
					resp, err := initial.Client.Call(ctx, omorpc.GetProtocolInfo{})
					if err != nil {
						return fmt.Errorf("reconnect protocol roundtrip: %w", err)
					}
					if !resp.Success {
						return errors.New("reconnect protocol roundtrip failed")
					}
					if err := checkConfig(); err != nil {
						return err
					}
					if recovery := <-observed; !recovery.Owned {
						return errors.New("recovery did not own the spawned daemon")
					}
				}
				return finished
			})
			if !errors.Is(err, finished) {
				t.Fatalf("Run: %v", err)
			}
			assertOwnedRecoveryStopped(t, filepath.Join(dir, "pid"))
			if _, err := os.Stat(filepath.Join(dir, "d.sock")); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("owned socket remains after Run cleanup: %v", err)
			}
		})
	}
}

func TestRunInvalidBinaryOverrideDoesNotFallBack(t *testing.T) {
	dir, _ := runBinaryFixture(t)
	t.Setenv("CHAT_PI_BINARY", filepath.Join(dir, "missing supervisor"))
	isolateRunBinaryEnsure(t, dir, make(chan *omorpc.EnsuredDaemon, 1))
	ready := false
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	err := Run(ctx, &config.Config{Host: "127.0.0.1", Root: t.TempDir(), StateDir: t.TempDir()}, slog.New(slog.NewTextHandler(io.Discard, nil)), func() error {
		ready = true
		return errors.New("unexpected startup through PATH fallback")
	})
	if ready || !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("invalid explicit override: ready=%v, err=%v; want missing-executable failure before readiness", ready, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "pid")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("invalid override launched the PATH supervisor: %v", err)
	}
}
