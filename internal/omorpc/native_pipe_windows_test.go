//go:build windows

package omorpc

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	_ "unsafe" // test-only linknames into the compiler overlay, never shipped

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

// These variables only acquire callers in the temporary compiler overlay below.
// The installed module and production binary are never modified.
//
//go:linkname nativePipeObserve github.com/Microsoft/go-winio.omorpcPendingObserver
var nativePipeObserve func(uintptr, bool)

//go:linkname nativePipeCancel github.com/Microsoft/go-winio.omorpcCancelIO
var nativePipeCancel func(windows.Handle, *windows.Overlapped) error

func TestWindowsNativePendingIO(t *testing.T) {
	dir := t.TempDir()
	cmd := exec.CommandContext(t.Context(), "go", "list", "-f", "{{.Dir}}", "github.com/Microsoft/go-winio")
	output, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(strings.TrimSpace(string(output)), "file.go")
	original, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	patched := string(original)
	replace := func(old, new string, count int) {
		t.Helper()
		if strings.Count(patched, old) != count {
			t.Fatalf("go-winio observation boundary changed: expected %d matches", count)
		}
		patched = strings.ReplaceAll(patched, old, new)
	}
	replace("var ioInitOnce sync.Once", "var omorpcPendingObserver func(uintptr, bool)\nvar omorpcCancelIO = cancelIoEx\nvar ioInitOnce sync.Once", 1)
	// This branch can only be reached after ReadFile/WriteFile returned
	// ERROR_IO_PENDING. No pre-call signal, scheduling inference or pipe fake.
	replace("\tif f.closing.Load() {\n\t\t_ = cancelIoEx(f.handle, &c.o)", "\tif omorpcPendingObserver != nil { omorpcPendingObserver(uintptr(f.handle), d == &f.writeDeadline) }\n\tif f.closing.Load() {\n\t\t_ = cancelIoEx(f.handle, &c.o)", 1)
	replace("_ = cancelIoEx(f.handle,", "_ = omorpcCancelIO(f.handle,", 3)
	overlaySource := filepath.Join(dir, "file.go")
	if err := os.WriteFile(overlaySource, []byte(patched), 0600); err != nil {
		t.Fatal(err)
	}
	overlay, err := json.Marshal(map[string]any{"Replace": map[string]string{source: overlaySource}})
	if err != nil {
		t.Fatal(err)
	}
	overlayPath := filepath.Join(dir, "overlay.json")
	if err := os.WriteFile(overlayPath, overlay, 0600); err != nil {
		t.Fatal(err)
	}
	t.Logf("native observer: original SHA256=%x overlay SHA256=%x; exact replacements recorded in test source", sha256.Sum256(original), sha256.Sum256([]byte(patched)))
	exe := filepath.Join(dir, "native-pipe.test.exe")
	build := exec.CommandContext(t.Context(), "go", "test", "-c", "-overlay", overlayPath, "-o", exe, ".")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build native observer: %v\n%s", err, output)
	}
	for _, mode := range []string{"release-disabled", "restored"} {
		t.Run(mode, func(t *testing.T) {
			cmd := exec.CommandContext(t.Context(), exe, "-test.run=^TestWindowsNativePendingIOCases$", "-test.v", "-test.timeout=40s")
			cmd.Env = append(os.Environ(), "OMORPC_NATIVE_IO_MODE="+mode)
			output, err := cmd.CombinedOutput()
			t.Logf("native subprocess mode=%s exit=%v\n%s", mode, err, output)
			if mode == "restored" {
				if err != nil {
					t.Fatal("restored native I/O assertions failed")
				}
			} else {
				var exit *exec.ExitError
				if !errors.As(err, &exit) || exit.ExitCode() != 1 {
					t.Fatal("release-disabled control did not fail normally")
				}
				for _, name := range []string{"read_Close", "read_cancel", "write_deadline", "write_Close"} {
					if !strings.Contains(string(output), "PIPE_PENDING_RELEASE "+name) {
						t.Errorf("control did not fail pending release assertion for %s", name)
					}
				}
			}
			if strings.Count(string(output), "cleanup: pending native operation and caller joined") != 4 {
				t.Error("native caller cleanup receipt missing")
			}
		})
	}
	after, err := os.ReadFile(source)
	if err != nil || !bytes.Equal(original, after) {
		t.Fatal("compiler overlay modified installed dependency")
	}
	t.Log("cleanup: installed go-winio unchanged; overlay and child executable removed by TempDir cleanup")
}

type nativeSubscription struct {
	write   bool
	handle  uintptr // zero selects any client-end pipe (used before Dial returns)
	pending chan windows.Handle
}

func TestWindowsNativePendingIOCases(t *testing.T) {
	mode := os.Getenv("OMORPC_NATIVE_IO_MODE")
	if mode == "" {
		return
	} // subprocess entry, like the other Windows helpers
	var subscription atomic.Pointer[nativeSubscription]
	var disabledHandle atomic.Uintptr
	nativePipeObserve = func(h uintptr, write bool) {
		sub := subscription.Load()
		if sub == nil || sub.write != write || sub.handle != 0 && sub.handle != h {
			return
		}
		var flags uint32
		if err := windows.GetNamedPipeInfo(windows.Handle(h), &flags, nil, nil, nil); err != nil {
			return
		}
		if flags&windows.PIPE_SERVER_END != 0 {
			return
		}
		select {
		case sub.pending <- windows.Handle(h):
		default:
		}
	}
	nativePipeCancel = func(h windows.Handle, op *windows.Overlapped) error {
		if mode == "release-disabled" && uintptr(h) == disabledHandle.Load() {
			return nil
		}
		return windows.CancelIoEx(h, op)
	}
	for _, name := range []string{"read_Close", "read_cancel", "write_deadline", "write_Close"} {
		t.Run(name, func(t *testing.T) {
			write := strings.HasPrefix(name, "write_")
			path, release := nativeStalledPipe(t, write)
			var conn net.Conn
			var c *Client
			var token EpochToken
			if write {
				var err error
				c, err = DialWithConfig(t.Context(), path, Config{WriteTimeout: 30 * time.Second})
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() {
					if err := c.Close(); err != nil {
						t.Error(err)
					}
				})
				c.mu.Lock()
				ep := c.current
				c.mu.Unlock()
				conn = ep.conn
				token = EpochToken{epoch: ep}
			} else if name == "read_Close" {
				var err error
				conn, err = dialEndpoint(t.Context(), path)
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() {
					if err := conn.Close(); err != nil {
						t.Error(err)
					}
				})
			}
			sub := &nativeSubscription{write: write, pending: make(chan windows.Handle, 1)}
			if conn != nil {
				sub.handle = conn.(*identifiedPipe).Conn.(interface{ Fd() uintptr }).Fd()
			}
			subscription.Store(sub)
			defer subscription.Store(nil)
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			done := make(chan error, 1)
			go func() {
				var err error
				switch {
				case write:
					_, err = c.Call(ctx, ExtensionRequest{SessionID: "native", Name: "large", Data: json.RawMessage(`"` + strings.Repeat("x", 8<<20) + `"`)})
				case conn != nil:
					_, err = conn.Read(make([]byte, 1))
				default:
					var client *Client
					client, err = Dial(ctx, path)
					if client != nil {
						err = errors.Join(err, client.Close())
					}
				}
				done <- err
			}()
			var handle windows.Handle
			select {
			case handle = <-sub.pending:
			case <-time.After(5 * time.Second):
				t.Fatal("native ERROR_IO_PENDING not observed")
			}
			t.Logf("native: %s ReadFile/WriteFile returned ERROR_IO_PENDING; server remains stalled", name)
			disabledHandle.Store(uintptr(handle))
			var closed chan error
			switch name {
			case "read_cancel":
				cancel()
			case "write_deadline":
				if err := conn.SetWriteDeadline(time.Now()); err != nil {
					t.Fatal(err)
				}
			default:
				closed = make(chan error, 1)
				go func() { closed <- conn.Close() }()
			}
			completed := false
			select {
			case err := <-done:
				completed = true
				if write && !errors.Is(err, ErrDisconnected) {
					t.Errorf("failed write did not invalidate: %v", err)
				}
				if name == "read_Close" && !errors.Is(err, net.ErrClosed) {
					t.Errorf("pending read Close: %v", err)
				}
				if name == "read_cancel" && err == nil {
					t.Error("canceled Dial succeeded")
				}
			case <-time.After(2 * time.Second):
				t.Errorf("PIPE_PENDING_RELEASE %s", name)
			}
			// A failing negative control must still clean up. Bypass only the overlay's
			// disabled CancelIoEx, without allowing the peer to release the operation.
			if !completed {
				if err := windows.CancelIoEx(handle, nil); err != nil && !errors.Is(err, windows.ERROR_NOT_FOUND) {
					t.Error(err)
				}
				select {
				case <-done:
				case <-time.After(5 * time.Second):
					t.Fatal("native operation failed to join after control restoration")
				}
			}
			if closed != nil {
				select {
				case err := <-closed:
					if err != nil {
						t.Error(err)
					}
				case <-time.After(5 * time.Second):
					t.Fatal("Close worker not joined")
				}
			}
			disabledHandle.Store(0)
			t.Log("cleanup: pending native operation and caller joined")
			if write {
				if c.EpochCurrent(token) {
					t.Fatal("failed native write retained epoch")
				}
				select {
				case <-token.epoch.events.out:
				case <-time.After(5 * time.Second):
					t.Fatal("epoch event stream not closed")
				}
				release()
				response, err := c.Call(t.Context(), GetProtocolInfo{})
				if err != nil || response == nil || !response.Success {
					t.Fatalf("real pipe epoch recovery: %v", err)
				}
				t.Log("native: failed-write epoch invalidated; authenticated replacement epoch response correlated")
			}
		})
	}
}

// The first peer consumes authentication and optionally negotiation, then
// never reads again until release. Later connections use the normal protocol.
func nativeStalledPipe(t *testing.T, negotiate bool) (string, func()) {
	t.Helper()
	cfg := pipeEnsureConfig(t)
	if err := prepareEndpoint(t.Context(), cfg); err != nil {
		t.Fatal(err)
	}
	secret, err := os.ReadFile(cfg.SocketPath + ".secret")
	if err != nil {
		t.Fatal(err)
	}
	address, err := pipeAddress(cfg.SocketPath, secret)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := winio.ListenPipe(address, &winio.PipeConfig{InputBufferSize: 1024, OutputBufferSize: 1024})
	if err != nil {
		t.Fatal(err)
	}
	hold := make(chan struct{})
	var once sync.Once
	release := func() { once.Do(func() { close(hold) }) }
	var mu sync.Mutex
	var active net.Conn
	stopping := false
	done := make(chan struct{})
	t.Cleanup(func() {
		release()
		mu.Lock()
		stopping = true
		if active != nil {
			if err := active.Close(); err != nil {
				t.Error(err)
			}
		}
		mu.Unlock()
		if err := listener.Close(); err != nil {
			t.Error(err)
		}
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("native pipe fixture worker not joined")
		}
		t.Log("cleanup: native listener/peer handles closed and fixture worker joined")
	})
	go func() {
		defer close(done)
		first := true
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			mu.Lock()
			if stopping {
				mu.Unlock()
				conn.Close()
				return
			}
			active = conn
			mu.Unlock()
			if first {
				first = false
				got := make([]byte, socketSecretBytes)
				if _, err := io.ReadFull(conn, got); err != nil || !bytes.Equal(got, secret) {
					conn.Close()
					return
				}
				if negotiate {
					var req struct {
						ID   string `json:"id"`
						Type string `json:"type"`
					}
					if err := json.NewDecoder(conn).Decode(&req); err != nil {
						conn.Close()
						return
					}
					if err := json.NewEncoder(conn).Encode(map[string]any{"type": "response", "id": req.ID, "command": req.Type, "success": true, "data": ProtocolInfo{ProtocolVersion: 1}}); err != nil {
						conn.Close()
						return
					}
				}
				<-hold
				conn.Close()
			} else {
				serveProductionPipe(conn, secret)
			}
			mu.Lock()
			active = nil
			mu.Unlock()
		}
	}()
	return cfg.SocketPath, release
}
