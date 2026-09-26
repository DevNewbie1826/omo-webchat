package session_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
	"github.com/DevNewbie1826/omo-webchat/internal/wsbridge"
)

func TestUnboundOverviewResolvesRealStoredChat(t *testing.T) {
	root := t.TempDir()
	store, err := cursorstore.Open(filepath.Join(root, "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SaveWorkspace(cursorstore.Workspace{ID: "workspace", Path: root}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveChat(cursorstore.Chat{
		ID: "stored-chat", WorkspaceID: "workspace", CWD: root,
		DurableSessionID: "stored-durable", Name: "Stored title",
	}); err != nil {
		t.Fatal(err)
	}

	socketDir, err := os.MkdirTemp("", "sess-*")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(socketDir) })
	daemon := omorpctest.New(socketDir)
	if err := daemon.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(daemon.Stop)
	client, err := omorpc.Dial(context.Background(), daemon.SocketPath())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	manager := session.NewManager(session.Config{Client: client, Store: (*wsbridge.CursorStore)(store)})
	t.Cleanup(func() { _ = manager.CloseAll(context.Background()) })
	updates := make(chan session.Summary, 1)
	unsubscribe := manager.SubscribeOverview(func(snapshot session.Summary) { updates <- snapshot })
	defer unsubscribe()

	daemon.Emit(map[string]any{
		"type": "extension_event", "sessionId": "stored-durable", "name": "omo.task.updated",
		"data": map[string]any{"tasks": []any{}},
	})
	select {
	case got := <-updates:
		if got.ChatID != "stored-chat" || got.DurableSessionID != "stored-durable" || got.Title != "Stored title" {
			t.Fatalf("stored chat was not published by the production adapter: %+v", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("unbound overview was not published")
	}
	live := manager.LiveSummaries()
	if len(live) != 1 || live[0].ChatID != "stored-chat" || live[0].Title != "Stored title" {
		t.Fatalf("real stored chat did not resolve in live overview: %+v", live)
	}
}
