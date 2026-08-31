package api

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/lxzan/gws"

	"github.com/DevNewbie1826/omo-webchat/internal/store"
)

// TestChatOpenDisconnectDoesNotBlockAnotherLifecycleOperation covers the API
// lifecycle lock around a provider that starts, receives open_session, and
// deliberately never responds. The provider holds a TCP connection open so
// both request receipt and process teardown have exact observable signals.
func TestChatOpenDisconnectDoesNotBlockAnotherLifecycleOperation(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skipf("node not in PATH: %v", err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen for provider signal: %v", err)
	}
	defer func() { _ = listener.Close() }()

	script := filepath.Join(t.TempDir(), "silent-open.mjs")
	if err := os.WriteFile(script, []byte(`import net from 'node:net';
let input = '';
let lifetime;
process.stdin.on('data', chunk => {
  input += chunk;
  for (let newline; (newline = input.indexOf('\n')) >= 0;) {
    const command = JSON.parse(input.slice(0, newline));
    input = input.slice(newline + 1);
    if (command.type === 'open_session' && !lifetime) {
      lifetime = net.createConnection({host: '127.0.0.1', port: Number(process.env.OPEN_NOTIFY_PORT)});
      lifetime.on('error', () => {});
    }
  }
});
`), 0o600); err != nil {
		t.Fatalf("write silent provider: %v", err)
	}
	t.Setenv("CHAT_PI_BINARY", node)
	t.Setenv("CHAT_PI_ARGS", script)
	_, port, err := net.SplitHostPort(listener.Addr().String())
	if err != nil {
		t.Fatalf("split listener address: %v", err)
	}
	t.Setenv("OPEN_NOTIFY_PORT", port)

	srv, st, workspace := newChatCreateTestServer(t)
	t.Cleanup(srv.chats.CloseAll)
	opening, err := st.NewChat(workspace.ID, "opening", workspace.Path, "", "omo")
	if err != nil {
		t.Fatalf("create opening chat: %v", err)
	}
	deleting, err := st.NewChat(workspace.ID, "deleting", workspace.Path, "", "omo")
	if err != nil {
		t.Fatalf("create deleting chat: %v", err)
	}

	// Keep the production context shape but inject a long test deadline: the
	// exact disconnect below, not elapsed wall time, drives cancellation.
	srv.openChatContext = func(parent context.Context, _ time.Duration) (context.Context, context.CancelFunc) {
		return context.WithTimeout(parent, time.Hour)
	}
	connectionCtx, cancelConnection := context.WithCancel(context.Background())
	socket := &gws.Conn{}
	h := &connHandler{srv: srv, conn: socket, ctx: connectionCtx, cancel: cancelConnection}
	srv.conns.Store(socket, h)

	createDone := make(chan struct{})
	go func() {
		srv.handleChatCreate(h, []byte(`{"wsId":"`+workspace.ID+`","chatId":"`+opening.ID+`"}`))
		close(createDone)
	}()

	providerConnReady := make(chan net.Conn, 1)
	providerAcceptErr := make(chan error, 1)
	go func() {
		conn, acceptErr := listener.Accept()
		if acceptErr != nil {
			providerAcceptErr <- acceptErr
			return
		}
		providerConnReady <- conn
	}()
	var providerConn net.Conn
	select {
	case providerConn = <-providerConnReady:
		defer func() { _ = providerConn.Close() }()
	case acceptErr := <-providerAcceptErr:
		t.Fatalf("accept provider signal: %v", acceptErr)
	case <-time.After(3 * time.Second):
		t.Fatal("provider did not receive open_session")
	}

	deleted := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		req := httptest.NewRequest(http.MethodDelete, "/api/workspaces/"+workspace.ID+"/chats/"+deleting.ID, nil)
		req.SetPathValue("wsId", workspace.ID)
		req.SetPathValue("chatId", deleting.ID)
		rec := httptest.NewRecorder()
		srv.handleDeleteChat(rec, req)
		deleted <- rec
	}()
	select {
	case rec := <-deleted:
		if rec.Code != http.StatusNoContent {
			t.Fatalf("concurrent delete status = %d, want %d; body: %s", rec.Code, http.StatusNoContent, rec.Body.String())
		}
	case <-time.After(time.Second):
		// Release an implementation that still holds chatLifecycleMu before
		// failing, so test cleanup never leaves its provider behind.
		srv.OnClose(socket, nil)
		<-createDone
		t.Fatal("chat delete was blocked by the pending open_session")
	}
	if _, err := st.GetChat(workspace.ID, deleting.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("deleted chat lookup error = %v, want not found", err)
	}

	providerExited := make(chan error, 1)
	go func() {
		_, readErr := providerConn.Read(make([]byte, 1))
		providerExited <- readErr
	}()
	// OnClose is the initiating connection's lifetime signal. It must cancel
	// the pending open and terminate the silent shared provider.
	srv.OnClose(socket, nil)
	select {
	case <-createDone:
	case <-time.After(time.Second):
		t.Fatal("chat open did not cancel with its WebSocket connection")
	}
	select {
	case readErr := <-providerExited:
		if readErr != nil && !errors.Is(readErr, io.EOF) {
			t.Fatalf("provider lifetime connection ended with %v", readErr)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("cancelled open did not terminate the shared provider")
	}
	if session := srv.chats.Get(opening.ID); session != nil {
		t.Fatalf("cancelled open leaked session %p", session)
	}
	if ids := srv.chats.LiveIDs(); len(ids) != 0 {
		t.Fatalf("cancelled open left live sessions: %v", ids)
	}
}
