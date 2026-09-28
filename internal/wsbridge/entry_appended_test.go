package wsbridge

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/session"
)

func TestHistoryCapabilitiesFollowHelloVersion(t *testing.T) {
	conn := &connection{}
	sub := &subscriber{conn: conn}
	for _, tc := range []struct {
		version               int
		progressive, onDemand bool
	}{
		{version: 2, progressive: false, onDemand: false},
		{version: progressiveHistoryVersion, progressive: true, onDemand: false},
		{version: onDemandHistoryVersion, progressive: true, onDemand: true},
	} {
		conn.helloVersion = tc.version
		if got := sub.ProgressiveHistory(); got != tc.progressive {
			t.Fatalf("version %d ProgressiveHistory = %v, want %v", tc.version, got, tc.progressive)
		}
		if got := sub.OnDemandHistory(); got != tc.onDemand {
			t.Fatalf("version %d OnDemandHistory = %v, want %v", tc.version, got, tc.onDemand)
		}
	}
}

func TestMapFrameEntryAppendedRequiresVersionFour(t *testing.T) {
	parent := "parent-1"
	info := session.EntryAppendedInfo{ID: "message-1", ParentID: &parent, Role: "assistant", TextPrefix: "hello"}
	frame := session.Frame{Kind: session.FrameEntryAppended, SessionID: "durable", BindingID: "bind-1", Data: info}

	for _, version := range []int{0, MinContractVersion, progressiveHistoryVersion} {
		wire, err := mapFrame(frame, "chat-1", false, version)
		if err != nil || wire != nil {
			t.Fatalf("version %d mapped entry.appended: wire=%#v err=%v", version, wire, err)
		}
	}

	wire, err := mapFrame(frame, "chat-1", false, onDemandHistoryVersion)
	if err != nil {
		t.Fatal(err)
	}
	decoded := decodeMappedFrame(t, wire)
	if decoded["type"] != "entry.appended" || decoded["sessionId"] != "chat-1" || decoded["id"] != "message-1" || decoded["parentId"] != "parent-1" || decoded["role"] != "assistant" || decoded["textPrefix"] != "hello" || decoded["bindingId"] != "bind-1" {
		t.Fatalf("v4 entry.appended = %#v", decoded)
	}

	root := session.EntryAppendedInfo{ID: "message-2", Role: "user", TextPrefix: "plain"}
	wire, err = mapFrame(session.Frame{Kind: session.FrameEntryAppended, Data: &root}, "", false, onDemandHistoryVersion)
	if err != nil {
		t.Fatal(err)
	}
	decoded = decodeMappedFrame(t, wire)
	if _, ok := decoded["bindingId"]; ok {
		t.Fatalf("unset bindingId was emitted: %#v", decoded)
	}
	if _, ok := decoded["parentId"]; !ok || decoded["parentId"] != nil {
		t.Fatalf("root parentId = %#v, want null", decoded["parentId"])
	}
	if decoded["id"] != "message-2" || decoded["sessionId"] != "" || decoded["textPrefix"] != "plain" || decoded["role"] != "user" {
		t.Fatalf("root entry.appended = %#v", decoded)
	}

	omitted, err := mapFrame(frame, "chat-1", false)
	if err != nil {
		t.Fatal(err)
	}
	if decodeMappedFrame(t, omitted)["type"] != "entry.appended" {
		t.Fatal("omitted hello version did not map as the current contract")
	}
}

func TestEntryAppendedReachesOnlyVersionFour(t *testing.T) {
	h := newHistoryBridgeHarness(t, historyE2ETestBudget)
	path, _ := writeBridgeHistory(t, 1)
	if err := h.daemon.LoadSessionFile(path); err != nil {
		t.Fatal(err)
	}
	h.saveChat(t, "entry-appended", path)

	v4Conn, v4Frames := connectHistoryVersion(t, h, onDemandHistoryVersion, 0)
	v3Conn, v3Frames := connectHistoryVersion(t, h, progressiveHistoryVersion, 0)
	writeClient(t, v4Conn, map[string]any{"type": "chat.create", "wsId": h.workspace.ID, "chatId": "entry-appended"})
	writeClient(t, v3Conn, map[string]any{"type": "chat.create", "wsId": h.workspace.ID, "chatId": "entry-appended"})
	v4Frames.next(t, "ready")
	v3Frames.next(t, "ready")

	prefix := []rune(strings.Repeat("가", 130))
	h.daemon.EmitSession(path, map[string]any{
		"type": "entry_appended",
		"entry": map[string]any{
			"type": "custom", "id": "custom-1", "customType": "ignored",
		},
	})
	h.daemon.EmitSession(path, map[string]any{
		"type": "entry_appended",
		"entry": map[string]any{
			"type": "message", "id": "live-1", "parentId": "entry-0000",
			"message": map[string]any{"role": "assistant", "content": []any{
				map[string]any{"type": "text", "text": string(prefix[:65])},
				map[string]any{"type": "toolCall", "text": "ignored"},
				map[string]any{"type": "text", "text": string(prefix[65:])},
			}},
		},
	})
	h.daemon.EmitSession(path, map[string]any{
		"type":    "message_end",
		"message": map[string]any{"role": "assistant", "content": "barrier-token"},
	})

	matchBarrier := func(frame map[string]any) bool {
		message, _ := frame["message"].(map[string]any)
		content, _ := message["content"].(string)
		return content == "barrier-token"
	}
	v4Frames.nextMatching(t, "message", historyE2ETestBudget, matchBarrier)
	v3Frames.nextMatching(t, "message", historyE2ETestBudget, matchBarrier)

	wantPrefix := string(prefix[:128])
	appended := entryAppendedFrames(t, v4Frames)
	if len(appended) != 1 {
		t.Fatalf("v4 entry.appended frames = %d, want 1", len(appended))
	}
	got := appended[0]
	if got["type"] != "entry.appended" || got["sessionId"] != "entry-appended" || got["id"] != "live-1" || got["parentId"] != "entry-0000" || got["role"] != "assistant" || got["textPrefix"] != wantPrefix {
		t.Fatalf("v4 entry.appended = %#v, want prefix %q", got, wantPrefix)
	}
	if _, ok := got["bindingId"]; ok {
		t.Fatalf("entry.appended bindingId = %v, want omitted when unset", got["bindingId"])
	}
	if got := entryAppendedFrames(t, v3Frames); len(got) != 0 {
		t.Fatalf("v3 received entry.appended: %#v", got)
	}
}

func decodeMappedFrame(t *testing.T, wire any) map[string]any {
	t.Helper()
	raw, err := json.Marshal(wire)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	return decoded
}

func entryAppendedFrames(t *testing.T, frames *collector) []map[string]any {
	t.Helper()
	batch, _, _ := frames.takeDecoded(0)
	var out []map[string]any
	for _, frame := range batch {
		if frame.typ != "entry.appended" {
			continue
		}
		var decoded map[string]any
		if err := json.Unmarshal(frame.raw, &decoded); err != nil {
			t.Fatal(err)
		}
		out = append(out, decoded)
	}
	return out
}
