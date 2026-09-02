// Package omorpctest is the shared, exported mock of the omo agent's
// unix-socket RPC engine, usable by any test package (internal/session,
// internal/api, ...). It speaks the verified wire protocol (newline-JSON
// over a unix socket, response envelopes, stable error codes) and models
// enough daemon state to exercise a session orchestration layer:
//
//   - session registry: open_session{cwd} mints a fresh durable id +
//     sessionFile; open_session{sessionPath} resumes with a durable id
//     that is STABLE across Stop/Restart (socket preserved, durable state
//     reused, epoch-local "rpc-N" handles keep incrementing)
//   - scriptable failure modes: FailNext (any command, any stable code),
//     FailOpenPath (transient per-path failures, e.g. session_path_in_use),
//     DropConnections (mid-request disconnect), SetRefuseMode (daemon down)
//   - scripted run streams: SetPromptScript / SetCompactScript attach a
//     sequence of unsolicited events to a session; HoldPrompt delays the
//     event stream after the accepted response so tests can hold a run open
//   - UnloadSession evicts a live session (subsequent commands fail
//     unknown_session) and emits a session_unloaded event
//   - Emit / EmitSession inject unsolicited events; WriteRaw injects
//     hostile bytes verbatim
//
// Requests are handled concurrently (one goroutine per request), so
// BlockHandler can reorder replies deterministically. Counters persist
// across Restart. The API never touches package testing: allocate the
// socket dir with the test framework of your choice and call Start.
package omorpctest

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

// Stable wire names re-exported for scripting convenience.
const (
	EventAgentStart      = "agent_start"
	EventAgentEnd        = "agent_end"
	EventAgentSettled    = "agent_settled"
	EventMessageDelta    = "message_delta"
	EventMessage         = "message"
	EventTool            = "tool"
	EventSessionUnloaded = "session_unloaded"

	CodeSessionPathInUse = omorpc.ErrCodeSessionPathInUse
	CodeUnknownSession   = omorpc.ErrCodeUnknownSession
)

// daemonSession is one provider-side session known to the daemon.
type daemonSession struct {
	path      string // durable sessionFile path (registry key)
	durableID string // durable UUID stored in the session file
	rpcID     string // CURRENT epoch-local routing handle ("rpc-N")
	live      bool   // false after UnloadSession or daemon Stop/Restart
	history   []any  // durable transcript returned by get_entries
}

// Daemon is the mock engine. The zero value is not usable; use New + Start.
type Daemon struct {
	sockPath   string
	sessionsDn string

	mu              sync.Mutex
	ln              net.Listener
	conns           map[net.Conn]struct{}
	serverVersion   string
	protocolVersion int
	capabilities    []string
	mode            string
	handlerGate     map[string]<-chan struct{}
	failNext        map[string]string
	pathFailures    map[string]int
	refuse          bool
	connections     int
	handshakes      int
	refusals        int
	opens           int
	closes          int
	rpcCounter      int
	registry        map[string]*daemonSession
	promptScripts   map[string][]map[string]any
	compactScripts  map[string][]map[string]any
	promptHolds     map[string]chan struct{}
	requests        []map[string]any

	writeMu sync.Mutex

	requestFeed   chan map[string]any
	handshakeFeed chan struct{}
	refusalFeed   chan struct{}
	closeFeed     chan struct{}
}

// New creates a stopped daemon that will serve unix://<dir>/d.sock. The
// daemon also mints fresh session files under <dir>/sessions. Call Start to
// begin accepting connections.
func New(dir string) *Daemon {
	return &Daemon{
		sockPath:        filepath.Join(dir, "d.sock"),
		sessionsDn:      filepath.Join(dir, "sessions"),
		serverVersion:   "1.2.3",
		protocolVersion: 1,
		capabilities:    []string{"multi_session", "extension_events", "custom_unsupported"},
		mode:            "multi",
		handlerGate:     map[string]<-chan struct{}{},
		failNext:        map[string]string{},
		pathFailures:    map[string]int{},
		conns:           map[net.Conn]struct{}{},
		registry:        map[string]*daemonSession{},
		promptScripts:   map[string][]map[string]any{},
		compactScripts:  map[string][]map[string]any{},
		promptHolds:     map[string]chan struct{}{},
		requestFeed:     make(chan map[string]any, 256),
		handshakeFeed:   make(chan struct{}, 1),
		refusalFeed:     make(chan struct{}, 1),
		closeFeed:       make(chan struct{}, 256),
	}
}

// SocketPath is the unix socket the daemon listens on.
func (d *Daemon) SocketPath() string { return d.sockPath }

// Start (re)opens the listener. Counters, registry, and scripting persist.
// Idempotent while running.
func (d *Daemon) Start() error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.ln != nil {
		return nil
	}
	_ = os.Remove(d.sockPath) // stale socket from a previous lifetime
	ln, err := net.Listen("unix", d.sockPath)
	if err != nil {
		return fmt.Errorf("omorpctest: listen %s: %w", d.sockPath, err)
	}
	d.ln = ln
	go d.acceptLoop(ln)
	return nil
}

// Stop closes the listener and every live connection and marks all
// sessions unloaded, simulating a daemon shutdown. The socket path can be
// re-served with Start (or Restart).
func (d *Daemon) Stop() {
	d.mu.Lock()
	if d.ln != nil {
		_ = d.ln.Close()
		d.ln = nil
	}
	conns := make([]net.Conn, 0, len(d.conns))
	for c := range d.conns {
		conns = append(conns, c)
	}
	d.conns = map[net.Conn]struct{}{}
	for _, rec := range d.registry {
		rec.live = false
	}
	d.mu.Unlock()
	for _, c := range conns {
		_ = c.Close()
	}
}

// Restart simulates a full daemon restart: the listener reopens on the same
// socket path, live sessions are gone, but the durable session registry
// (sessionPath -> durable id) and all counters persist.
func (d *Daemon) Restart() {
	d.Stop()
	_ = d.Start()
}

func (d *Daemon) acceptLoop(ln net.Listener) {
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

func (d *Daemon) readLoop(conn net.Conn) {
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

func (d *Daemon) record(req map[string]any) {
	d.mu.Lock()
	d.requests = append(d.requests, req)
	d.mu.Unlock()
	select {
	case d.requestFeed <- req:
	default:
	}
}

// sessionByRPC requires d.mu.
func (d *Daemon) sessionByRPC(sid string) *daemonSession {
	if sid == "" {
		return nil
	}
	for _, rec := range d.registry {
		if rec.rpcID == sid {
			return rec
		}
	}
	return nil
}

func (d *Daemon) handle(conn net.Conn, req map[string]any) {
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
	if cmd == omorpc.CmdExtensionUIResponse {
		if sid == "" {
			d.write(conn, map[string]any{
				"id": id, "type": "response", "command": cmd,
				"success": false, "error": omorpc.ErrCodeMissingSessionID,
			})
		}
		return
	}

	switch cmd {
	case omorpc.CmdGetProtocolInfo:
		d.mu.Lock()
		d.handshakes++
		d.notify(d.handshakeFeed)
		ver, pv, caps, mode := d.serverVersion, d.protocolVersion, d.capabilities, d.mode
		d.mu.Unlock()
		d.write(conn, d.resp(id, cmd, sid, map[string]any{
			"protocolVersion": pv,
			"serverVersion":   ver,
			"capabilities":    caps,
			"mode":            mode,
		}))
		return

	case omorpc.CmdOpenSession:
		d.handleOpenSession(conn, id, req)
		return

	case omorpc.CmdListSessions:
		d.mu.Lock()
		sessions := make([]any, 0)
		for _, rec := range d.registry {
			if rec.live {
				sessions = append(sessions, map[string]any{
					"sessionId":   rec.rpcID,
					"sessionFile": rec.path,
				})
			}
		}
		d.mu.Unlock()
		d.write(conn, d.resp(id, cmd, sid, map[string]any{"sessions": sessions}))
		return
	}

	// Session-scoped commands from here on.
	d.mu.Lock()
	rec := d.sessionByRPC(sid)
	live := rec != nil && rec.live
	var recPath, recDurable string
	if live {
		recPath, recDurable = rec.path, rec.durableID
	}
	var script []map[string]any
	var hold chan struct{}
	d.mu.Unlock()

	if !live {
		d.write(conn, map[string]any{
			"id": id, "type": "response", "command": cmd,
			"success": false, "error": omorpc.ErrCodeUnknownSession,
		})
		return
	}

	switch cmd {
	case omorpc.CmdCloseSession:
		d.mu.Lock()
		rec.live = false
		d.closes++
		d.notify(d.closeFeed)
		d.mu.Unlock()
		d.write(conn, d.resp(id, cmd, sid, map[string]any{}))
		return

	case omorpc.CmdPrompt:
		d.mu.Lock()
		script = takeScript(d.promptScripts, recPath)
		hold = d.promptHolds[recPath]
		rpcID := rec.rpcID // read under mu: handleOpenSession may reassign it concurrently (resume)
		if message, _ := req["message"].(string); message != "" {
			rec.history = append(rec.history, map[string]any{"type": "message", "role": "user", "content": message})
		}
		for _, event := range script {
			typ, _ := event["type"].(string)
			if typ != EventMessage && typ != "message_end" {
				continue
			}
			if message, ok := event["message"].(map[string]any); ok {
				entry := make(map[string]any, len(message)+1)
				entry["type"] = "message"
				for key, value := range message {
					entry[key] = value
				}
				rec.history = append(rec.history, entry)
			}
		}
		d.mu.Unlock()
		d.write(conn, d.resp(id, cmd, sid, map[string]any{"accepted": true}))
		if hold != nil {
			<-hold
		}
		d.emitScript(conn, rpcID, script)
		return

	case omorpc.CmdCompact:
		d.mu.Lock()
		script = takeScript(d.compactScripts, recPath)
		rpcID := rec.rpcID // same lock discipline as CmdPrompt
		d.mu.Unlock()
		d.write(conn, d.resp(id, cmd, sid, map[string]any{"started": true}))
		d.emitScript(conn, rpcID, script)
		return

	case omorpc.CmdGetEntries:
		d.mu.Lock()
		entries := append([]any(nil), rec.history...)
		d.mu.Unlock()
		if len(entries) == 0 {
			entries = []any{map[string]any{"type": "message", "role": "user", "content": "hello"}}
		}
		d.write(conn, d.resp(id, cmd, sid, map[string]any{"entries": entries}))
		return

	case omorpc.CmdGetState:
		d.write(conn, d.resp(id, cmd, sid, map[string]any{
			"sessionId":     recDurable,
			"sessionFile":   recPath,
			"thinkingLevel": "off",
			"messageCount":  1,
		}))
		return

	case omorpc.CmdGetAvailableModels:
		d.write(conn, d.resp(id, cmd, sid, map[string]any{
			"models": []any{map[string]any{
				"provider": "anthropic", "modelId": "claude-fake", "name": "Claude Fake",
			}},
		}))
		return

	case omorpc.CmdGetCommands:
		d.write(conn, d.resp(id, cmd, sid, map[string]any{"commands": []any{}}))

	case omorpc.CmdGetMessages:
		d.write(conn, d.resp(id, cmd, sid, map[string]any{"messages": []any{}}))

	default:
		// set_model, set_thinking_level, set_session_name, set_auto_compaction,
		// steer, follow_up, abort, get_session_stats, extension_request:
		// plain success, no data payload required.
		d.write(conn, d.resp(id, cmd, sid, map[string]any{}))
	}
}

func takeScript(m map[string][]map[string]any, key string) []map[string]any {
	script := m[key]
	delete(m, key)
	return script
}

func (d *Daemon) handleOpenSession(conn net.Conn, id string, req map[string]any) {
	path, _ := req["sessionPath"].(string)

	d.mu.Lock()
	d.opens++
	if code, ok := d.failNext[omorpc.CmdOpenSession]; ok {
		delete(d.failNext, omorpc.CmdOpenSession)
		d.mu.Unlock()
		d.write(conn, map[string]any{
			"id": id, "type": "response", "command": omorpc.CmdOpenSession,
			"success": false, "error": code,
		})
		return
	}
	if n := d.pathFailures[path]; n > 0 {
		d.pathFailures[path] = n - 1
		d.mu.Unlock()
		d.write(conn, map[string]any{
			"id": id, "type": "response", "command": omorpc.CmdOpenSession,
			"success": false, "error": omorpc.ErrCodeSessionPathInUse,
		})
		return
	}
	var rec *daemonSession
	if path != "" {
		rec = d.registry[path]
		if rec == nil {
			rec = &daemonSession{path: path, durableID: durableForPath(path)}
			d.registry[path] = rec
		}
	} else {
		durable := fmt.Sprintf("durable-%08d-4f2a-9c31", d.opens)
		path = filepath.Join(d.sessionsDn, durable+".jsonl")
		rec = &daemonSession{path: path, durableID: durable}
		d.registry[path] = rec
	}
	d.rpcCounter++
	rec.rpcID = fmt.Sprintf("rpc-%d", d.rpcCounter)
	rec.live = true
	d.mu.Unlock()

	d.write(conn, d.resp(id, omorpc.CmdOpenSession, "", map[string]any{
		"sessionId": rec.rpcID,
		"state": map[string]any{
			"sessionId":     rec.durableID,
			"sessionFile":   rec.path,
			"model":         map[string]any{"provider": "anthropic", "modelId": "claude-fake"},
			"thinkingLevel": "off",
			"entries":       []any{},
			"messageCount":  0,
		},
	}))
}

// durableForPath derives a stable durable id for an unknown resumed path:
// the daemon (real or mock) owns resume validity, and the id must not
// change across restarts for the same file.
func durableForPath(path string) string {
	sum := sha256.Sum256([]byte(path))
	return "durable-" + hex.EncodeToString(sum[:4]) + "-7d24-4b1e-resume"
}

func (d *Daemon) resp(id, cmd, sid string, data map[string]any) map[string]any {
	resp := map[string]any{
		"id": id, "type": "response", "command": cmd,
		"success": true, "data": data,
	}
	if sid != "" {
		resp["sessionId"] = sid
	}
	return resp
}

// emitScript writes each scripted event to conn with the session's current
// rpc id injected, in order, on the handler goroutine.
func (d *Daemon) emitScript(conn net.Conn, rpcID string, script []map[string]any) {
	for _, ev := range script {
		e := make(map[string]any, len(ev)+1)
		for k, v := range ev {
			e[k] = v
		}
		e["sessionId"] = rpcID
		d.write(conn, e)
	}
}

// write emits one frame to conn; handler goroutines may write concurrently.
func (d *Daemon) write(conn net.Conn, v map[string]any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	d.writeMu.Lock()
	defer d.writeMu.Unlock()
	_, _ = conn.Write(append(b, '\n'))
}

// ---- event injection ----

// Emit injects an unsolicited event, verbatim, on every live connection.
func (d *Daemon) Emit(event map[string]any) {
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

// EmitSession injects an unsolicited event with the session's current
// epoch-local routing id attached, on every live connection.
func (d *Daemon) EmitSession(path string, event map[string]any) {
	d.mu.Lock()
	rec := d.registry[path]
	rpcID := ""
	if rec != nil {
		rpcID = rec.rpcID
	}
	d.mu.Unlock()
	e := make(map[string]any, len(event)+1)
	for k, v := range event {
		e[k] = v
	}
	e["sessionId"] = rpcID
	d.Emit(e)
}

// UnloadSession evicts the live session opened from path: subsequent
// session-scoped commands addressed to its routing handle fail
// unknown_session, and exactly one session_unloaded event is emitted.
func (d *Daemon) UnloadSession(path string) {
	d.mu.Lock()
	rec := d.registry[path]
	rpcID := ""
	if rec != nil {
		rec.live = false
		rpcID = rec.rpcID
	}
	d.mu.Unlock()
	if rpcID != "" {
		d.Emit(map[string]any{"type": EventSessionUnloaded, "sessionId": rpcID})
	}
}

// WriteRaw frames raw bytes verbatim to every live connection: unterminated
// fragments, garbage lines, and CRLF endings all travel unmodified.
func (d *Daemon) WriteRaw(b []byte) {
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
// The bytes are written (and queued in the socket) before the close, so the
// client observes them before the EOF: the deterministic
// response-before-exit race.
func (d *Daemon) WriteRawThenDrop(b []byte) {
	d.WriteRaw(b)
	d.DropConnections()
}

// ---- scripting knobs ----

func (d *Daemon) SetServerVersion(v string)  { d.mu.Lock(); d.serverVersion = v; d.mu.Unlock() }
func (d *Daemon) SetProtocolVersion(v int)   { d.mu.Lock(); d.protocolVersion = v; d.mu.Unlock() }
func (d *Daemon) SetCapabilities(c []string) { d.mu.Lock(); d.capabilities = c; d.mu.Unlock() }
func (d *Daemon) SetMode(m string)           { d.mu.Lock(); d.mode = m; d.mu.Unlock() }

// BlockHandler holds future requests of cmd at an explicit gate. The
// returned release function is idempotent and removes the gate.
func (d *Daemon) BlockHandler(cmd string) (release func()) {
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

// FailNext makes the NEXT request of cmd receive a success:false envelope
// carrying the stable error code.
func (d *Daemon) FailNext(cmd, code string) {
	d.mu.Lock()
	d.failNext[cmd] = code
	d.mu.Unlock()
}

// FailOpenPath makes the next `times` open_session requests carrying
// exactly this sessionPath fail with the given stable code (typically
// session_path_in_use) before the path opens normally. The retried requests
// themselves are unchanged; only the daemon's answer differs.
func (d *Daemon) FailOpenPath(path, code string, times int) {
	if code == "" {
		code = omorpc.ErrCodeSessionPathInUse
	}
	d.mu.Lock()
	d.pathFailures[path] = times
	d.mu.Unlock()
}

// SetPromptScript arms ONE prompt's worth of unsolicited events for the
// session identified by its durable sessionFile path. Events are emitted,
// in order, after the prompt's accepted response; the session's routing id
// is injected into each event. One-shot: consumed by the next prompt.
func (d *Daemon) SetPromptScript(sessionFile string, events ...map[string]any) {
	d.mu.Lock()
	d.promptScripts[sessionFile] = events
	d.mu.Unlock()
}

// SetCompactScript is SetPromptScript for the compact command.
func (d *Daemon) SetCompactScript(sessionFile string, events ...map[string]any) {
	d.mu.Lock()
	d.compactScripts[sessionFile] = events
	d.mu.Unlock()
}

// HoldPrompt delays a prompt's scripted event stream AFTER the accepted
// response has been written, keeping the run observably active until the
// returned release function fires. Idempotent release.
func (d *Daemon) HoldPrompt(sessionFile string) (release func()) {
	hold := make(chan struct{})
	var once sync.Once
	d.mu.Lock()
	d.promptHolds[sessionFile] = hold
	d.mu.Unlock()
	return func() {
		once.Do(func() {
			d.mu.Lock()
			delete(d.promptHolds, sessionFile)
			d.mu.Unlock()
			close(hold)
		})
	}
}

// DropConnections closes every live connection but keeps listening: the
// client-side effect is a mid-request transport death.
func (d *Daemon) DropConnections() {
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
// reconnect attempts fail inside the handshake. Each such attempt counts as
// a refusal.
func (d *Daemon) SetRefuseMode(on bool) {
	d.mu.Lock()
	d.refuse = on
	d.mu.Unlock()
	if on {
		d.DropConnections()
	}
}

// ---- observations ----

func (d *Daemon) Handshakes() int  { d.mu.Lock(); defer d.mu.Unlock(); return d.handshakes }
func (d *Daemon) Connections() int { d.mu.Lock(); defer d.mu.Unlock(); return d.connections }
func (d *Daemon) Refusals() int    { d.mu.Lock(); defer d.mu.Unlock(); return d.refusals }

// OpenCount is the total number of open_session requests received, across
// restarts.
func (d *Daemon) OpenCount() int { d.mu.Lock(); defer d.mu.Unlock(); return d.opens }

// CloseCount is the number of close_session handlers that completed.
func (d *Daemon) CloseCount() int { d.mu.Lock(); defer d.mu.Unlock(); return d.closes }

// LiveSessions lists the durable sessionFile paths currently live.
func (d *Daemon) LiveSessions() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	paths := make([]string, 0, len(d.registry))
	for p, rec := range d.registry {
		if rec.live {
			paths = append(paths, p)
		}
	}
	return paths
}

// Requests snapshots every received request, oldest first.
func (d *Daemon) Requests() []map[string]any {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := make([]map[string]any, len(d.requests))
	copy(out, d.requests)
	return out
}

// RequestCount counts received requests of the given command, across
// restarts.
func (d *Daemon) RequestCount(cmd string) int {
	d.mu.Lock()
	defer d.mu.Unlock()
	n := 0
	for _, r := range d.requests {
		if t, _ := r["type"].(string); t == cmd {
			n++
		}
	}
	return n
}

// LastRequest returns the most recent request of the given command, or nil.
func (d *Daemon) LastRequest(cmd string) map[string]any {
	d.mu.Lock()
	defer d.mu.Unlock()
	for i := len(d.requests) - 1; i >= 0; i-- {
		if t, _ := d.requests[i]["type"].(string); t == cmd {
			return d.requests[i]
		}
	}
	return nil
}

// AwaitRequestCount reports whether at least n requests of cmd have been
// received within the timeout.
func (d *Daemon) AwaitRequestCount(cmd string, n int, timeout time.Duration) bool {
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	for {
		if d.RequestCount(cmd) >= n {
			return true
		}
		select {
		case <-d.requestFeed:
		case <-deadline.C:
			return false
		}
	}
}

// AwaitCloseCount reports whether at least n close_session handlers have
// completed within the timeout.
func (d *Daemon) AwaitCloseCount(n int, timeout time.Duration) bool {
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	for {
		if d.CloseCount() >= n {
			return true
		}
		select {
		case <-d.closeFeed:
		case <-deadline.C:
			return false
		}
	}
}

// AwaitOpen reports whether an open_session has been received within the
// timeout, returning its sessionPath ("" for a fresh open) and whether the
// open was a resume.
func (d *Daemon) AwaitOpen(timeout time.Duration) (sessionPath string, resumed bool, ok bool) {
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	for {
		if r := d.LastRequest(omorpc.CmdOpenSession); r != nil {
			p, _ := r["sessionPath"].(string)
			return p, p != "", true
		}
		select {
		case <-d.requestFeed:
		case <-deadline.C:
			return "", false, false
		}
	}
}

func (d *Daemon) notify(ch chan struct{}) {
	select {
	case ch <- struct{}{}:
	default:
	}
}
