//go:build windows

package omorpc

import (
	"context"
	"errors"
	"os/exec"
	"testing"
	"time"
)

type mockTrackedSupervisor struct {
	terminated bool
	closed     bool
}

func (m *mockTrackedSupervisor) TerminateTree() error {
	m.terminated = true
	return nil
}

func (m *mockTrackedSupervisor) Close() error {
	m.closed = true
	return nil
}

func TestStartSupervisorUsesTrackedProcess(t *testing.T) {
	original := startTrackedSupervisor
	t.Cleanup(func() { startTrackedSupervisor = original })
	called := false
	sentinel := errors.New("tracked start")
	startTrackedSupervisor = func(*exec.Cmd) (trackedSupervisor, error) {
		called = true
		return nil, sentinel
	}

	if handle, err := startSupervisor(exec.Command("unused")); handle != nil || !errors.Is(err, sentinel) {
		t.Fatalf("startSupervisor = (%v, %v), want tracked-start error", handle, err)
	}
	if !called {
		t.Fatal("startSupervisor did not use procexec tracked-start seam")
	}
}

func TestTerminateSupervisorTerminatesTrackedTree(t *testing.T) {
	tracked := &mockTrackedSupervisor{}
	waitCh := make(chan error)
	close(waitCh)
	handle := &supervisorHandle{tracked: tracked}

	if err := terminateSupervisor(context.Background(), handle, waitCh, time.Second, time.Second); err != nil {
		t.Fatalf("terminateSupervisor: %v", err)
	}
	if !tracked.terminated {
		t.Fatal("terminateSupervisor did not call TrackedProcess.TerminateTree")
	}
	if !tracked.closed {
		t.Fatal("terminateSupervisor did not release tracked process")
	}
}
