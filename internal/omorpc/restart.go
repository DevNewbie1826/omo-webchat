package omorpc

import (
	"context"
	"errors"
)

// ErrDaemonNotOwned reports that this server has no supervisor process domain
// it may terminate for the ensured engine.
var ErrDaemonNotOwned = errors.New("omorpc: engine was not started by this server")

// StopSupervisor terminates an engine supervisor started by this server while
// leaving the shared RPC client open for reconnection to a successor engine.
func (d *EnsuredDaemon) StopSupervisor(ctx context.Context) error {
	if d == nil || !d.Owned || d.supervisor == nil {
		return ErrDaemonNotOwned
	}
	err := d.stopSupervisor(ctx)
	ForgetRuntimeWinner(d.command)
	return err
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
