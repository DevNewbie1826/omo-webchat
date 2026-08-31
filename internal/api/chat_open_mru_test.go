package api

import (
	"testing"
	"time"
)

// TestChatOpenTouchesLastUsedAt pins the single-touch contract of the open
// path: one successful chat.create stamps the stored record's last-used time.
// The stamp lands before the ready frame is sent, so observing ready proves
// the store write already completed - no polling needed.
func TestChatOpenTouchesLastUsedAt(t *testing.T) {
	e := newNameTitleEnv(t)
	record, err := e.st.NewChat(e.ws.ID, "opened", e.ws.Path, "", "omo")
	if err != nil {
		t.Fatalf("create chat: %v", err)
	}
	if record.LastUsedAt != 0 {
		t.Fatalf("fresh chat lastUsedAt = %d, want 0", record.LastUsedAt)
	}

	writeFrame(t, e.client, map[string]any{"type": "chat.create", "wsId": e.ws.ID, "chatId": record.ID})
	e.frames.waitFor(t, "ready", 3*time.Second)

	// The open path stamps the record synchronously before the ready frame
	// is written, so observing ready already proves the persist completed.
	got, err := e.st.GetChat(e.ws.ID, record.ID)
	if err != nil {
		t.Fatalf("get chat: %v", err)
	}
	if got.LastUsedAt == 0 {
		t.Fatalf("successful open did not stamp lastUsedAt (createdAt %d)", got.CreatedAt)
	}
	if got.LastUsedAt < got.CreatedAt {
		t.Fatalf("lastUsedAt = %d, want at least createdAt %d", got.LastUsedAt, got.CreatedAt)
	}
}
