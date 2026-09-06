package omorpc

import (
	"context"
	"errors"
	"fmt"
	"net"
)

var errFixtureWorkerCompleted = errors.New("fixture worker completed")

// Shared only by the Windows pipe fixture and its real TCP shutdown regression.
type fixtureListenerShutdown struct {
	listener net.Listener
	done     <-chan struct{}
	wake     func(context.Context) (net.Conn, error)
}

func (s fixtureListenerShutdown) stop(ctx context.Context) (err error) {
	select {
	case <-s.done:
		return s.listener.Close()
	default:
	}

	wakeCtx, cancelWake := context.WithCancelCause(ctx)
	defer cancelWake(nil)
	var wake net.Conn
	var wakeErr error
	wakeReturned := make(chan struct{})
	go func() {
		wake, wakeErr = s.wake(wakeCtx)
		close(wakeReturned)
	}()
	select {
	case <-wakeReturned:
	case <-s.done:
		cancelWake(errFixtureWorkerCompleted)
		<-wakeReturned
	}
	if wake != nil {
		defer func() {
			err = errors.Join(err, wake.Close())
		}()
	}
	if errors.Is(wakeErr, context.Canceled) &&
		errors.Is(context.Cause(wakeCtx), errFixtureWorkerCompleted) {
		wakeErr = nil
	}
	if wakeErr != nil {
		err = fmt.Errorf("wake fixture accept: %w", wakeErr)
		select {
		case <-s.done:
			return errors.Join(err, s.listener.Close())
		default:
			return err
		}
	}
	select {
	case <-s.done:
		return s.listener.Close()
	case <-ctx.Done():
		return fmt.Errorf("join fixture worker: %w", ctx.Err())
	}
}
