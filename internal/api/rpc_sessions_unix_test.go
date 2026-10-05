//go:build darwin || linux

package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lxzan/gws"

	"github.com/DevNewbie1826/omo-webchat/internal/auth"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
	"github.com/DevNewbie1826/omo-webchat/internal/rpcwatch"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
	"github.com/DevNewbie1826/omo-webchat/internal/wsbridge"
)

func TestRPCOpenMissingFileWebSocketChain(t *testing.T) {
	server, store, ws := newChatCreateTestServer(t)
	dir, err := os.MkdirTemp("", "unified-chain-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(dir); err != nil {
			t.Error(err)
		}
		t.Log("cleanup: removed unified daemon socket directory")
	})
	daemon := omorpctest.New(dir)
	daemon.SetSameRouteOpen(true)
	if err := daemon.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { daemon.Stop(); t.Log("cleanup: daemon stopped") })
	client, err := omorpc.Dial(t.Context(), daemon.SocketPath())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { client.Close() })
	path := filepath.Join(dir, "unpersisted.jsonl")
	response, err := client.Call(t.Context(), omorpc.OpenSession{CWD: ws.Path, SessionPath: path})
	if err != nil {
		t.Fatal(err)
	}
	var original omorpc.OpenSessionData
	if err := json.Unmarshal(response.Data, &original); err != nil {
		t.Fatal(err)
	}
	server.rpcWatcher = rpcwatch.New(client)
	server.rpcWatcher.Tick(t.Context())
	server.manager = session.NewManager(session.Config{Client: client, Store: (*wsbridge.CursorStore)(store.Store)})
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), session.DefaultCloseTimeout)
		defer cancel()
		if err := server.manager.CloseAll(ctx); err != nil {
			t.Error(err)
		}
		t.Log("cleanup: manager routes closed")
	})
	bridge := wsbridge.New(wsbridge.Config{Context: context.Background(), Manager: server.manager, Store: store.Store, Logger: server.logger,
		PrepareChatVersion: server.prepareChatVersion, ChatVersion: server.chatLifecycleVersion})
	server.bridge = bridge
	t.Cleanup(bridge.CloseConnections)
	status, opened := rpcOpenHTTP(t, server, ws.ID, original.SessionID)
	if status != 201 {
		t.Fatalf("open status=%d", status)
	}
	assertAbsent := func() {
		t.Helper()
		if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("file must remain absent: %v", err)
		}
	}
	assertAbsent()
	httpServer := httptest.NewServer(server.Handler())
	t.Cleanup(func() { httpServer.Close(); t.Log("cleanup: HTTP server closed") })
	token, err := server.sessions.Create(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	collector := &adoptionWSCollector{frames: make(chan map[string]any, 128)}
	conn, _, err := gws.NewClient(collector, &gws.ClientOption{
		Addr:          "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/api/v2/ws",
		RequestHeader: http.Header{"Cookie": []string{auth.CookieName + "=" + token}},
	})
	if err != nil {
		t.Fatal(err)
	}
	readDone := make(chan struct{})
	go func() { conn.ReadLoop(); close(readDone) }()
	t.Cleanup(func() {
		conn.WriteClose(1000, nil)
		bridge.CloseConnections()
		<-readDone
		t.Log("cleanup: WebSocket read loop stopped")
	})
	collector.next(t, "hello")
	write := func(frame any) {
		t.Helper()
		raw, err := json.Marshal(frame)
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("WS /api/v2/ws send %s", raw)
		if err := conn.WriteMessage(gws.OpcodeText, raw); err != nil {
			t.Fatal(err)
		}
	}
	next := func(typ string) map[string]any {
		t.Helper()
		ctx, cancel := context.WithTimeout(t.Context(), session.DefaultCloseTimeout)
		defer cancel()
		for {
			select {
			case frame := <-collector.frames:
				t.Logf("WS receive %+v", frame)
				if frame["type"] == "error" {
					t.Fatalf("WS error: %+v", frame)
				}
				if frame["type"] == typ {
					return frame
				}
			case <-ctx.Done():
				t.Fatalf("no %s frame: %v", typ, ctx.Err())
			}
		}
	}
	write(map[string]any{"type": "hello", "version": 4})
	write(map[string]any{"type": "chat.create", "wsId": ws.ID, "chatId": opened.ID})
	next("ready")
	assertAbsent()
	owned, _ := server.manager.Get(opened.ID)
	if owned == nil || owned.RoutingID() != original.SessionID {
		t.Fatalf("did not attach same route: %v", owned)
	}
	daemon.SetPromptScript(path,
		map[string]any{"type": omorpctest.EventAgentStart},
		map[string]any{"type": omorpctest.EventAgentSettled, "reason": "end_turn"})
	write(map[string]any{"type": "chat.send", "sessionId": opened.ID, "run": map[string]any{"kind": "prompt", "message": "unified first prompt"}})
	next("run.started")
	next("run.done")
	assertAbsent()
	prompt := daemon.LastRequest(omorpc.CmdPrompt)
	if prompt["sessionId"] != original.SessionID {
		t.Fatalf("prompt route=%v want=%s", prompt, original.SessionID)
	}
	t.Logf("PASS: forced missing-file create/send kept route=%s; source absent", original.SessionID)
	// The route-independent cursor gate must not retain authorization.
	if _, err := (*wsbridge.CursorStore)(store.Store).CursorForOpen(t.Context(), opened.ID); err == nil {
		t.Fatal("non-forced missing file accepted")
	}
}
