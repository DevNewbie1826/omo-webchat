package api

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/config"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
)

func useMockEnsure(t *testing.T) {
	t.Helper()
	daemon := omorpctest.New(t.TempDir())
	if err := daemon.Start(); err != nil {
		t.Fatal(err)
	}
	old := ensureDaemon
	ensureDaemon = func(ctx context.Context, _ omorpc.EnsureConfig) (*omorpc.EnsuredDaemon, error) {
		client, err := omorpc.Dial(ctx, daemon.SocketPath())
		if err != nil {
			return nil, err
		}
		return &omorpc.EnsuredDaemon{Client: client}, nil
	}
	t.Cleanup(func() { ensureDaemon = old; daemon.Stop() })
}

func TestRunSignalsReadyAndShutsDown(t *testing.T) {
	useMockEnsure(t)
	t.Setenv("HOME", t.TempDir())
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ready := make(chan struct{})
	result := make(chan error, 1)
	cfg := &config.Config{
		Host:     "127.0.0.1",
		Port:     0,
		Password: "x",
		Root:     t.TempDir(),
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	go func() {
		result <- Run(ctx, cfg, logger, func() error {
			close(ready)
			return nil
		})
	}()

	select {
	case <-ready:
	case <-time.After(2 * time.Second):
		t.Fatal("Run() did not invoke onReady")
	}
	cancel()
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("Run() error = %v, want nil", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Run() did not stop after context cancellation")
	}
}

func TestRunDaemonFailureIsFatal(t *testing.T) {
	old := ensureDaemon
	ensureDaemon = func(context.Context, omorpc.EnsureConfig) (*omorpc.EnsuredDaemon, error) {
		return nil, errors.New("offline")
	}
	t.Cleanup(func() { ensureDaemon = old })
	err := Run(t.Context(), &config.Config{Root: t.TempDir()}, slog.New(slog.NewTextHandler(io.Discard, nil)), nil)
	if err == nil || !strings.Contains(err.Error(), "starting required omo daemon") {
		t.Fatalf("Run error = %v", err)
	}
}

func TestRunReturnsReadyError(t *testing.T) {
	useMockEnsure(t)
	t.Setenv("HOME", t.TempDir())
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cfg := &config.Config{
		Host:     "127.0.0.1",
		Port:     0,
		Password: "x",
		Root:     t.TempDir(),
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	want := errors.New("boom")
	err := Run(ctx, cfg, logger, func() error { return want })
	if !errors.Is(err, want) {
		t.Fatalf("Run() error = %v, want wrapped %v", err, want)
	}
}
