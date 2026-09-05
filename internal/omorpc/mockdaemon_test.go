package omorpc

// mockDaemon is an in-process fake of the omo agent's unix-socket RPC
// engine for the client contract tests. It speaks the verified wire
// protocol (newline-JSON over a unix socket, response envelopes, stable
// error codes) and exposes scriptable failure modes:
//
//   - SetCapabilities / SetProtocolVersion / SetServerVersion — wrong
//     capabilities and version-mismatch handshakes
//   - DropConnections — mid-request disconnect (listener stays up)
//   - SetRefuseMode — daemon "down": kills live conns and accepts-then-
//     closes new ones, so reconnect attempts fail at the handshake
//   - FailNext — next request of a command gets a success:false envelope
//     carrying a stable error code (e.g. unknown_session)
//   - Emit — injects an unsolicited event on all live connections
//
// The daemon handles requests concurrently (one goroutine per request), so
// scripted handler delays reorder replies deterministically. Counters
// (connections, handshakes, refusals, opened sessions) persist across
// Stop/Restart so an epoch-local "rpc-N" handle keeps incrementing within
// a test, and feed channels let tests await requests/handshakes/refusals
// without sleeps.

import (
	"bufio"
	"encoding/json"
	"fmt"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest/transport"
	"net"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

type mockDaemon struct {
	t        *testing.T
	sockPath string

	mu              sync.Mutex
	ln              net.Listener
	conns           map[net.Conn]struct{}
	serverVersion   string
	protocolVersion int
	capabilities    []string
	mode            string
	handlerGate     map[string]<-chan struct{}
	failNext        map[string]string
	refuse          bool
	connections     int
	handshakes      int
	refusals        int
	opened          int
	requests        []map[string]any

	writeMu sync.Mutex

	requestFeed   chan map[string]any
	handshakeFeed chan struct{}
	refusalFeed   chan struct{}
}

// newMockDaemon starts a daemon on a socket inside a fresh temp dir and
// registers its shutdown with t.Cleanup.
func newMockDaemon(t *testing.T) *mockDaemon {
	t.Helper()
	// macOS caps unix socket paths at 104 bytes, and t.TempDir() embeds
	// the (long) test name — long test names overflow sun_path and fail
	// to bind. Use a short-lived temp dir for the socket instead; still
	// per-test and cleaned up with the test.
	dir, err := os.MkdirTemp("", "omorpc-*")
	if err != nil {
		t.Fatalf("mock daemon temp dir: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	d := &mockDaemon{
		t:               t,
		sockPath:        filepath.Join(dir, "d.sock"),
		serverVersion:   "1.2.3",
		protocolVersion: 1,
		capabilities:    []string{"multi_session", "extension_events", "custom_unsupported"},
		mode:            "multi",
		handlerGate:     map[string]<-chan struct{}{},
		failNext:        map[string]string{},
		conns:           map[net.Conn]struct{}{},
		requestFeed:     make(chan map[string]any, 64),
		handshakeFeed:   make(chan struct{}, 1),
		refusalFeed:     make(chan struct{}, 1),
	}
	d.start()
	t.Cleanup(d.Stop)
	return d
}

func (d *mockDaemon) SocketPath() string { return d.sockPath }

// start (re)opens the listener. Counters and scripting persist.
func (d *mockDaemon) start() {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.ln != nil {
		return
	}
	_ = os.Remove(d.sockPath) // stale socket from a previous lifetime
	ln, err := transport.Listen(d.sockPath)
	if err != nil {
		d.t.Fatalf("mock daemon listen: %v", err)
	}
	d.ln = ln
	go d.acceptLoop(ln)
}

// Stop closes the listener and every live connection, simulating a daemon
// shutdown. The socket path can be re-served with Restart.
func (d *mockDaemon) Stop() {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.ln != nil {
		_ = d.ln.Close()
		d.ln = nil
	}
	for c := range d.conns {
		_ = c.Close()
	}
	d.conns = map[net.Conn]struct{}{}
}

// Restart simulates a full daemon restart: the listener reopens on the
// same socket path; counters (and therefore epoch-local rpc-N handles)
// keep incrementing, mirroring an agent restart that reuses durable state.
func (d *mockDaemon) Restart() {
	d.Stop()
	d.start()
}

func (d *mockDaemon) acceptLoop(ln net.Listener) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			return // listener closed
		}
		d.mu.Lock()
		d.connections++
		if d.refuse {
			d.refusals++
			d.notify(d.refusalFeed)
			d.mu.Unlock()
			_ = conn.Close()
			continue
		}
		d.conns[conn] = struct{}{}
		d.mu.Unlock()
		go d.readLoop(conn)
	}
}

func (d *mockDaemon) readLoop(conn net.Conn) {
	br := bufio.NewReader(conn)
	for {
		line, err := br.ReadBytes('\n')
		if err != nil {
			d.mu.Lock()
			delete(d.conns, conn)
			d.mu.Unlock()
			_ = conn.Close()
			return
		}
		var req map[string]any
		if json.Unmarshal(line, &req) != nil {
			continue
		}
		d.record(req)
		go d.handle(conn, req)
	}
}

func (d *mockDaemon) record(req map[string]any) {
	d.mu.Lock()
	d.requests = append(d.requests, req)
	d.mu.Unlock()
	select {
	case d.requestFeed <- req:
	default:
	}
}

func (d *mockDaemon) handle(conn net.Conn, req map[string]any) {
	id, _ := req["id"].(string)
	cmd, _ := req["type"].(string)
	sid, _ := req["sessionId"].(string)

	d.mu.Lock()
	gate := d.handlerGate[cmd]
	code, failing := d.failNext[cmd]
	if failing {
		delete(d.failNext, cmd)
	}
	d.mu.Unlock()

	if gate != nil {
		<-gate
	}
	if failing {
		d.write(conn, map[string]any{
			"id": id, "type": "response", "command": cmd,
			"success": false, "error": code,
		})
		return
	}
	if cmd == CmdExtensionUIResponse {
		if sid == "" {
			d.write(conn, map[string]any{
				"id": id, "type": "response", "command": cmd,
				"success": false, "error": ErrCodeMissingSessionID,
			})
		}
		return
	}

	var data map[string]any
	switch cmd {
	case CmdGetProtocolInfo:
		d.mu.Lock()
		d.handshakes++
		d.notify(d.handshakeFeed)
		ver, pv, caps, mode := d.serverVersion, d.protocolVersion, d.capabilities, d.mode
		d.mu.Unlock()
		data = map[string]any{
			"protocolVersion": pv,
			"serverVersion":   ver,
			"capabilities":    caps,
			"mode":            mode,
		}

	case CmdOpenSession:
		d.mu.Lock()
		d.opened++
		n := d.opened
		d.mu.Unlock()
		durable := fmt.Sprintf("durable-%08d-4f2a-9c31", n)
		data = map[string]any{
			"sessionId": fmt.Sprintf("rpc-%d", n),
			"state": map[string]any{
				"sessionId":     durable,
				"sessionFile":   filepath.Join(os.TempDir(), "omo-fake", durable+".jsonl"),
				"model":         map[string]any{"provider": "anthropic", "modelId": "claude-fake"},
				"thinkingLevel": "off",
				"entries":       []any{},
				"messageCount":  0,
			},
		}

	case CmdListSessions:
		data = map[string]any{"sessions": []any{}}

	case CmdGetEntries:
		data = map[string]any{
			"entries": []any{
				map[string]any{"type": "message", "role": "user", "content": "hello"},
			},
		}

	case CmdPrompt:
		data = map[string]any{"accepted": true}

	default:
		if sid == "" && isSessionScoped(cmd) {
			d.write(conn, map[string]any{
				"id": id, "type": "response", "command": cmd,
				"success": false, "error": ErrCodeMissingSessionID,
			})
			return
		}
		d.write(conn, map[string]any{
			"id": id, "type": "response", "command": cmd,
			"success": false, "error": "unknown_command: " + cmd,
		})
		return
	}

	resp := map[string]any{
		"id": id, "type": "response", "command": cmd,
		"success": true, "data": data,
	}
	if sid != "" {
		resp["sessionId"] = sid
	}
	d.write(conn, resp)
}

func isSessionScoped(cmd string) bool {
	switch cmd {
	case CmdSteer, CmdFollowUp, CmdAbort, CmdGetState, CmdGetAvailableModels,
		CmdGetEntries, CmdGetMessages, CmdGetCommands, CmdGetSessionStats,
		CmdSetSessionName, CmdSetModel, CmdSetThinkingLevel, CmdCompact, CmdSetAutoCompaction, CmdExtensionRequest:
		return true
	}
	return false
}

// write emits one frame to conn; handler goroutines may write concurrently.
func (d *mockDaemon) write(conn net.Conn, v map[string]any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	d.writeMu.Lock()
	defer d.writeMu.Unlock()
	_, _ = conn.Write(append(b, '\n'))
}

// Emit injects an unsolicited event on every live connection.
func (d *mockDaemon) Emit(event map[string]any) {
	d.mu.Lock()
	conns := make([]net.Conn, 0, len(d.conns))
	for c := range d.conns {
		conns = append(conns, c)
	}
	d.mu.Unlock()
	for _, c := range conns {
		d.write(c, event)
	}
}

// ---- scripting knobs ----

func (d *mockDaemon) SetServerVersion(v string)  { d.mu.Lock(); d.serverVersion = v; d.mu.Unlock() }
func (d *mockDaemon) SetProtocolVersion(v int)   { d.mu.Lock(); d.protocolVersion = v; d.mu.Unlock() }
func (d *mockDaemon) SetCapabilities(c []string) { d.mu.Lock(); d.capabilities = c; d.mu.Unlock() }
func (d *mockDaemon) SetMode(m string)           { d.mu.Lock(); d.mode = m; d.mu.Unlock() }

// BlockHandler holds future requests of cmd at an explicit gate. The
// returned release function is idempotent and removes the gate.
func (d *mockDaemon) BlockHandler(cmd string) func() {
	gate := make(chan struct{})
	var once sync.Once
	d.mu.Lock()
	d.handlerGate[cmd] = gate
	d.mu.Unlock()
	return func() {
		once.Do(func() {
			d.mu.Lock()
			delete(d.handlerGate, cmd)
			d.mu.Unlock()
			close(gate)
		})
	}
}

// FailNext makes the NEXT request of cmd get a success:false envelope
// carrying the stable error code.
func (d *mockDaemon) FailNext(cmd, code string) {
	d.mu.Lock()
	d.failNext[cmd] = code
	d.mu.Unlock()
}

// DropConnections closes every live connection but keeps listening: the
// client-side effect is a mid-request transport death.
func (d *mockDaemon) DropConnections() {
	d.mu.Lock()
	conns := make([]net.Conn, 0, len(d.conns))
	for c := range d.conns {
		conns = append(conns, c)
	}
	d.conns = map[net.Conn]struct{}{}
	d.mu.Unlock()
	for _, c := range conns {
		_ = c.Close()
	}
}

// SetRefuseMode makes the daemon "down": live connections are dropped and
// every new connection is accepted then immediately closed, so client
// reconnect attempts fail inside the handshake. Each such attempt is
// counted as a refusal.
func (d *mockDaemon) SetRefuseMode(on bool) {
	d.mu.Lock()
	d.refuse = on
	d.mu.Unlock()
	if on {
		d.DropConnections()
	}
}

// ---- observations ----

func (d *mockDaemon) Handshakes() int  { d.mu.Lock(); defer d.mu.Unlock(); return d.handshakes }
func (d *mockDaemon) Connections() int { d.mu.Lock(); defer d.mu.Unlock(); return d.connections }
func (d *mockDaemon) Refusals() int    { d.mu.Lock(); defer d.mu.Unlock(); return d.refusals }
func (d *mockDaemon) OpenedSessions() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.opened
}

// lastRequest returns the most recent request of the given command.
func (d *mockDaemon) lastRequest(cmd string) map[string]any {
	d.mu.Lock()
	defer d.mu.Unlock()
	for i := len(d.requests) - 1; i >= 0; i-- {
		if t, _ := d.requests[i]["type"].(string); t == cmd {
			return d.requests[i]
		}
	}
	return nil
}

func (d *mockDaemon) sawRequest(cmd string) bool { return d.lastRequest(cmd) != nil }

func (d *mockDaemon) notify(ch chan struct{}) {
	select {
	case ch <- struct{}{}:
	default:
	}
}

// awaitRequest blocks until the daemon has received a request of the given
// command (checked first against the log, then via the live feed).
func (d *mockDaemon) awaitRequest(t *testing.T, cmd string, timeout time.Duration) {
	t.Helper()
	if d.sawRequest(cmd) {
		return
	}
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	for {
		select {
		case <-d.requestFeed:
			if d.sawRequest(cmd) {
				return
			}
		case <-deadline.C:
			t.Fatalf("mock daemon never received request %q within %v", cmd, timeout)
		}
	}
}

// awaitRefusal reports whether the refusal count grew beyond baseline.
func (d *mockDaemon) awaitRefusal(t *testing.T, baseline int, timeout time.Duration) bool {
	t.Helper()
	if d.Refusals() > baseline {
		return true
	}
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	for {
		select {
		case <-d.refusalFeed:
			if d.Refusals() > baseline {
				return true
			}
		case <-deadline.C:
			return false
		}
	}
}

// ---- edge-test helpers (additive; used by edge_test.go) ----

// WriteRaw frames raw bytes verbatim to every live connection: unterminated
// fragments, garbage lines, and CRLF endings all travel unmodified. It is
// the injection point for hostile daemon output.
func (d *mockDaemon) WriteRaw(b []byte) {
	d.mu.Lock()
	conns := make([]net.Conn, 0, len(d.conns))
	for c := range d.conns {
		conns = append(conns, c)
	}
	d.mu.Unlock()
	d.writeMu.Lock()
	defer d.writeMu.Unlock()
	for _, c := range conns {
		_, _ = c.Write(b)
	}
}

// WriteRawThenDrop is WriteRaw followed by closing every live connection.
// Because the bytes are written (and thus queued in the socket) before the
// close, the client's stream is guaranteed to deliver them before the EOF:
// this is how the response-before-exit race is scripted deterministically.
func (d *mockDaemon) WriteRawThenDrop(b []byte) {
	d.WriteRaw(b)
	d.DropConnections()
}

// awaitRequestCount waits until at least n requests of the given command
// have been received (across all connections).
func (d *mockDaemon) awaitRequestCount(t *testing.T, cmd string, n int, timeout time.Duration) {
	t.Helper()
	count := func() int {
		d.mu.Lock()
		defer d.mu.Unlock()
		c := 0
		for _, r := range d.requests {
			if typ, _ := r["type"].(string); typ == cmd {
				c++
			}
		}
		return c
	}
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	for {
		if got := count(); got >= n {
			return
		}
		select {
		case <-d.requestFeed:
		case <-deadline.C:
			t.Fatalf("mock daemon received only %d %q request(s), wanted %d, within %v", count(), cmd, n, timeout)
		}
	}
}

// awaitHandshake reports whether the handshake count grew beyond baseline.
// The signal fires when the request is received, before any scripted
// handshake delay elapses.
func (d *mockDaemon) awaitHandshake(t *testing.T, baseline int, timeout time.Duration) bool {
	t.Helper()
	if d.Handshakes() > baseline {
		return true
	}
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	for {
		select {
		case <-d.handshakeFeed:
			if d.Handshakes() > baseline {
				return true
			}
		case <-deadline.C:
			return false
		}
	}
}
