//go:build darwin || linux

package api

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
	"github.com/DevNewbie1826/omo-webchat/internal/rpcwatch"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
	"github.com/DevNewbie1826/omo-webchat/internal/wsbridge"
)

func TestUnifiedSessionManagerOwnedRouteKeepsManagerStatus(t *testing.T) {
	s, st, ws := newChatCreateTestServer(t)
	dir, err := os.MkdirTemp("", "unified-owner-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(dir); err != nil {
			t.Error(err)
		}
		t.Log("cleanup: removed unified-owner socket directory")
	})
	daemon := omorpctest.New(dir)
	if err := daemon.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(daemon.Stop)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	client, err := omorpc.Dial(ctx, daemon.SocketPath())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { client.Close() })
	s.manager = session.NewManager(session.Config{Client: client, Store: (*wsbridge.CursorStore)(st.Store)})
	t.Cleanup(func() {
		closeCtx, cancelClose := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancelClose()
		if err := s.manager.CloseAll(closeCtx); err != nil {
			t.Error(err)
		}
		t.Log("cleanup: manager and shared client closed; daemon stopped")
	})
	chat := cursorstore.Chat{ID: "owned", WorkspaceID: ws.ID, CWD: ws.Path, SessionProvenance: cursorstore.SessionProvenanceNative}
	if err := st.SaveChat(chat); err != nil {
		t.Fatal(err)
	}
	owned, _, detach, err := s.manager.Acquire(ctx, adoptionChatRef{chat: chat}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer detach()
	unifiedWatch(t, s, []rpcwatch.Session{{SessionID: owned.RoutingID(), DurableSessionID: owned.ID(), SessionPath: owned.SessionFile(), Cwd: ws.Path, Status: "blocked"}})
	// When
	page := unifiedGet(t, s, ws.ID, "")
	// Then: watcher status is a supplement, never an override of manager ownership.
	if len(page.Live) != 0 || len(page.Items) != 1 || page.Items[0].Live != nil {
		t.Fatalf("owned route=%+v", page)
	}
}

func TestUnifiedSessionTmpPrivateTmpCanonicalMatch(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("/private/tmp spelling is specific to Darwin")
	}
	dir, err := os.MkdirTemp("/tmp", "unified-canonical-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(dir); err != nil {
			t.Error(err)
		}
		t.Log("cleanup: removed unified-canonical tmp directory")
	})
	canonical, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatal(err)
	}
	s, st, ws := newChatCreateTestServer(t)
	ws.Path = canonical
	if err := st.SaveWorkspace(ws); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveChat(cursorstore.Chat{ID: "bound", WorkspaceID: ws.ID, CWD: canonical, SessionFile: filepath.Join(canonical, "unpersisted.jsonl"), DurableSessionID: "durable"}); err != nil {
		t.Fatal(err)
	}
	unifiedWatch(t, s, []rpcwatch.Session{{SessionID: "route", DurableSessionID: "durable", SessionPath: filepath.Join(dir, "unpersisted.jsonl"), Cwd: dir, Status: "working"}})
	page := unifiedGet(t, s, ws.ID, "")
	if len(page.Live) != 0 || len(page.Items) != 1 || page.Items[0].Live == nil || page.Items[0].Live.Status != "working" {
		t.Fatalf("tmp alias page=%+v", page)
	}
}
