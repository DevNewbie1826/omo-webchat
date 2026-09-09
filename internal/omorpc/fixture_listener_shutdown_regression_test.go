package omorpc

import (
	"context"
	"errors"
	"net"
	"sync"
	"testing"
	"time"
)

var errFixtureListenerClosedBeforeWorker = errors.New("listener closed before fixture worker quiesced")
var errFixtureWakeClosedBeforeWorker = errors.New("wake connection closed before fixture worker quiesced")

type shutdownOrderListener struct {
	net.Listener
	workerDone    <-chan struct{}
	acceptEntered chan struct{}
	acceptOnce    sync.Once
}

func (l *shutdownOrderListener) Accept() (net.Conn, error) {
	l.acceptOnce.Do(func() { close(l.acceptEntered) })
	return l.Listener.Accept()
}

func (l *shutdownOrderListener) Close() error {
	var orderErr error
	select {
	case <-l.workerDone:
	default:
		orderErr = errFixtureListenerClosedBeforeWorker
	}
	// Close the actual listener even on RED so the Accept worker is released.
	return errors.Join(orderErr, l.Listener.Close())
}

type shutdownOrderWake struct {
	net.Conn
	workerDone <-chan struct{}
}

func (c *shutdownOrderWake) Close() error {
	var orderErr error
	select {
	case <-c.workerDone:
	default:
		orderErr = errFixtureWakeClosedBeforeWorker
	}
	return errors.Join(orderErr, c.Conn.Close())
}

func newShutdownOrderListener(t *testing.T, done <-chan struct{}) *shutdownOrderListener {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := listener.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
			t.Error(err)
		}
	})
	return &shutdownOrderListener{
		Listener:      listener,
		workerDone:    done,
		acceptEntered: make(chan struct{}),
	}
}

func TestFixtureListenerShutdown_joinsWorkerBeforeClose_whenAcceptPending(t *testing.T) {
	// Given: a real TCP Accept worker that cannot finish before wake or close.
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	done := make(chan struct{})
	listener := newShutdownOrderListener(t, done)
	workerResult := make(chan error, 1)
	go func() {
		defer close(done)
		conn, err := listener.Accept()
		if err != nil {
			workerResult <- err
			return
		}
		workerResult <- conn.Close()
	}()
	select {
	case <-listener.acceptEntered:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	shutdown := fixtureListenerShutdown{
		listener: listener,
		done:     done,
		wake: func(ctx context.Context) (net.Conn, error) {
			var dialer net.Dialer
			conn, err := dialer.DialContext(ctx, "tcp", listener.Addr().String())
			if err != nil {
				return nil, err
			}
			return &shutdownOrderWake{Conn: conn, workerDone: done}, nil
		},
	}

	// When: the same shutdown seam used by the Windows fixture runs.
	err := shutdown.stop(ctx)

	// Then: both listener and wake close only after the worker has quiesced.
	if err != nil {
		t.Fatalf("fixture shutdown: %v", err)
	}
	select {
	case err := <-workerResult:
		if err != nil {
			t.Fatalf("worker did not accept the real wake connection: %v", err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}

func TestFixtureListenerShutdown_closesListenerWithoutWake_whenWorkerFinished(t *testing.T) {
	// Given: the worker has already exited while the real listener is open.
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	done := make(chan struct{})
	close(done)
	listener := newShutdownOrderListener(t, done)
	shutdown := fixtureListenerShutdown{
		listener: listener,
		done:     done,
		wake: func(context.Context) (net.Conn, error) {
			t.Error("finished worker must not require a wake connection")
			return nil, net.ErrClosed
		},
	}

	// When
	err := shutdown.stop(ctx)

	// Then
	if err != nil {
		t.Fatalf("fixture shutdown: %v", err)
	}
}
