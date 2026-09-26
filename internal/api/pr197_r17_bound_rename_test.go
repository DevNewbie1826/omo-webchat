package api

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/auth"
	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
	"github.com/DevNewbie1826/omo-webchat/internal/wsbridge"
)

type pr197ReviewRenameGate struct {
	*wsbridge.CursorStore
	entered chan struct{}
	release chan struct{}
}

func (s *pr197ReviewRenameGate) UpdateName(ctx context.Context, id, name, source string) error {
	if name == "After" {
		close(s.entered)
		select {
		case <-s.release:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return s.CursorStore.UpdateName(ctx, id, name, source)
}

func TestPR197R16BoundHTTPRenameUsesOneExposedRevision(t *testing.T) {
	// Given a bound row already exposed on both authenticated wire surfaces.
	server, st, workspace := newChatCreateTestServer(t)
	chat := cursorstore.Chat{ID: "bound-rename", WorkspaceID: workspace.ID, CWD: workspace.Path, Name: "Before", NameSource: cursorstore.NameSourceUser}
	if err := st.SaveChat(chat); err != nil {
		t.Fatal(err)
	}
	dir, err := os.MkdirTemp("", "r16-rename-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(dir); err != nil {
			t.Error(err)
		}
	})
	daemon := omorpctest.New(dir)
	if err := daemon.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(daemon.Stop)
	client, err := omorpc.Dial(t.Context(), daemon.SocketPath())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := client.Close(); err != nil {
			t.Error(err)
		}
	})
	gate := &pr197ReviewRenameGate{CursorStore: (*wsbridge.CursorStore)(st.Store), entered: make(chan struct{}), release: make(chan struct{})}
	release := sync.OnceFunc(func() { close(gate.release) })
	defer release()
	manager := session.NewManager(session.Config{Client: client, Store: gate})
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := manager.CloseAll(ctx); err != nil {
			t.Error(err)
		}
	})
	server.manager = manager
	server.bridge = wsbridge.New(wsbridge.Config{Context: t.Context(), Manager: manager, Store: st.Store, ServerVersion: client.ServerVersion(), Logger: server.logger})
	httpServer := httptest.NewServer(server.Handler())
	t.Cleanup(httpServer.Close)
	token, err := server.sessions.Create(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	sess, _, detach, err := manager.Acquire(t.Context(), adoptionChatRef{chat: chat}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer detach()
	if err := sess.SetSessionName(t.Context(), "Before"); err != nil {
		t.Fatal(err)
	}
	f := &liveResolveFixture{&countsE2EFixture{t: t, daemon: daemon, client: client, store: st.Store, chat: chat, serverURL: httpServer.URL, token: token, manager: manager}}
	before := assertSoleLiveRow(t, f.serverURL, f.token)
	beforeWS := f.subscribeExplicit(chat.ID).next(t, "sessions.activity")

	// When PATCH has persisted the title but has not updated Session.title,
	// a concurrent REST read and a new WS subscription see the same row.
	renamed := make(chan error, 1)
	req, err := http.NewRequest(http.MethodPatch, f.serverURL+"/api/workspaces/"+workspace.ID+"/chats/"+chat.ID, bytes.NewBufferString(`{"name":"After"}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: token})
	go func() {
		resp, err := http.DefaultClient.Do(req)
		if err == nil {
			err = resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				err = fmt.Errorf("rename status: %d", resp.StatusCode)
			}
		}
		renamed <- err
	}()
	select {
	case <-gate.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("rename did not reach the store/session title boundary")
	}
	during := assertSoleLiveRow(t, f.serverURL, f.token)
	duringWS := f.subscribeExplicit(chat.ID).next(t, "sessions.activity")

	// Then a changed title must carry a newer revision on both surfaces.
	t.Logf("RENAME_BOUNDARY before REST=%v WS=%v; during REST=%v WS=%v", before, beforeWS, during, duringWS)
	if during["title"] != "After" {
		t.Errorf("stored rename was not exposed: %v", during)
	}
	if during["last_activity_ms"].(float64) <= before["last_activity_ms"].(float64) {
		t.Errorf("REST changed the visible title without advancing the revision: before=%v during=%v", before, during)
	}
	if duringWS["title"] != during["title"] || duringWS["last_activity_ms"] != during["last_activity_ms"] {
		t.Errorf("REST and WS disagree during a bound rename: REST=%v WS=%v", during, duringWS)
	}
	release()
	select {
	case err := <-renamed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("rename did not finish after releasing the gate")
	}
}
