package omorpc

import (
	"context"
	"errors"
	"fmt"
	"net"
)

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

	wake, wakeErr := s.wake(ctx)
	if wakeErr != nil {
		err = fmt.Errorf("wake fixture accept: %w", wakeErr)
		select {
		case <-s.done:
			return errors.Join(err, s.listener.Close())
		default:
			return err
		}
	}
	defer func() {
		err = errors.Join(err, wake.Close())
	}()

	select {
	case <-s.done:
		return s.listener.Close()
	case <-ctx.Done():
		return fmt.Errorf("join fixture worker: %w", ctx.Err())
	}
}
