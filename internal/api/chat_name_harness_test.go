package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lxzan/gws"

	"github.com/DevNewbie1826/omo-webchat/internal/auth"
	"github.com/DevNewbie1826/omo-webchat/internal/chat"
	"github.com/DevNewbie1826/omo-webchat/internal/config"
	"github.com/DevNewbie1826/omo-webchat/internal/store"
)

// nameTitleEnv spins a WS server backed by the name_pi fake provider, which
// logs every stdin command to rpcLog and emits session_info_changed whenever
// a trigger file appears.
type nameTitleEnv struct {
	srv        *Server
	st         *store.Store
	ws         store.Workspace
	client     *gws.Conn
	frames     *frameCollector
	rpcLog     string
	triggerDir string
}

func namePiPath(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(wd, "testdata", "name_pi.mjs")
	if _, err := os.Stat(p); err != nil {
		t.Skipf("name_pi fixture not found: %v", err)
	}
	return p
}

func newNameTitleEnv(t *testing.T) *nameTitleEnv {
	t.Helper()
	if _, err := exec.LookPath("node"); err != nil {
		t.Skipf("node not in PATH: %v", err)
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CHAT_PI_BINARY", "node")
	t.Setenv("CHAT_PI_ARGS", namePiPath(t))
	rpcLog := filepath.Join(home, "rpc.jsonl")
	trigger := filepath.Join(home, "trigger.json")
	t.Setenv("NAME_PI_LOG", rpcLog)
	t.Setenv("NAME_PI_TRIGGER", trigger)

	ctx := context.Background()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	st, err := store.Load(ctx, logger)
	if err != nil {
		t.Fatalf("load store: %v", err)
	}
	ws, err := st.CreateWorkspace("demo", home)
	if err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	srv := New(ctx, &config.Config{Root: home, Provider: "omo"}, st, auth.NewSessionStore(ctx, "pw", logger), logger)
	t.Cleanup(srv.chats.CloseAll)
	server := httptest.NewServer(http.HandlerFunc(srv.handleWS))
	t.Cleanup(server.Close)
	t.Cleanup(server.CloseClientConnections)

	frames := &frameCollector{notify: make(chan struct{}, 256)}
	client, _, err := gws.NewClient(frames, &gws.ClientOption{Addr: "ws" + strings.TrimPrefix(server.URL, "http")})
	if err != nil {
		t.Fatalf("connect ws: %v", err)
	}
	t.Cleanup(func() { _ = client.WriteClose(1000, nil) })
	go client.ReadLoop()
	return &nameTitleEnv{srv: srv, st: st, ws: ws, client: client, frames: frames, rpcLog: rpcLog, triggerDir: filepath.Dir(trigger)}
}

func (e *nameTitleEnv) triggerPath() string {
	return filepath.Join(e.triggerDir, "trigger.json")
}

// startChat persists a default-named chat and attaches it to the WS client.
func (e *nameTitleEnv) startChat(t *testing.T, name string) store.Chat {
	t.Helper()
	record, err := e.st.NewChat(e.ws.ID, name, e.ws.Path, "", "omo")
	if err != nil {
		t.Fatalf("create chat: %v", err)
	}
	writeFrame(t, e.client, map[string]any{"type": "chat.create", "wsId": e.ws.ID, "chatId": record.ID})
	e.frames.waitFor(t, "ready", 3*time.Second)
	return record
}

func (e *nameTitleEnv) sendPrompt(t *testing.T, chatID, message string) {
	t.Helper()
	writeFrame(t, e.client, map[string]any{
		"type":      "chat.send",
		"sessionId": chatID,
		"run":       map[string]any{"kind": "prompt", "message": message},
	})
}

func (e *nameTitleEnv) rename(t *testing.T, chatID, name string) {
	t.Helper()
	body, err := json.Marshal(map[string]string{"name": name})
	if err != nil {
		t.Fatalf("marshal rename body: %v", err)
	}
	req := httptest.NewRequest(http.MethodPatch, "/api/workspaces/"+e.ws.ID+"/chats/"+chatID, strings.NewReader(string(body)))
	req.SetPathValue("wsId", e.ws.ID)
	req.SetPathValue("chatId", chatID)
	rec := httptest.NewRecorder()
	e.srv.handleRenameChat(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("rename status = %d, want %d; body: %s", rec.Code, http.StatusOK, rec.Body.String())
	}
}

// emitProviderName drops the trigger file that makes the fake provider send
// session_info_changed with the given name.
func (e *nameTitleEnv) emitProviderName(t *testing.T, name string) {
	t.Helper()
	body, err := json.Marshal(map[string]string{"name": name})
	if err != nil {
		t.Fatalf("marshal trigger: %v", err)
	}
	if err := os.WriteFile(e.triggerPath(), body, 0o644); err != nil {
		t.Fatalf("write trigger: %v", err)
	}
}

// waitForProviderLog waits (bounded) until the fake provider logged a command
// of the given type carrying the given name.
func (e *nameTitleEnv) waitForProviderLog(t *testing.T, typ, name string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if raw, err := os.ReadFile(e.rpcLog); err == nil && providerLogContains(string(raw), typ, name) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	raw, _ := os.ReadFile(e.rpcLog)
	t.Fatalf("provider never received %s with name %q; log: %s", typ, name, string(raw))
}

func providerLogContains(raw, typ, name string) bool {
	for _, line := range strings.Split(raw, "\n") {
		if line == "" {
			continue
		}
		var entry struct {
			Type string `json:"type"`
			Name string `json:"name"`
		}
		if json.Unmarshal([]byte(line), &entry) == nil && entry.Type == typ && entry.Name == name {
			return true
		}
	}
	return false
}

// waitForStoreChat waits (bounded) until the stored record carries the exact
// name and name source.
func (e *nameTitleEnv) waitForStoreChat(t *testing.T, chatID, wantName, wantSource string) store.Chat {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		got, err := e.st.GetChat(e.ws.ID, chatID)
		if err != nil {
			t.Fatalf("get chat: %v", err)
		}
		if got.Name == wantName && got.NameSource == wantSource {
			return got
		}
		if time.Now().After(deadline) {
			t.Fatalf("stored chat name = %q source %q, want %q/%q", got.Name, got.NameSource, wantName, wantSource)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func (f *frameCollector) waitForNameFrame(t *testing.T, origin string, timeout time.Duration) chat.NameFrame {
	t.Helper()
	frame, _ := f.waitForNameFrameCount(t, origin, 1, timeout)
	return frame
}

// waitForNameFrameCount waits until at least `want` chat.name frames with the
// given origin arrived. Watching for a second frame is a sequencing barrier:
// provider events dispatch sequentially, so frame N+1 being observable proves
// frame N's persistence callback already ran.
func (f *frameCollector) waitForNameFrameCount(t *testing.T, origin string, want int, timeout time.Duration) (chat.NameFrame, int) {
	t.Helper()
	deadline := time.After(timeout)
	for {
		seen := 0
		var match chat.NameFrame
		for _, b := range f.snapshot() {
			var env struct {
				Type   string `json:"type"`
				Origin string `json:"origin"`
			}
			if json.Unmarshal(b, &env) != nil || env.Type != "chat.name" || env.Origin != origin {
				continue
			}
			seen++
			if seen == 1 {
				if err := json.Unmarshal(b, &match); err != nil {
					t.Fatalf("decode chat.name frame: %v", err)
				}
			}
		}
		if seen >= want {
			return match, seen
		}
		select {
		case <-f.notify:
		case <-deadline:
			t.Fatalf("timed out waiting for %d chat.name frames (origin %s); have: %s", want, origin, f.types())
		}
	}
}
