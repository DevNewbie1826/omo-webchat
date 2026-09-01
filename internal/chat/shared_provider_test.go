package chat

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeSpawnCountingProviderWrapper(t *testing.T, spawnLog string) string {
	t.Helper()
	wrapper := filepath.Join(t.TempDir(), "provider-wrapper")
	script := fmt.Sprintf("#!/bin/sh\nprintf 'spawn\\n' >> %q\nexec \"$@\"\n", spawnLog)
	if err := os.WriteFile(wrapper, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return wrapper
}

func providerSpawnCount(t *testing.T, spawnLog string) int {
	t.Helper()
	spawned, err := os.ReadFile(spawnLog)
	if err != nil {
		t.Fatal(err)
	}
	return strings.Count(string(spawned), "spawn\n")
}

func waitForSessionExits(t *testing.T, exited <-chan *Session, count int) map[*Session]bool {
	t.Helper()
	got := make(map[*Session]bool, count)
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	for len(got) < count {
		select {
		case session := <-exited:
			got[session] = true
		case <-timer.C:
			t.Fatalf("timed out waiting for %d session exits; got %d", count, len(got))
		}
	}
	return got
}

func assertProviderEOF(t *testing.T, writer *collectWriter, sessionID string) {
	t.Helper()
	for _, raw := range writer.snapshot() {
		var frame ErrorFrame
		if json.Unmarshal(raw, &frame) == nil && frame.Type == "error" && frame.Code == "pi_eof" && frame.SessionID == sessionID {
			return
		}
	}
	t.Fatalf("session %s did not receive its pi_eof terminal frame; frames: %s", sessionID, writer.typesString())
}

func TestManagerSharesOneProviderAndDemultiplexesSessions(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skipf("node not in PATH: %v", err)
	}
	spawnLog := filepath.Join(t.TempDir(), "spawns.log")
	wrapper := writeSpawnCountingProviderWrapper(t, spawnLog)

	manager := NewManager()
	t.Cleanup(manager.CloseAll)
	writerA := newCollectWriter()
	writerB := newCollectWriter()
	baseArgs := []string{node, mockPiScript(t)}
	sessionA, started, _, err := manager.AcquireAttach(context.Background(), SessionOptions{
		ID: "chat-a", Binary: wrapper, Args: baseArgs, Env: os.Environ(), Cwd: t.TempDir(),
		ProviderContext: context.Background(),
	}, writerA)
	if err != nil || !started {
		t.Fatalf("attach chat-a = started %v, err %v", started, err)
	}
	sessionB, started, _, err := manager.AcquireAttach(context.Background(), SessionOptions{
		ID: "chat-b", Binary: wrapper, Args: baseArgs, Env: os.Environ(), Cwd: t.TempDir(),
	}, writerB)
	if err != nil || !started {
		t.Fatalf("attach chat-b = started %v, err %v", started, err)
	}
	if sessionA.shared != sessionB.shared {
		t.Fatal("sessions were bound to different provider runtimes")
	}

	if err := sessionA.SendPrompt("alpha-only", nil); err != nil {
		t.Fatal(err)
	}
	if err := sessionB.SendPrompt("beta-only", nil); err != nil {
		t.Fatal(err)
	}
	writerA.waitForType(t, "run.done", 5*time.Second)
	writerB.waitForType(t, "run.done", 5*time.Second)

	assertStream := func(writer *collectWriter, want, forbidden string) {
		t.Helper()
		var text strings.Builder
		for _, raw := range writer.snapshot() {
			var frame MessageDeltaFrame
			if json.Unmarshal(raw, &frame) == nil && frame.Type == "messageDelta" {
				text.WriteString(frame.Delta.Delta)
			}
		}
		if !strings.Contains(text.String(), want) {
			t.Fatalf("stream %q does not contain %q", text.String(), want)
		}
		if strings.Contains(text.String(), forbidden) {
			t.Fatalf("stream %q leaked %q from the other session", text.String(), forbidden)
		}
	}
	assertStream(writerA, "alpha-only", "beta-only")
	assertStream(writerB, "beta-only", "alpha-only")

	if got := providerSpawnCount(t, spawnLog); got != 1 {
		t.Fatalf("provider spawn count = %d, want exactly 1", got)
	}
}

func TestSharedProviderDeathFinishesEveryAttachedSession(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skipf("node not in PATH: %v", err)
	}
	manager := NewManager()
	t.Cleanup(manager.CloseAll)
	exited := make(chan *Session, 2)
	writerA, writerB := newCollectWriter(), newCollectWriter()
	base := SessionOptions{Binary: node, Args: []string{mockPiScript(t)}, Env: os.Environ(), OnExit: func(session *Session) { exited <- session }}
	optsA := base
	optsA.ID = "chat-death-a"
	optsA.ProviderContext = context.Background()
	sessionA, _, _, err := manager.AcquireAttach(context.Background(), optsA, writerA)
	if err != nil {
		t.Fatal(err)
	}
	optsB := base
	optsB.ID = "chat-death-b"
	sessionB, _, _, err := manager.AcquireAttach(context.Background(), optsB, writerB)
	if err != nil {
		t.Fatal(err)
	}
	provider := sessionShared(sessionA)
	if provider == nil || sessionShared(sessionB) != provider {
		t.Fatal("sessions do not share the provider selected for the death test")
	}

	if err := provider.proc.cmd.Process.Kill(); err != nil {
		t.Fatalf("kill shared provider: %v", err)
	}
	got := waitForSessionExits(t, exited, 2)
	if !got[sessionA] || !got[sessionB] {
		t.Fatalf("exit callbacks = %v, want both sessions", got)
	}
	for _, session := range []*Session{sessionA, sessionB} {
		session.mu.Lock()
		finished := session.done && session.runDone && !session.promptInFlight && !session.providerRunActive && !session.compactionActive
		session.mu.Unlock()
		if !finished || session.ProcessAlive() {
			t.Fatalf("session %s was not marked finished after shared provider death", session.ID())
		}
		if manager.Get(session.ID()) != nil {
			t.Fatalf("session %s remained registered after shared provider death", session.ID())
		}
	}
	assertProviderEOF(t, writerA, sessionA.ID())
	assertProviderEOF(t, writerB, sessionB.ID())
}

func TestManagerRestartsProviderAndReopensDurableSessionPath(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skipf("node not in PATH: %v", err)
	}
	dir := t.TempDir()
	spawnLog := filepath.Join(dir, "spawns.log")
	rpcLog := filepath.Join(dir, "rpc.jsonl")
	sessionPath := filepath.Join(dir, "durable-session.jsonl")
	if err := os.WriteFile(sessionPath, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	wrapper := writeSpawnCountingProviderWrapper(t, spawnLog)
	env := append(os.Environ(), "MOCK_PI_LOG_JSON="+rpcLog, "MOCK_PI_RESUME_IDENTITY="+sessionPath)
	base := SessionOptions{ID: "chat-reopen", Binary: wrapper, Args: []string{node, mockPiScript(t)}, Env: env, Cwd: dir, ProviderContext: context.Background()}

	manager := NewManager()
	t.Cleanup(manager.CloseAll)
	exited := make(chan *Session, 1)
	firstOpts := base
	firstOpts.OnExit = func(session *Session) { exited <- session }
	first, _, err := manager.Acquire(context.Background(), firstOpts)
	if err != nil {
		t.Fatal(err)
	}
	if got := first.PiSessionID(); got != sessionPath {
		t.Fatalf("first durable identity = %q, want %q", got, sessionPath)
	}
	if got := providerSpawnCount(t, spawnLog); got != 1 {
		t.Fatalf("provider spawn count before death = %d, want 1", got)
	}
	provider := sessionShared(first)
	if provider == nil {
		t.Fatal("first session has no shared provider")
	}
	if err := provider.proc.cmd.Process.Kill(); err != nil {
		t.Fatalf("kill first provider: %v", err)
	}
	if got := waitForSessionExits(t, exited, 1); !got[first] {
		t.Fatalf("first session exit callback missing: %v", got)
	}

	reopenOpts := base
	reopenOpts.PiSessionID = sessionPath
	reopened, started, err := manager.Acquire(context.Background(), reopenOpts)
	if err != nil {
		t.Fatal(err)
	}
	if !started || reopened == first {
		t.Fatalf("reopen = session %p started %v, want a newly opened session", reopened, started)
	}
	if got := providerSpawnCount(t, spawnLog); got != 2 {
		t.Fatalf("provider spawn count after recovery = %d, want 2", got)
	}

	lines := readRPCLogLines(t, rpcLog)
	var opens []map[string]any
	for _, line := range lines {
		var command map[string]any
		if err := json.Unmarshal([]byte(line), &command); err != nil {
			t.Fatalf("decode RPC log line %q: %v", line, err)
		}
		if command["type"] == "open_session" {
			opens = append(opens, command)
		}
	}
	if len(opens) != 2 {
		t.Fatalf("open_session RPCs = %d, want 2; log: %v", len(opens), lines)
	}
	if got, ok := opens[1]["sessionPath"].(string); !ok || got != sessionPath {
		t.Fatalf("recovery open_session sessionPath = %#v, want %q", opens[1]["sessionPath"], sessionPath)
	}
	if _, exists := opens[1]["cwd"]; exists {
		t.Fatalf("recovery open_session unexpectedly carried cwd: %#v", opens[1])
	}
}
