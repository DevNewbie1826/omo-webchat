package session

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest/transport"
)

type enrolledHarness struct {
	t      *testing.T
	d      *omorpctest.Daemon
	main   *omorpc.Client
	owner  *omorpc.Client
	m      *Manager
	store  *memCursorStore
	chat   testChat
	opened omorpc.OpenSessionData
}

func newEnrolledHarness(t *testing.T) *enrolledHarness {
	t.Helper()
	d := newDaemon(t)
	d.EnableAttachmentScope()
	main := dial(t, d)
	owner := dial(t, d)
	chat := testChat{id: "enrolled-guard", cwd: t.TempDir()}
	resp, err := owner.Call(t.Context(), omorpc.OpenSession{CWD: chat.cwd})
	mustOK(t, err)
	var opened omorpc.OpenSessionData
	mustOK(t, json.Unmarshal(resp.Data, &opened))
	d.MarkRetained(opened.State.SessionFile)
	store := newMemStore()
	mustOK(t, store.SaveCursor(t.Context(), chat.id, Cursor{
		SessionFile: opened.State.SessionFile, DurableSessionID: opened.State.SessionID,
		AutoEnrolled: true, InPlace: true,
	}))
	m := NewManager(Config{
		Client: main, Store: store, QueueSize: 64, IdleAfter: time.Hour,
		DialAttach: func(ctx context.Context) (*omorpc.Client, error) {
			return omorpc.DialWithConfig(ctx, d.SocketPath(), omorpc.Config{NoReconnect: true, EventBuffer: 1024})
		},
	})
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
		defer cancel()
		if err := m.CloseAll(ctx); err != nil {
			t.Errorf("enrolled manager cleanup: %v", err)
		}
	})
	return &enrolledHarness{t: t, d: d, main: main, owner: owner, m: m, store: store, chat: chat, opened: opened}
}

func (h *enrolledHarness) attach() (*Session, *recorder, func()) {
	h.t.Helper()
	r := newRecorder(128)
	s, created, detach, err := h.m.Acquire(h.t.Context(), h.chat, r)
	mustOK(h.t, err)
	h.t.Cleanup(detach)
	if !created || !s.enrolledAttached || s.client == h.main || s.epoch == (omorpc.EpochToken{}) {
		h.t.Fatalf("dedicated attach not established: created=%v session=%+v", created, s)
	}
	if h.d.Attachments(h.opened.State.SessionFile) != 2 {
		h.t.Fatalf("attachments=%d, want external + dedicated", h.d.Attachments(h.opened.State.SessionFile))
	}
	return s, r, detach
}

func (h *enrolledHarness) assertDetached() {
	h.t.Helper()
	if got := h.d.RequestCount(omorpc.CmdCloseSession); got != 0 {
		h.t.Fatalf("webchat sent %d close_session requests, want 0", got)
	}
	if !h.d.AwaitAttachments(h.opened.State.SessionFile, 1, testTimeout) {
		h.t.Fatalf("attachments did not return to owner baseline: got %d, want 1", h.d.Attachments(h.opened.State.SessionFile))
	}
	ctx, cancel := context.WithTimeout(h.t.Context(), testTimeout)
	defer cancel()
	if _, err := h.owner.Call(ctx, omorpc.GetState{SessionID: h.opened.SessionID}); err != nil {
		h.t.Fatalf("external retained session ended: %v", err)
	}
	h.m.mu.Lock()
	registered := len(h.m.attachClients)
	h.m.mu.Unlock()
	if registered != 0 {
		h.t.Fatalf("dedicated epoch registry leaked %d clients", registered)
	}
	h.t.Log("zero webchat close_session; retained owner live; attachments back to 1; registry empty")
}

func (h *enrolledHarness) stream(r *recorder, text string) {
	h.t.Helper()
	h.d.EmitSession(h.opened.State.SessionFile, map[string]any{"type": "message_delta", "delta": text})
	_, frame := r.await(h.t, FrameMessageDelta)
	payload, _ := frame.Data.(map[string]any)
	if payload["delta"] != text {
		h.t.Fatalf("stream delta=%v, want %q", frame.Data, text)
	}
}

type enrolledAcquireResult struct {
	s      *Session
	detach func()
	err    error
}

// Expiry is released explicitly after the real open response is held. This
// exercises DeadlineExceeded without racing a wall-clock timer against dial.
type enrolledExpiryContext struct {
	context.Context
	expired chan struct{}
}

func (c *enrolledExpiryContext) Done() <-chan struct{} { return c.expired }
func (c *enrolledExpiryContext) Err() error {
	select {
	case <-c.expired:
		return context.DeadlineExceeded
	default:
		return nil
	}
}

func awaitEnrolledAcquire(t *testing.T, done <-chan enrolledAcquireResult) enrolledAcquireResult {
	t.Helper()
	select {
	case got := <-done:
		if got.detach != nil {
			t.Cleanup(got.detach)
		}
		return got
	case <-time.After(testTimeout):
		t.Fatal("enrolled Acquire did not settle")
		return enrolledAcquireResult{}
	}
}

// enrolledWireProxy preserves the real daemon's attachment/ownership state
// while a test holds, mutates or drops one connection's response at the wire.
// The hook only operates on complete NDJSON records; no mocked RPC client.
type enrolledWireProxy struct {
	path         string
	ln           net.Listener
	mu           sync.Mutex
	conns        []net.Conn
	wg           sync.WaitGroup
	streamClosed chan struct{}
	streamOnce   sync.Once
}

func newEnrolledWireProxy(t *testing.T, upstream string, hook func(map[string]any)) *enrolledWireProxy {
	t.Helper()
	dir, err := os.MkdirTemp("", "enrwire-")
	mustOK(t, err)
	path := filepath.Join(dir, "p.sock")
	ln, err := transport.Listen(path)
	mustOK(t, err)
	p := &enrolledWireProxy{path: path, ln: ln, streamClosed: make(chan struct{})}
	p.wg.Add(1)
	go func() {
		defer p.wg.Done()
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			remote, err := transport.Dial(context.Background(), upstream)
			if err != nil {
				_ = conn.Close()
				continue
			}
			p.mu.Lock()
			p.conns = append(p.conns, conn, remote)
			p.mu.Unlock()
			p.wg.Add(2)
			go func() {
				defer p.wg.Done()
				defer remote.Close()
				_, _ = io.Copy(remote, conn)
			}()
			go func() {
				defer p.wg.Done()
				defer p.streamOnce.Do(func() { close(p.streamClosed) })
				defer conn.Close()
				scanner := bufio.NewScanner(remote)
				scanner.Buffer(make([]byte, 4096), 4<<20)
				for scanner.Scan() {
					var frame map[string]any
					if json.Unmarshal(scanner.Bytes(), &frame) != nil {
						return
					}
					if hook != nil {
						hook(frame)
					}
					raw, err := json.Marshal(frame)
					if err != nil {
						return
					}
					if _, err := conn.Write(append(raw, '\n')); err != nil {
						return
					}
				}
			}()
		}
	}()
	t.Cleanup(func() {
		_ = ln.Close()
		p.mu.Lock()
		for _, conn := range p.conns {
			_ = conn.Close()
		}
		p.mu.Unlock()
		p.wg.Wait()
		if err := os.RemoveAll(dir); err != nil {
			t.Errorf("wire proxy cleanup: %v", err)
		}
	})
	return p
}

func (p *enrolledWireProxy) dropFirst() {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, conn := range p.conns[:2] {
		_ = conn.Close()
	}
}

func enrolledOpenData(frame map[string]any) map[string]any {
	if frame["type"] != "response" || frame["command"] != omorpc.CmdOpenSession || frame["success"] != true {
		return nil
	}
	data, _ := frame["data"].(map[string]any)
	return data
}
