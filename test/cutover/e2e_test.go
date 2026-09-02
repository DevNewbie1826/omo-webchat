//go:build unix

package cutover_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/lxzan/gws"

	"github.com/DevNewbie1826/omo-webchat/internal/auth"
	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
)

const (
	acceptanceTimeout = 10 * time.Second
	password          = "cutover-password"
	turnMarker        = "completed-turn-survived-server-kill"
)

type processLog struct {
	mu sync.Mutex
	b  strings.Builder
}

func (l *processLog) add(line string) {
	l.mu.Lock()
	fmt.Fprintln(&l.b, line)
	l.mu.Unlock()
}

func (l *processLog) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

type serverProcess struct {
	cmd     *exec.Cmd
	ready   chan struct{}
	exited  chan struct{}
	logs    processLog
	errMu   sync.Mutex
	waitErr error
}

func startServer(t *testing.T, binary string, args, env []string) *serverProcess {
	t.Helper()
	p := &serverProcess{ready: make(chan struct{}), exited: make(chan struct{})}
	p.cmd = exec.Command(binary, args...)
	p.cmd.Env = env
	p.cmd.Stdout = io.Discard
	p.cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stderr, err := p.cmd.StderrPipe()
	if err != nil {
		t.Fatalf("server stderr pipe: %v", err)
	}
	if err := p.cmd.Start(); err != nil {
		t.Fatalf("start server: %v", err)
	}
	var readyOnce sync.Once
	go func() {
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			line := scanner.Text()
			p.logs.add(line)
			if strings.Contains(line, "msg=listening") {
				readyOnce.Do(func() { close(p.ready) })
			}
		}
	}()
	go func() {
		err := p.cmd.Wait()
		p.errMu.Lock()
		p.waitErr = err
		p.errMu.Unlock()
		close(p.exited)
	}()
	t.Cleanup(func() { p.kill(t) })

	timer := time.NewTimer(acceptanceTimeout)
	defer timer.Stop()
	select {
	case <-p.ready:
	case <-p.exited:
		t.Fatalf("server exited before listening: %v\n%s", p.err(), p.logs.String())
	case <-timer.C:
		t.Fatalf("server did not announce listener\n%s", p.logs.String())
	}
	return p
}

func (p *serverProcess) err() error {
	p.errMu.Lock()
	defer p.errMu.Unlock()
	return p.waitErr
}

func (p *serverProcess) kill(t *testing.T) {
	t.Helper()
	select {
	case <-p.exited:
		return
	default:
	}
	if err := syscall.Kill(-p.cmd.Process.Pid, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
		t.Errorf("kill server process group %d: %v", p.cmd.Process.Pid, err)
	}
	timer := time.NewTimer(acceptanceTimeout)
	defer timer.Stop()
	select {
	case <-p.exited:
	case <-timer.C:
		t.Errorf("server process group %d was not reaped\n%s", p.cmd.Process.Pid, p.logs.String())
	}
}

type frameCollector struct {
	gws.BuiltinEventHandler
	frames chan json.RawMessage
}

func (c *frameCollector) OnMessage(_ *gws.Conn, message *gws.Message) {
	defer message.Close()
	c.frames <- append(json.RawMessage(nil), message.Bytes()...)
}

func (c *frameCollector) await(t *testing.T, typ string) map[string]any {
	t.Helper()
	timer := time.NewTimer(acceptanceTimeout)
	defer timer.Stop()
	var seen []string
	for {
		select {
		case raw := <-c.frames:
			var frame map[string]any
			if err := json.Unmarshal(raw, &frame); err != nil {
				t.Fatalf("decode websocket frame %q: %v", raw, err)
			}
			got, _ := frame["type"].(string)
			if got == typ {
				return frame
			}
			seen = append(seen, string(raw))
		case <-timer.C:
			t.Fatalf("timed out waiting for websocket frame %q; saw %s", typ, strings.Join(seen, ", "))
		}
	}
}

func TestServerKillPreservesDaemonSessionAndReconnectResumes(t *testing.T) {
	if testing.Short() {
		t.Skip("process-level cutover acceptance test")
	}

	repo := repositoryRoot(t)
	binary := filepath.Join(t.TempDir(), "omo-webchat")
	build := exec.Command("go", "build", "-o", binary, "./cmd/server")
	build.Dir = repo
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build real server: %v\n%s", err, output)
	}

	agentDir, err := os.MkdirTemp("", "omo-cutover-agent-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(agentDir) })
	rpcDir := filepath.Join(agentDir, "rpc")
	if err := os.MkdirAll(rpcDir, 0o700); err != nil {
		t.Fatal(err)
	}
	daemon := omorpctest.New(rpcDir)
	if err := daemon.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(daemon.Stop)
	// EnsureDaemon resolves this path from OMO_CODING_AGENT_DIR. The symlink
	// lets the exported mock keep its standard short d.sock pathname on macOS.
	ensureSocket := filepath.Join(rpcDir, "rpc.sock")
	if err := os.Symlink(filepath.Base(daemon.SocketPath()), ensureSocket); err != nil {
		t.Fatal(err)
	}

	root := t.TempDir()
	stateDir := t.TempDir()
	port := freeLoopbackPort(t)
	address := fmt.Sprintf("127.0.0.1:%d", port)
	args := []string{"--host", "127.0.0.1", "--port", fmt.Sprint(port), "--root", root, "--state-dir", stateDir, "--password", password}
	env := append(os.Environ(), "OMO_CODING_AGENT_DIR="+agentDir)

	first := startServer(t, binary, args, env)
	cookie := login(t, first, address)
	workspaceID := postAndID(t, address, cookie, "/api/workspaces", map[string]any{"name": "cutover", "path": root})
	chatID := postAndID(t, address, cookie, "/api/workspaces/"+workspaceID+"/chats", map[string]any{"name": "survivor", "provider": "omo"})

	ws1, frames1 := connect(t, address, cookie)
	writeFrame(t, ws1, map[string]any{"type": "hello", "version": 2})
	writeFrame(t, ws1, map[string]any{"type": "chat.create", "wsId": workspaceID, "chatId": chatID})
	ready1 := frames1.await(t, "ready")
	if resumed, _ := ready1["resumed"].(bool); resumed {
		t.Fatalf("fresh chat reported resumed: %v", ready1)
	}
	durableID, _ := ready1["piSessionId"].(string)
	if durableID == "" {
		t.Fatalf("fresh ready omitted durable id: %v", ready1)
	}
	cursor := loadCursor(t, stateDir, chatID)
	if cursor.DurableSessionID != durableID || cursor.SessionFile == "" {
		t.Fatalf("ready/cursor mismatch: ready=%v cursor=%+v", ready1, cursor)
	}

	daemon.SetPromptScript(cursor.SessionFile,
		map[string]any{"type": omorpctest.EventAgentStart},
		map[string]any{"type": omorpctest.EventMessageDelta, "delta": turnMarker},
		map[string]any{"type": omorpctest.EventMessage, "message": map[string]any{"role": "assistant", "content": turnMarker}},
		map[string]any{"type": omorpctest.EventAgentSettled, "reason": "end_turn"},
	)
	writeFrame(t, ws1, map[string]any{"type": "chat.send", "sessionId": chatID, "run": map[string]any{"kind": "prompt", "message": turnMarker}})
	frames1.await(t, "run.started")
	frames1.await(t, "messageDelta")
	frames1.await(t, "message")
	frames1.await(t, "run.done")

	first.kill(t)
	if got := daemon.LiveSessions(); len(got) != 1 || got[0] != cursor.SessionFile {
		t.Fatalf("daemon session died with server: live=%v want=%q", got, cursor.SessionFile)
	}
	probeCtx, cancelProbe := context.WithTimeout(context.Background(), acceptanceTimeout)
	probe, err := omorpc.Dial(probeCtx, ensureSocket)
	cancelProbe()
	if err != nil {
		t.Fatalf("daemon socket did not survive server SIGKILL: %v", err)
	}
	if err := probe.Close(); err != nil {
		t.Fatalf("close daemon liveness probe: %v", err)
	}

	second := startServer(t, binary, args, env)
	cookie = login(t, second, address)
	ws2, frames2 := connect(t, address, cookie)
	t.Cleanup(func() { _ = ws2.WriteClose(1000, nil) })
	writeFrame(t, ws2, map[string]any{"type": "hello", "version": 2})
	writeFrame(t, ws2, map[string]any{"type": "chat.create", "wsId": workspaceID, "chatId": chatID})
	ready2 := frames2.await(t, "ready")
	if resumed, _ := ready2["resumed"].(bool); !resumed {
		t.Fatalf("reconnect did not resume: %v", ready2)
	}
	if got, _ := ready2["piSessionId"].(string); got != durableID {
		t.Fatalf("durable id changed across server exec: got %q want %q", got, durableID)
	}
	persisted := loadCursor(t, stateDir, chatID)
	if persisted.DurableSessionID != durableID || persisted.SessionFile != cursor.SessionFile {
		t.Fatalf("cursor changed across server exec: before=%+v after=%+v", cursor, persisted)
	}
	entries := frames2.await(t, "entries")
	if final, _ := entries["final"].(bool); !final {
		t.Fatalf("history replay was not terminal: %v", entries)
	}
	rawEntries, err := json.Marshal(entries["entries"])
	if err != nil || !bytes.Contains(rawEntries, []byte(turnMarker)) {
		t.Fatalf("completed turn missing from replay: err=%v entries=%s", err, rawEntries)
	}
}

func repositoryRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test source path")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", ".."))
}

func freeLoopbackPort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	return port
}

func login(t *testing.T, process *serverProcess, address string) *http.Cookie {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), acceptanceTimeout)
	defer cancel()
	client := &http.Client{}
	for {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://"+address+"/api/login", strings.NewReader(`{"password":"`+password+`"}`))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := client.Do(req)
		if err == nil {
			_, _ = io.Copy(io.Discard, resp.Body)
			_ = resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("login status=%d", resp.StatusCode)
			}
			for _, cookie := range resp.Cookies() {
				if cookie.Name == auth.CookieName {
					return cookie
				}
			}
			t.Fatal("login response omitted session cookie")
		}
		select {
		case <-process.exited:
			t.Fatalf("server exited before accepting login: %v\n%s", process.err(), process.logs.String())
		case <-ctx.Done():
			t.Fatalf("server never accepted login: %v\n%s", ctx.Err(), process.logs.String())
		default:
			runtime.Gosched()
		}
	}
}

func postAndID(t *testing.T, address string, cookie *http.Cookie, path string, body any) string {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodPost, "http://"+address+path, bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(cookie)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST %s: %v", path, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		payload, _ := io.ReadAll(resp.Body)
		t.Fatalf("POST %s status=%d body=%s", path, resp.StatusCode, payload)
	}
	var result struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil || result.ID == "" {
		t.Fatalf("decode POST %s response: id=%q err=%v", path, result.ID, err)
	}
	return result.ID
}

func connect(t *testing.T, address string, cookie *http.Cookie) (*gws.Conn, *frameCollector) {
	t.Helper()
	collector := &frameCollector{frames: make(chan json.RawMessage, 128)}
	conn, response, err := gws.NewClient(collector, &gws.ClientOption{
		Addr:          "ws://" + address + "/api/v2/ws",
		RequestHeader: http.Header{"Cookie": []string{cookie.String()}},
	})
	if err != nil {
		status := 0
		if response != nil {
			status = response.StatusCode
		}
		t.Fatalf("connect websocket status=%d: %v", status, err)
	}
	go conn.ReadLoop()
	collector.await(t, "hello")
	return conn, collector
}

func writeFrame(t *testing.T, conn *gws.Conn, frame any) {
	t.Helper()
	raw, err := json.Marshal(frame)
	if err != nil {
		t.Fatal(err)
	}
	if err := conn.WriteMessage(gws.OpcodeText, raw); err != nil {
		t.Fatalf("write websocket frame %s: %v", raw, err)
	}
}

func loadCursor(t *testing.T, stateDir, chatID string) cursorstore.Chat {
	t.Helper()
	store, err := cursorstore.Open(filepath.Join(stateDir, "state-v2.json"))
	if err != nil {
		t.Fatalf("open persisted cursor: %v", err)
	}
	cursor, err := store.GetChat(chatID)
	if err != nil {
		t.Fatalf("load persisted cursor: %v", err)
	}
	return cursor
}
