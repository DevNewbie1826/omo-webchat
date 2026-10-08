package api

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func TestStopCurrentRetiresAdoptedDaemonWhenRetirerInstalled(t *testing.T) {
	foreignDaemon := newRunTestDaemon(t)
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
	foreignDaemon := newRunTestDaemon(t)
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
	foreignDaemon := newRunTestDaemon(t)
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
