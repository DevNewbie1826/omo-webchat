package session_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/auth"
	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
)

func TestEnrolledAttachIntegrationWSStreamsLiveRoute(t *testing.T) {
	for _, persisted := range []bool{true, false} {
		name := "running-original"
		if !persisted {
			name = "before-first-persist"
		}
		t.Run(name, func(t *testing.T) {
			testEnrolledAttachIntegration(t, persisted)
		})
	}
}

func TestEnrolledDetachAPI(t *testing.T) {
	t.Run("chat_delete_api", func(t *testing.T) {
		f := newEvictedCountsFixtureConfigured(t, true, func(cfg *session.Config) {
			cfg.DialAttach = func(ctx context.Context) (*omorpc.Client, error) {
				return omorpc.DialWithConfig(ctx, cfg.Client.SocketPath(), omorpc.Config{NoReconnect: true, EventBuffer: 1024})
			}
		})
		owner, err := omorpc.Dial(t.Context(), f.daemon.SocketPath())
		if err != nil {
			t.Fatal(err)
		}
		defer owner.Close()
		resp, err := owner.Call(t.Context(), omorpc.OpenSession{CWD: f.chat.CWD})
		if err != nil {
			t.Fatal(err)
		}
		var opened omorpc.OpenSessionData
		if err := json.Unmarshal(resp.Data, &opened); err != nil {
			t.Fatal(err)
		}
		f.daemon.MarkRetained(opened.State.SessionFile)
		f.chat.SessionFile, f.chat.DurableSessionID = opened.State.SessionFile, opened.State.SessionID
		f.chat.AutoEnrolled, f.chat.SessionProvenance = true, cursorstore.SessionProvenanceInPlace
		if err := f.store.UpdateChat(f.chat); err != nil {
			t.Fatal(err)
		}
		conn, frames := f.connect()
		writeEvictedCountsFrame(t, conn, map[string]any{"type": "chat.create", "wsId": f.workspaceID(), "chatId": f.chat.ID})
		frames.next(t, "ready")
		if f.daemon.Attachments(opened.State.SessionFile) != 2 {
			t.Fatal("delete fixture did not acquire dedicated attachment")
		}
		url := f.serverURL + "/api/workspaces/" + f.workspaceID() + "/chats/" + f.chat.ID
		req, err := http.NewRequestWithContext(t.Context(), http.MethodDelete, url, nil)
		if err != nil {
			t.Fatal(err)
		}
		req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: f.token})
		deleted, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer deleted.Body.Close()
		body, err := io.ReadAll(deleted.Body)
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("DELETE %s -> %s headers=%v body=%q", url, deleted.Status, deleted.Header, body)
		if deleted.StatusCode != http.StatusNoContent || len(body) != 0 {
			t.Fatalf("delete status=%d body=%s, want 204 empty", deleted.StatusCode, body)
		}
		if f.daemon.RequestCount(omorpc.CmdCloseSession) != 0 {
			t.Fatal("chat delete sent close_session for external retained session")
		}
		if !f.daemon.AwaitAttachments(opened.State.SessionFile, 1, 5*time.Second) {
			t.Fatal("chat delete leaked external attachment")
		}
		if _, err := owner.Call(t.Context(), omorpc.GetState{SessionID: opened.SessionID}); err != nil {
			t.Fatalf("chat delete ended external retained session: %v", err)
		}
		if _, err := f.store.GetChat(f.chat.ID); err == nil {
			t.Fatal("chat metadata was not deleted")
		}
		t.Log("HTTP 204; metadata removed; close_session=0; attachments 2->1; external retained session live")
	})
}

func testEnrolledAttachIntegration(t *testing.T, persisted bool) {
	// Given: a daemon session opened by a different client, still streaming,
	// with an auto-enrolled cursor bound in place to its original file.
	f := newEvictedCountsFixtureConfigured(t, true, func(cfg *session.Config) {
		cfg.DialAttach = func(ctx context.Context) (*omorpc.Client, error) {
			return omorpc.DialWithConfig(ctx, cfg.Client.SocketPath(), omorpc.Config{NoReconnect: true, EventBuffer: 1024})
		}
	})
	owner, err := omorpc.Dial(t.Context(), f.daemon.SocketPath())
	if err != nil {
		t.Fatal(err)
	}
	defer owner.Close()
	response, err := owner.Call(t.Context(), omorpc.OpenSession{CWD: f.chat.CWD})
	if err != nil {
		t.Fatal(err)
	}
	if err := response.Err(); err != nil {
		t.Fatal(err)
	}
	var opened omorpc.OpenSessionData
	if err := json.Unmarshal(response.Data, &opened); err != nil {
		t.Fatal(err)
	}
	f.daemon.MarkRetained(opened.State.SessionFile)
	release := f.daemon.HoldPrompt(opened.State.SessionFile)
	defer release()
	if persisted {
		prompt, err := owner.Call(t.Context(), omorpc.Prompt{SessionID: opened.SessionID, Message: "ongoing daemon work"})
		if err != nil {
			t.Fatal(err)
		}
		if err := prompt.Err(); err != nil {
			t.Fatal(err)
		}
	} else {
		// The fixture writes headers eagerly. Model lazy first persistence
		// without changing the live daemon route or its durable identity.
		if err := os.Remove(opened.State.SessionFile); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := os.Stat(opened.State.SessionFile); !persisted && !os.IsNotExist(err) {
		t.Fatalf("fixture must exercise first-persist absence, stat = %v", err)
	}
	f.chat.SessionFile, f.chat.DurableSessionID = opened.State.SessionFile, opened.State.SessionID
	f.chat.SessionProvenance, f.chat.AutoEnrolled = cursorstore.SessionProvenanceInPlace, true
	if err := f.store.UpdateChat(f.chat); err != nil {
		t.Fatal(err)
	}
	before := f.daemon.RequestCount(omorpc.CmdOpenSession)
	conn, frames := f.connect()
	// When: opening through the real browser WebSocket chat.create path.
	writeEvictedCountsFrame(t, conn, map[string]any{"type": "chat.create", "wsId": f.workspaceID(), "chatId": f.chat.ID})
	ready := frames.next(t, "ready")
	writeEvictedCountsFrame(t, conn, map[string]any{"type": "ping"})
	frames.next(t, "pong")
	attached, ok := f.manager.Get(f.chat.ID)
	if !ok || attached.RoutingID() != opened.SessionID || attached.ID() != opened.State.SessionID || ready["resumed"] != true {
		t.Fatalf("attached = %v, ready = %#v, original = %+v", attached, ready, opened)
	}
	t.Logf("after ready: opens=%d attachments=%d resumable=%v ordinals=%v", f.daemon.RequestCount(omorpc.CmdOpenSession)-before, f.daemon.Attachments(opened.State.SessionFile), attached.Resumable(), f.daemon.ConnectionOrdinals())
	// Then: a session-scoped event emitted AFTER attach reaches this same WS.
	f.daemon.EmitSession(opened.State.SessionFile, map[string]any{
		"type":                  "message_update",
		"assistantMessageEvent": map[string]any{"type": "text_delta", "delta": "owner-live-after-attach"},
	})
	delta := frames.next(t, "messageDelta")
	payload, _ := delta["delta"].(map[string]any)
	if payload["delta"] != "owner-live-after-attach" || payload["kind"] != "text_delta" {
		t.Fatalf("live WS delta = %#v", delta)
	}
	if delta := f.daemon.RequestCount(omorpc.CmdOpenSession) - before; delta != 1 {
		t.Fatalf("enrolled attach open_session delta = %d, want 1 dedicated attach", delta)
	}
	if _, err := f.store.GetChat(f.chat.ID); err != nil {
		t.Fatal(err)
	}
	if got := f.daemon.Attachments(opened.State.SessionFile); got != 2 {
		t.Fatalf("external + dedicated attachments = %d, want 2", got)
	}
	for _, ordinal := range f.daemon.ConnectionOrdinals() {
		if ordinal == 1 && len(f.daemon.AttachedSessions(ordinal)) != 0 {
			t.Fatal("main connection acquired the external session")
		}
	}
	t.Logf("open_session delta=1; route=%s durable=%s; persisted=%v; owner event received without WS reconnect", attached.RoutingID(), attached.ID(), persisted)
}
