//go:build windows

package omorpc

import (
	"context"
	"errors"
	"golang.org/x/sys/windows"
	"testing"
	"time"
)

// A level-1 oplock reports the conflicting native open but does not let it
// finish until we acknowledge the break by closing the fixture handle.
type secretOplock struct {
	h     windows.Handle
	event windows.Handle
	op    windows.Overlapped
}

func holdSecretOpen(t *testing.T, path string) *secretOplock {
	t.Helper()
	ptr, err := windows.UTF16PtrFromString(path + ".secret")
	if err != nil {
		t.Fatal(err)
	}
	h, err := windows.CreateFile(ptr, windows.GENERIC_READ, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OVERLAPPED, 0)
	if err != nil {
		t.Fatal(err)
	}
	event, err := windows.CreateEvent(nil, 1, 0, nil)
	if err != nil {
		windows.CloseHandle(h)
		t.Fatal(err)
	}
	f := &secretOplock{h: h, event: event}
	f.op.HEvent = event
	var n uint32
	const requestLevel1 = 0x00090000
	err = windows.DeviceIoControl(h, requestLevel1, nil, 0, nil, 0, &n, &f.op)
	if !errors.Is(err, windows.ERROR_IO_PENDING) {
		windows.CloseHandle(h)
		windows.CloseHandle(event)
		t.Fatalf("request native oplock: %v", err)
	}
	t.Cleanup(func() { f.close(t) })
	return f
}

func (f *secretOplock) close(t *testing.T) {
	t.Helper()
	if f.h == 0 {
		return
	}
	// Join the asynchronous oplock request before releasing its event/storage.
	if err := windows.CancelIoEx(f.h, &f.op); err != nil && !errors.Is(err, windows.ERROR_NOT_FOUND) {
		t.Error(err)
	}
	var n uint32
	if err := windows.GetOverlappedResult(f.h, &f.op, &n, true); err != nil && !errors.Is(err, windows.ERROR_OPERATION_ABORTED) {
		t.Error(err)
	}
	if err := windows.CloseHandle(f.h); err != nil {
		t.Error(err)
	}
	if err := windows.CloseHandle(f.event); err != nil {
		t.Error(err)
	}
	f.h = 0
	t.Log("cleanup: oplock request joined; file and event handles closed")
}

func (f *secretOplock) awaitBreak(t *testing.T) {
	t.Helper()
	state, err := windows.WaitForSingleObject(f.event, 5000)
	if err != nil || state != windows.WAIT_OBJECT_0 {
		t.Fatalf("native conflicting open not observed: state=%d error=%v", state, err)
	}
	t.Log("native: oplock break signaled; conflicting secret CreateFile pending; break not acknowledged")
}

func TestWindowsSecretOpenCancellation(t *testing.T) {
	for _, operation := range []string{"Dial", "Ensure", "reconnect_Close"} {
		t.Run(operation, func(t *testing.T) {
			cfg := pipeEnsureConfig(t)
			var c *Client
			if operation == "reconnect_Close" {
				cfg.SocketPath = productionPipeFixture(t)
				var err error
				c, err = Dial(t.Context(), cfg.SocketPath)
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() {
					if err := c.Close(); err != nil {
						t.Error(err)
					}
				})
				events := c.Events()
				c.mu.Lock()
				ep := c.current
				c.mu.Unlock()
				if err := ep.conn.Close(); err != nil {
					t.Fatal(err)
				}
				select {
				case <-events:
				case <-time.After(5 * time.Second):
					t.Fatal("epoch did not close")
				}
			} else if err := prepareEndpoint(cfg); err != nil {
				t.Fatal(err)
			}
			f := holdSecretOpen(t, cfg.SocketPath)
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			done := make(chan error, 1)
			go func() {
				var err error
				switch operation {
				case "Dial":
					var client *Client
					client, err = Dial(ctx, cfg.SocketPath)
					if client != nil {
						err = errors.Join(err, client.Close())
					}
				case "Ensure":
					var daemon *EnsuredDaemon
					daemon, err = EnsureDaemon(ctx, cfg)
					if daemon != nil {
						err = errors.Join(err, daemon.StopBounded(5*time.Second))
					}
				default:
					_, err = c.Call(ctx, GetProtocolInfo{})
				}
				done <- err
			}()
			f.awaitBreak(t)
			completion := done
			if c != nil {
				completion = make(chan error, 1)
				go func() { completion <- c.Close() }()
			} else {
				cancel()
			}
			completed := false
			select {
			case err := <-completion:
				completed = true
				if c == nil && !errors.Is(err, context.Canceled) {
					t.Errorf("canceled acquisition: %v", err)
				}
				if c != nil && err != nil {
					t.Error(err)
				}
				t.Log("native: caller returned while oplock break remains unacknowledged")
			case <-time.After(3 * time.Second):
				t.Error("pending native secret open was not canceled/joined while oplock held")
			}
			f.close(t)
			if !completed {
				select {
				case <-completion:
				case <-time.After(5 * time.Second):
					t.Fatal("caller failed to join after fixture release")
				}
			}
			if c != nil {
				cancel()
				select {
				case <-done:
				case <-time.After(5 * time.Second):
					t.Fatal("reconnect caller failed to join")
				}
			}
			t.Log("cleanup: all acquisition/reconnect callers joined")
		})
	}
}
