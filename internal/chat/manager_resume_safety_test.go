package chat

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// A real multi-session provider that rejects the first open_session for
// RESUME_STORED_PATH with session_path_in_use and succeeds on the next open
// of that same path. Cwd-backed opens succeed with a different identity so a
// fallback rebind is observable.
const resumeRetryProviderScript = `
const fs = require('fs');
const stored = process.env.RESUME_STORED_PATH;
const log = process.env.RESUME_CMD_LOG;
let buf = '';
let pathOpens = 0;
process.stdin.on('data', chunk => {
  buf += chunk;
  for (let n; (n = buf.indexOf('\n')) >= 0; ) {
    const line = buf.slice(0, n);
    buf = buf.slice(n + 1);
    if (!line) continue;
    const x = JSON.parse(line);
    if (log) fs.appendFileSync(log, line + '\n');
    if (x.type === 'open_session') {
      if (x.sessionPath === stored && pathOpens++ === 0) {
        process.stdout.write(JSON.stringify({type:'response',command:'open_session',success:false,id:x.id,error:'session_path_in_use'}) + '\n');
      } else {
        const identity = x.sessionPath || 'fresh-cwd-session.jsonl';
        process.stdout.write(JSON.stringify({type:'response',command:'open_session',success:true,id:x.id,sessionId:'rpc-1',data:{sessionId:'rpc-1',state:{sessionFile:identity,sessionId:'rpc-1'}}}) + '\n');
      }
    } else if (x.type === 'close_session') {
      process.stdout.write(JSON.stringify({type:'response',command:'close_session',success:true,id:x.id}) + '\n');
    }
  }
});
`

type identityLog struct {
	mu    sync.Mutex
	value string
	calls []string
}

func (l *identityLog) persist(_ *Session, identity ResumeIdentity) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.calls = append(l.calls, identity.Value)
	l.value = identity.Value
	return nil
}

func (l *identityLog) snapshot() (string, []string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.value, append([]string(nil), l.calls...)
}

func assertStoredIdentityUnchanged(t *testing.T, log *identityLog, original string) {
	t.Helper()
	stored, calls := log.snapshot()
	for _, value := range calls {
		if value == "" || value != original {
			t.Fatalf("OnResumeIdentity invoked with %q (calls=%v); stored identity must stay %q", value, calls, original)
		}
	}
	if stored != original {
		t.Fatalf("stored identity = %q, want unchanged %q (calls=%v)", stored, original, calls)
	}
}

func resumeFailedCount(frames [][]byte) int {
	n := 0
	for _, raw := range frames {
		var frame ErrorFrame
		if json.Unmarshal(raw, &frame) == nil && frame.Type == "error" && frame.Code == "resume_failed" {
			n++
		}
	}
	return n
}

func sessionPathOpens(cmds []map[string]any, path string) int {
	n := 0
	for _, cmd := range cmds {
		if cmd["type"] != "open_session" {
			continue
		}
		got, _ := cmd["sessionPath"].(string)
		if got == path {
			n++
		}
	}
	return n
}

func readCommandLog(t *testing.T, path string) []map[string]any {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read command log: %v", err)
	}
	var cmds []map[string]any
	for _, line := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var cmd map[string]any
		if err := json.Unmarshal([]byte(line), &cmd); err != nil {
			t.Fatalf("decode command log %q: %v", line, err)
		}
		cmds = append(cmds, cmd)
	}
	return cmds
}

type attachOutcome struct {
	session *Session
	started bool
	detach  func()
	err     error
}

func waitAttach(t *testing.T, ch <-chan attachOutcome) attachOutcome {
	t.Helper()
	select {
	case got := <-ch:
		if got.detach != nil {
			t.Cleanup(got.detach)
		}
		return got
	case <-time.After(5 * time.Second):
		t.Fatal("AcquireAttach timed out")
	}
	return attachOutcome{}
}

func runScriptedAcquire(t *testing.T, opts SessionOptions, writer FrameWriter, openReply func(cmd map[string]any) (ok bool, errMsg, handle, identity string)) (*Session, []map[string]any, error) {
	t.Helper()
	if opts.Binary == "" {
		opts.Binary = "unused"
	}
	commands := make(chan []byte, 8)
	provider := fakeSharedProvider(commands)
	manager := NewManager()
	manager.provider = provider

	var mu sync.Mutex
	var log []map[string]any
	go func() {
		for raw := range commands {
			cmd := decodeCommand(t, raw)
			mu.Lock()
			log = append(log, cmd)
			mu.Unlock()
			id, _ := cmd["id"].(string)
			switch cmd["type"] {
			case "open_session":
				ok, errMsg, handle, identity := openReply(cmd)
				var payload []byte
				if !ok {
					payload, _ = json.Marshal(map[string]any{
						"type": "response", "command": "open_session", "success": false, "id": id, "error": errMsg,
					})
				} else {
					payload, _ = json.Marshal(map[string]any{
						"type": "response", "command": "open_session", "success": true, "id": id,
						"sessionId": handle,
						"data":      map[string]any{"sessionId": handle, "state": map[string]any{"sessionFile": identity}},
					})
				}
				provider.route(Event{Type: "response", Raw: payload})
			case "close_session":
				payload, _ := json.Marshal(map[string]any{"type": "response", "command": "close_session", "success": true, "id": id})
				provider.route(Event{Type: "response", Raw: payload})
			}
		}
	}()
	t.Cleanup(manager.CloseAll)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	result := make(chan attachOutcome, 1)
	go func() {
		session, started, detach, err := manager.AcquireAttach(ctx, opts, writer)
		result <- attachOutcome{session: session, started: started, detach: detach, err: err}
	}()
	got := waitAttach(t, result)
	mu.Lock()
	cmds := append([]map[string]any(nil), log...)
	mu.Unlock()
	return got.session, cmds, got.err
}

func failPathOpen(errMsg, freshHandle, freshIdentity string) func(map[string]any) (bool, string, string, string) {
	return func(cmd map[string]any) (bool, string, string, string) {
		path, _ := cmd["sessionPath"].(string)
		if path != "" {
			return false, errMsg, "", ""
		}
		return true, "", freshHandle, freshIdentity
	}
}

func TestAcquireAttachRetriesTransientSessionPathInUseAndKeepsIdentity(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skipf("node not in PATH: %v", err)
	}
	dir := t.TempDir()
	stored := filepath.Join(dir, "durable-session.jsonl")
	if err := os.WriteFile(stored, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	cmdLog := filepath.Join(dir, "rpc.jsonl")

	identities := &identityLog{value: stored}
	writer := newCollectWriter()
	manager := NewManager()
	t.Cleanup(manager.CloseAll)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	session, _, detach, err := manager.AcquireAttach(ctx, SessionOptions{
		ID:               "chat-resume-retry",
		Binary:           node,
		Args:             []string{"-e", resumeRetryProviderScript, "--"},
		Env:              append(os.Environ(), "RESUME_STORED_PATH="+stored, "RESUME_CMD_LOG="+cmdLog),
		Cwd:              dir,
		Provider:         "omo",
		PiSessionID:      stored,
		OnResumeIdentity: identities.persist,
		ProviderContext:  context.Background(),
	}, writer)
	if detach != nil {
		t.Cleanup(detach)
	}
	if err != nil {
		t.Fatalf("AcquireAttach: %v", err)
	}
	if session == nil {
		t.Fatal("AcquireAttach returned a nil session")
	}

	assertStoredIdentityUnchanged(t, identities, stored)
	if n := resumeFailedCount(writer.snapshot()); n != 0 {
		t.Fatalf("resume_failed frames = %d, want 0; frames: %s", n, writer.typesString())
	}
	if got := sessionPathOpens(readCommandLog(t, cmdLog), stored); got != 2 {
		t.Fatalf("open_session{sessionPath=%q} count = %d, want 2 (one transient failure, one retry)", stored, got)
	}
	if got := session.PiSessionID(); got != stored {
		t.Fatalf("in-memory identity = %q, want resumed %q", got, stored)
	}
}

func TestAcquireAttachPermanentFailureKeepsStoredIdentityAndSurfacesError(t *testing.T) {
	dir := t.TempDir()
	stored := filepath.Join(dir, "real-session.jsonl")
	if err := os.WriteFile(stored, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	const freshIdentity = "fresh-identity.jsonl"

	identities := &identityLog{value: stored}
	writer := newCollectWriter()
	session, _, err := runScriptedAcquire(t, SessionOptions{
		ID:               "chat-resume-permanent",
		Cwd:              dir,
		Provider:         "omo",
		PiSessionID:      stored,
		OnResumeIdentity: identities.persist,
	}, writer, failPathOpen("open_failed: provider rejected session", "rpc-fresh", freshIdentity))
	if err != nil {
		t.Fatalf("AcquireAttach: %v", err)
	}
	if session == nil || !session.ProcessAlive() {
		t.Fatal("permanent resume failure did not leave a usable cwd session")
	}
	if n := resumeFailedCount(writer.snapshot()); n != 1 {
		t.Fatalf("resume_failed frames = %d, want 1; frames: %s", n, writer.typesString())
	}
	assertStoredIdentityUnchanged(t, identities, stored)
}

func TestAcquireAttachDanglingStoredPathSurfacesErrorAndKeepsIdentity(t *testing.T) {
	dangling := filepath.Join(t.TempDir(), "missing-dir", "session.jsonl")
	if _, err := os.Stat(dangling); !os.IsNotExist(err) {
		t.Fatalf("setup: dangling path %q unexpectedly exists: %v", dangling, err)
	}
	const freshIdentity = "fresh-identity.jsonl"

	identities := &identityLog{value: dangling}
	writer := newCollectWriter()
	// The provider alone owns resume validity: the doomed path open is sent,
	// rejected (open_failed), surfaced as resume_failed, and answered with a
	// fresh cwd session — while the persisted binding stays untouched.
	session, cmds, err := runScriptedAcquire(t, SessionOptions{
		ID:               "chat-resume-dangling",
		Cwd:              t.TempDir(),
		Provider:         "omo",
		PiSessionID:      dangling,
		OnResumeIdentity: identities.persist,
	}, writer, failPathOpen("open_failed: no such session", "rpc-fresh", freshIdentity))
	if err != nil {
		t.Fatalf("AcquireAttach: %v", err)
	}
	if session == nil || !session.ProcessAlive() {
		t.Fatal("dangling stored path did not leave a usable cwd session")
	}
	if n := sessionPathOpens(cmds, dangling); n != 1 {
		t.Fatalf("open_session was sent %d time(s) for dangling path %q, want exactly 1 (the provider owns validity); commands: %v", n, dangling, cmds)
	}
	if n := resumeFailedCount(writer.snapshot()); n != 1 {
		t.Fatalf("resume_failed frames = %d, want 1; frames: %s", n, writer.typesString())
	}
	assertStoredIdentityUnchanged(t, identities, dangling)
}
