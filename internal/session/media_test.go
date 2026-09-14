package session

// Session-layer tests for GetMedia: the read-only command that fetches one
// inline media block by its image_ref placeholder ref (toolCallId plus
// contentIndex) from the chat's engine session.

import (
	"context"
	"errors"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

const testMediaPNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"

func TestSessionGetMedia(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	mgr := testManager(t, client, store, 64)
	chat := testChat{id: "media-chat", cwd: t.TempDir()}
	sess, _, detach := acquire(t, mgr, chat, nil)
	defer detach()

	cur := store.stored(chat.id)
	if cur.SessionFile == "" {
		t.Fatalf("no durable session file for chat: %+v", cur)
	}
	d.SetSessionMedia(cur.SessionFile, "call_mock", 1, map[string]any{
		"type": "image", "data": testMediaPNG, "mimeType": "image/png",
	})

	data, err := sess.GetMedia(context.Background(), "call_mock", 1)
	if err != nil {
		t.Fatalf("GetMedia: %v", err)
	}
	if data.ToolCallID != "call_mock" || data.ContentIndex != 1 {
		t.Fatalf("GetMedia echo = (%q, %d), want (call_mock, 1)", data.ToolCallID, data.ContentIndex)
	}
	if data.Content.Type != "image" || data.Content.MimeType != "image/png" || data.Content.Data != testMediaPNG {
		t.Fatalf("GetMedia content = %+v, want the armed image block", data.Content)
	}

	request := d.LastRequest(omorpc.CmdGetMedia)
	if request == nil {
		t.Fatal("daemon never received get_media")
	}
	if got, _ := request["sessionId"].(string); got != sess.RoutingID() {
		t.Errorf("sessionId = %q, want live routing id %q", got, sess.RoutingID())
	}
	if got, _ := request["toolCallId"].(string); got != "call_mock" {
		t.Errorf("toolCallId = %q, want call_mock", got)
	}
	if got, ok := request["contentIndex"].(float64); !ok || got != 1 {
		t.Errorf("contentIndex = %v, want 1", request["contentIndex"])
	}
}

// TestSessionGetMediaContentIndexZero pins that a zero contentIndex still
// travels: the placeholder ref is positional.
func TestSessionGetMediaContentIndexZero(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	mgr := testManager(t, client, store, 64)
	chat := testChat{id: "media-zero", cwd: t.TempDir()}
	sess, _, detach := acquire(t, mgr, chat, nil)
	defer detach()

	cur := store.stored(chat.id)
	d.SetSessionMedia(cur.SessionFile, "call_0", 0, map[string]any{
		"type": "image", "data": testMediaPNG, "mimeType": "image/png",
	})

	data, err := sess.GetMedia(context.Background(), "call_0", 0)
	if err != nil {
		t.Fatalf("GetMedia: %v", err)
	}
	if data.ContentIndex != 0 || data.Content.Data != testMediaPNG {
		t.Fatalf("GetMedia = %+v, want contentIndex 0 with the armed block", data)
	}
	request := d.LastRequest(omorpc.CmdGetMedia)
	if _, ok := request["contentIndex"].(float64); !ok {
		t.Fatalf("contentIndex missing from zero-index request: %v", request)
	}
}

// TestSessionGetMediaNotFound pins the failure surface: coordinates that do
// not resolve to a media block surface as an error whose stable code is
// media_not_found.
func TestSessionGetMediaNotFound(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 64)
	chat := testChat{id: "media-missing", cwd: t.TempDir()}
	sess, _, detach := acquire(t, mgr, chat, nil)
	defer detach()

	data, err := sess.GetMedia(context.Background(), "unknown-tool", 3)
	if err == nil {
		t.Fatalf("GetMedia(unarmed coordinates) = %+v, want an error", data)
	}
	var stable *omorpc.StableError
	if !errors.As(err, &stable) || stable.Code != omorpc.ErrCodeMediaNotFound {
		t.Fatalf("GetMedia error = %v, want stable code %s", err, omorpc.ErrCodeMediaNotFound)
	}
}
