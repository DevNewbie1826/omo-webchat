package session_test

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func TestEnrolledAttachIntegrationWSUsesLiveRouteWithoutOpenSession(t *testing.T) {
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

func testEnrolledAttachIntegration(t *testing.T, persisted bool) {
	// Given: a daemon session opened by a different client, still streaming,
	// with an auto-enrolled cursor bound in place to its original file.
	f := newEvictedCountsFixture(t)
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
	// Then: no provider open was issued and both route and durable id are intact.
	if delta := f.daemon.RequestCount(omorpc.CmdOpenSession) - before; delta != 0 {
		t.Fatalf("enrolled attach open_session delta = %d, want 0", delta)
	}
	attached, ok := f.manager.Get(f.chat.ID)
	if !ok || attached.RoutingID() != opened.SessionID || attached.ID() != opened.State.SessionID || ready["resumed"] != true {
		t.Fatalf("attached = %v, ready = %#v, original = %+v", attached, ready, opened)
	}
	if _, err := f.store.GetChat(f.chat.ID); err != nil {
		t.Fatal(err)
	}
	t.Logf("open_session delta=0; route=%s durable=%s; persisted=%v original attached via WS", attached.RoutingID(), attached.ID(), persisted)
}
