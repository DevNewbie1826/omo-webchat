package api

import (
	"context"
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
	"github.com/DevNewbie1826/omo-webchat/internal/config"
	"github.com/DevNewbie1826/omo-webchat/internal/store"
)

// The provider announces its session identity spontaneously right after the
// session opens, before chat.create has finished wiring the handler and
// without any client request correlating it. The report arrives tagged with
// the session's routing handle; persistence must not be lost to that race:
// the identity has to land in the store.
func TestWebSocketPersistsSpontaneousProviderIdentity(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skipf("node not in PATH: %v", err)
	}
	home := t.TempDir()
	script := filepath.Join(home, "eager-pi.mjs")
	eager := `import { randomUUID } from 'node:crypto';
const sessions = new Map();
let nextSessionNumber = 0;
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let nl = buf.indexOf('\n');
  while (nl !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    nl = buf.indexOf('\n');
    if (!line.trim()) continue;
    let cmd;
    try { cmd = JSON.parse(line); } catch { continue; }
    if (cmd.type === 'open_session') {
      const handle = 'rpc-' + (++nextSessionNumber);
      const session = { handle, durableSessionId: randomUUID(), closed: false };
      sessions.set(handle, session);
      send({ type: 'response', command: 'open_session', success: true, sessionId: handle, id: cmd.id, data: { sessionId: handle, state: { sessionId: session.durableSessionId, thinkingLevel: 'medium', isStreaming: false, isCompacting: false } } });
      // Spontaneous identity report: unsolicited, handle-tagged, no request id.
      send({ type: 'response', command: 'get_state', success: true, sessionId: handle, data: { sessionId: 'eager-identity-1', isStreaming: false, isCompacting: false } });
    } else {
      const s = sessions.get(cmd.sessionId);
      if (!s) { send({ type: 'response', command: cmd.type || 'parse', success: false, error: 'missing_session_id', id: cmd.id }); continue; }
      if (cmd.type === 'get_state') {
        // Bootstrap deliberately carries no identity. Only the unsolicited
        // frame above can persist eager-identity-1, so dropping that frame
        // cannot be masked by the later query response.
        send({ type: 'response', command: 'get_state', success: true, sessionId: s.handle, id: cmd.id, data: { isStreaming: false, isCompacting: false } });
      } else if (cmd.type === 'get_available_models') {
        send({ type: 'response', command: 'get_available_models', success: true, sessionId: s.handle, id: cmd.id, data: { models: [] } });
      } else if (cmd.type === 'get_commands') {
        send({ type: 'response', command: 'get_commands', success: true, sessionId: s.handle, id: cmd.id, data: { commands: [] } });
      } else if (cmd.type === 'get_entries') {
        send({ type: 'response', command: 'get_entries', success: true, sessionId: s.handle, id: cmd.id, data: { entries: [], leafId: null } });
      } else {
        send({ type: 'response', command: cmd.type, success: true, sessionId: s.handle, id: cmd.id });
      }
    }
  }
});
process.stdin.on('end', () => process.exit(0));
process.stdout.on('error', () => {});
`
	if err := os.WriteFile(script, []byte(eager), 0o644); err != nil {
		t.Fatalf("write eager provider: %v", err)
	}
	t.Setenv("HOME", home)
	t.Setenv("CHAT_PI_BINARY", node)
	t.Setenv("CHAT_PI_ARGS", script)

	ctx := context.Background()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	st, err := store.Load(ctx, logger)
	if err != nil {
		t.Fatalf("load store: %v", err)
	}
	workspace, err := st.CreateWorkspace("demo", home)
	if err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	chatRecord, err := st.NewChat(workspace.ID, "eager", workspace.Path, "", "omo")
	if err != nil {
		t.Fatalf("create chat: %v", err)
	}

	apiServer := New(ctx, &config.Config{Root: home}, st, auth.NewSessionStore(ctx, "pw", logger), logger)
	t.Cleanup(apiServer.chats.CloseAll)
	httpServer := httptest.NewServer(http.HandlerFunc(apiServer.handleWS))
	t.Cleanup(httpServer.Close)
	t.Cleanup(httpServer.CloseClientConnections)

	frames := &frameCollector{notify: make(chan struct{}, 256)}
	client, _, err := gws.NewClient(frames, &gws.ClientOption{Addr: "ws" + strings.TrimPrefix(httpServer.URL, "http")})
	if err != nil {
		t.Fatalf("connect ws: %v", err)
	}
	t.Cleanup(func() { _ = client.WriteClose(1000, nil) })
	go client.ReadLoop()

	writeFrame(t, client, map[string]any{"type": "chat.create", "wsId": workspace.ID, "chatId": chatRecord.ID})
	frames.waitFor(t, "state", 3*time.Second)

	persisted, err := st.GetChat(workspace.ID, chatRecord.ID)
	if err != nil {
		t.Fatalf("get persisted chat: %v", err)
	}
	if persisted.PiSessionID != "eager-identity-1" {
		t.Fatalf("stored identity = %q, want eager-identity-1", persisted.PiSessionID)
	}
}
