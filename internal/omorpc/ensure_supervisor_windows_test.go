//go:build windows

package omorpc

import (
	"context"
	"errors"
	"os/exec"
	"slices"
	"testing"
	"time"
)

type mockTrackedSupervisor struct {
	events          []string
	waitTreeGone    time.Duration
	waitTreeGoneErr error
}

func (m *mockTrackedSupervisor) TerminateTree() error {
	m.events = append(m.events, "terminate")
	return nil
}

func (m *mockTrackedSupervisor) WaitTreeGone(deadline time.Duration) error {
	m.events = append(m.events, "wait-tree-gone")
	m.waitTreeGone = deadline
	return m.waitTreeGoneErr
}

func (m *mockTrackedSupervisor) Close() error {
	m.events = append(m.events, "close")
	return nil
}

var teardownCallOrder = []string{"terminate", "wait-tree-gone", "close"}

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

func TestFinishSupervisorWaitLeavesCloseForTreeDrain(t *testing.T) {
	tracked := &mockTrackedSupervisor{}
	sentinel := errors.New("leader wait")
	handle := &supervisorHandle{tracked: tracked}

	if err := finishSupervisorWait(handle, sentinel); !errors.Is(err, sentinel) {
		t.Fatalf("finishSupervisorWait = %v, want leader wait error", err)
	}
	if len(tracked.events) != 0 {
		t.Fatalf("finishSupervisorWait called tracked process methods: %v", tracked.events)
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
	if !slices.Equal(tracked.events, teardownCallOrder) {
		t.Fatalf("teardown call order = %v, want %v", tracked.events, teardownCallOrder)
	}
	if tracked.waitTreeGone != time.Second {
		t.Fatalf("WaitTreeGone deadline = %v, want killWait %v", tracked.waitTreeGone, time.Second)
	}
}

func TestTerminateSupervisorPropagatesTreeDrainTimeout(t *testing.T) {
	drainTimeout := errors.New("tree drain deadline exceeded")
	tracked := &mockTrackedSupervisor{waitTreeGoneErr: drainTimeout}
	waitCh := make(chan error)
	close(waitCh)
	handle := &supervisorHandle{tracked: tracked}

	err := terminateSupervisor(context.Background(), handle, waitCh, time.Second, time.Second)
	if !errors.Is(err, drainTimeout) {
		t.Fatalf("terminateSupervisor = %v, want tree-drain timeout propagated", err)
	}
	// Close must still release the job handle after a failed drain so the
	// KILL_ON_JOB_CLOSE reaper cannot be skipped.
	if !slices.Equal(tracked.events, teardownCallOrder) {
		t.Fatalf("teardown call order = %v, want %v", tracked.events, teardownCallOrder)
	}
}
