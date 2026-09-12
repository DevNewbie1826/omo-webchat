package omorpc

import (
	"context"
	"errors"
)

// ErrDaemonNotOwned reports that this server has no supervisor process domain
// it may terminate for the ensured engine.
var ErrDaemonNotOwned = errors.New("omorpc: engine was not started by this server")

type supervisorStopError struct {
	err       error
	confirmed bool
}

func (e *supervisorStopError) Error() string { return e.err.Error() }
func (e *supervisorStopError) Unwrap() error { return e.err }

// RetirementConfirmed reports whether a failed stop nevertheless completed
// process-group termination and endpoint cleanup. Unknown errors are treated
// as unconfirmed so callers never admit a successor on ambiguous teardown.
func RetirementConfirmed(err error) bool {
	if err == nil {
		return true
	}
	var stopErr *supervisorStopError
	return errors.As(err, &stopErr) && stopErr.confirmed
}

// StopSupervisor terminates an engine supervisor started by this server while
// leaving the shared RPC client open for reconnection to a successor engine.
func (d *EnsuredDaemon) StopSupervisor(ctx context.Context) error {
	if d == nil || !d.Owned || d.supervisor == nil {
		return ErrDaemonNotOwned
	}
	err := d.stopSupervisor(ctx)
	if err == nil {
		ForgetRuntimeWinner(d.command)
		return nil
	}
	// The stop operation owns its bounded process-group teardown after it
	// starts. Join it even when the caller's budget expires so a lifecycle
	// barrier can never admit a successor while descendants still live or
	// endpoint cleanup is pending.
	joinErr := d.stopSupervisor(context.Background())
	confirmed := joinErr == nil
	if joinErr != nil {
		err = errors.Join(err, joinErr)
	} else {
		ForgetRuntimeWinner(d.command)
	}
	return &supervisorStopError{err: err, confirmed: confirmed}
}

func (d *EnsuredDaemon) stopSupervisor(ctx context.Context) error {
	d.supervisorStopOnce.Do(func() {
		d.supervisorStopDone = make(chan struct{})
		go func() {
			defer close(d.supervisorStopDone)
			d.supervisorStopErr = stopOwnedSupervisor(context.Background(), d.supervisor, d.waitCh)
		}()
	})
	select {
	case <-d.supervisorStopDone:
		return d.supervisorStopErr
	case <-ctx.Done():
		return ctx.Err()
	}
}
