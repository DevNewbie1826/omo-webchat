package omorpc

import (
	"context"
	"errors"
	"io"
	"net"
	"testing"
	"testing/synctest"
	"time"
)

func TestFixtureListenerShutdown_cancelsPendingWake_whenWorkerCompletes(t *testing.T) {
	for _, tc := range []struct {
		name       string
		connection bool
		wakeErr    error
		wantErr    error
	}{
		{name: "cancellation", wakeErr: context.Canceled},
		{name: "late_connection", connection: true},
		{name: "genuine_error", wakeErr: net.ErrClosed, wantErr: net.ErrClosed},
		{name: "late_connection_with_error", connection: true, wakeErr: net.ErrClosed, wantErr: net.ErrClosed},
	} {
		t.Run(tc.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				// Given: wake is pending and cannot return until explicitly released.
				ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
				defer cancel()
				done := make(chan struct{})
				listener := newShutdownOrderListener(t, done)
				wakeEntered := make(chan struct{})
				wakeCanceled := make(chan struct{})
				releaseWake := make(chan struct{})
				result := make(chan error, 1)
				conn, peer := net.Pipe()
				t.Cleanup(func() {
					if err := errors.Join(conn.Close(), peer.Close()); err != nil {
						t.Error(err)
					}
				})
				shutdown := fixtureListenerShutdown{
					listener: listener,
					done:     done,
					wake: func(wakeCtx context.Context) (net.Conn, error) {
						close(wakeEntered)
						<-wakeCtx.Done()
						close(wakeCanceled)
						select {
						case <-releaseWake:
						case <-ctx.Done():
							return nil, ctx.Err()
						}
						if tc.connection {
							return &shutdownOrderWake{Conn: conn, workerDone: done}, tc.wakeErr
						}
						return nil, tc.wakeErr
					},
				}
				go func() {
					result <- shutdown.stop(ctx)
				}()
				select {
				case <-wakeEntered:
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}

				// When: the worker finishes independently of the pending wake.
				close(done)
				synctest.Wait()

				// Then: wake is canceled without expiring the parent, and joined.
				select {
				case <-wakeCanceled:
				default:
					t.Fatal("worker completion did not cancel the pending wake")
				}
				if err := ctx.Err(); err != nil {
					t.Fatalf("worker completion exhausted the parent context: %v", err)
				}
				select {
				case err := <-result:
					t.Fatalf("shutdown returned before the held wake completed: %v", err)
				default:
				}
				close(releaseWake)
				var err error
				select {
				case err = <-result:
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
				if tc.wantErr == nil {
					if err != nil {
						t.Fatalf("fixture shutdown: %v", err)
					}
				} else if !errors.Is(err, tc.wantErr) {
					t.Fatalf("fixture shutdown error = %v, want %v", err, tc.wantErr)
				}
				if err := ctx.Err(); err != nil {
					t.Fatalf("shutdown exhausted the parent context: %v", err)
				}
				if tc.connection {
					readResult := make(chan error, 1)
					go func() {
						var data [1]byte
						_, err := peer.Read(data[:])
						readResult <- err
					}()
					synctest.Wait()
					select {
					case err := <-readResult:
						if !errors.Is(err, io.EOF) {
							t.Fatalf("late wake peer read = %v, want EOF", err)
						}
					default:
						t.Fatal("shutdown left the late wake connection open")
					}
				}
			})
		})
	}
}

func TestFixtureListenerShutdown_preservesWakeError_whenWakeFails(t *testing.T) {
	for _, workerFinished := range []bool{false, true} {
		name := "worker_pending"
		if workerFinished {
			name = "worker_finished"
		}
		t.Run(name, func(t *testing.T) {
			// Given: wake fails independently of cancellation.
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			done := make(chan struct{})
			listener := newShutdownOrderListener(t, done)
			shutdown := fixtureListenerShutdown{
				listener: listener,
				done:     done,
				wake: func(context.Context) (net.Conn, error) {
					if workerFinished {
						close(done)
					}
					return nil, net.ErrClosed
				},
			}

			// When
			err := shutdown.stop(ctx)

			// Then: completion does not erase a genuine wake failure.
			if !errors.Is(err, net.ErrClosed) {
				t.Fatalf("fixture shutdown error = %v, want %v", err, net.ErrClosed)
			}
			if errors.Is(err, errFixtureListenerClosedBeforeWorker) {
				t.Fatalf("fixture shutdown closed a listener with an unfinished worker: %v", err)
			}
		})
	}
}
