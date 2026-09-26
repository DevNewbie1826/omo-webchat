package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/auth"
	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
)

// Prove through the real authenticated HTTP/WS server that live-overview rows
// for engine activity on a durable session are keyed by the owning stored
// chat's id and name. Unbound task/DAG snapshots resolve the durable id
// through the persisted cursor record without acquiring the chat, re-key a
// previously published fallback row when a stored chat claims the durable id
// later, and leave durables owned by no chat listed under their own id. Every
// assertion touches only /api/sessions/live and the /api/v2/ws subscribe path
// the frontend uses — no new Go API is called directly.

const liveResolveSnapshotName = "omo.task.updated"

type liveResolveFixture struct {
	*countsE2EFixture
}

func newLiveResolveFixture(t *testing.T) *liveResolveFixture {
	t.Helper()
	return &liveResolveFixture{countsE2EFixture: newCountsE2EFixture(t)}
}

// subscribeExplicit dials the v2 socket and subscribes exactly like the
// frontend overview surface: explicit sessionIds, ack before any event.
func (f *liveResolveFixture) subscribeExplicit(ids ...string) *activityE2ECollector {
	f.t.Helper()
	conn, frames := f.connectUnsubscribed()
	f.t.Cleanup(func() { _ = conn.WriteClose(1000, nil) })
	writeActivityE2EFrame(f.t, conn, map[string]any{"type": "sessions.subscribe", "mode": "explicit", "sessionIds": ids})
	if ack := frames.next(f.t, "ack"); ack["command"] != "sessions.subscribe" {
		f.t.Fatalf("subscription ack = %v", ack)
	}
	return frames
}

// emitUnboundTask injects an unsolicited engine snapshot whose data carries
// parent_session_id = durableID, the shape unbound activity arrives in.
func (f *liveResolveFixture) emitUnboundTask(durableID string, revision int) {
	f.t.Helper()
	f.daemon.Emit(map[string]any{
		"type": "extension_event", "sessionId": durableID, "name": liveResolveSnapshotName,
		"data": map[string]any{
			"parent_session_id": durableID, "truncated_tasks": false,
			"tasks": []any{map[string]any{
				"task_id": "st-live-resolve", "status": "running",
				"created_at": "2026-09-26T00:00:00Z",
				"updated_at": fmt.Sprintf("2026-09-26T00:00:%02dZ", revision),
			}},
		},
	})
}

// saveChatClaiming persists a stored chat bound to durableID without ever
// acquiring it: no route, no manager identity, only the cursor record.
func (f *liveResolveFixture) saveChatClaiming(chatID, name, durableID string) {
	f.t.Helper()
	if err := f.store.SaveChat(cursorstore.Chat{
		ID: chatID, WorkspaceID: f.storeWorkspaceID(), CWD: f.t.TempDir(),
		Name: name, NameSource: cursorstore.NameSourceUser, DurableSessionID: durableID,
	}); err != nil {
		f.t.Fatal(err)
	}
}

func liveResolveRows(t *testing.T, serverURL, token string) []map[string]any {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, serverURL+"/api/sessions/live", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: token})
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body struct {
		Sessions []map[string]any `json:"sessions"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("live REST status = %d", resp.StatusCode)
	}
	return body.Sessions
}

// assertSoleLiveRow pins the overview to exactly one row and returns it, so a
// stale durable-keyed row or a duplicated chat row fails loudly.
func assertSoleLiveRow(t *testing.T, serverURL, token string) map[string]any {
	t.Helper()
	rows := liveResolveRows(t, serverURL, token)
	if len(rows) != 1 {
		t.Fatalf("live REST rows = %v, want exactly one", rows)
	}
	return rows[0]
}

// A durable owned by a stored, never-acquired chat keys its live-overview
// rows by the chat's id and name on both real wire surfaces.
func TestLiveRowResolutionStoredChatKeysOverviewRowsByChatIdentity(t *testing.T) {
	fixture := newLiveResolveFixture(t)
	const chatID, durableID = "chat-live-resolve-stored", "durable-live-resolve-stored"
	const chatName = "Stored chat title"
	fixture.saveChatClaiming(chatID, chatName, durableID)

	frames := fixture.subscribeExplicit(chatID)
	fixture.emitUnboundTask(durableID, 1)

	frame := frames.next(t, "sessions.activity")
	if frame["sessionId"] != chatID || frame["title"] != chatName || frame["durableSessionId"] != durableID {
		t.Fatalf("subscriber frame = %v", frame)
	}
	if _, replaced := frame["replacesSessionId"]; replaced {
		t.Fatalf("first resolution must not replace a prior row: %v", frame)
	}
	row := assertSoleLiveRow(t, fixture.serverURL, fixture.token)
	if row["id"] != chatID || row["title"] != chatName {
		t.Fatalf("live REST row = %v, want id %q titled %q", row, chatID, chatName)
	}
}

// An unclaimed durable first lists under its own id; once a stored chat
// claims it, the next snapshot re-keys the row and the same subscription
// follows the remap with replacesSessionId pointing at the old row id.
func TestLiveRowResolutionRekeysFallbackRowWhenChatClaimsDurable(t *testing.T) {
	fixture := newLiveResolveFixture(t)
	const chatID, durableID = "chat-live-resolve-rekey", "durable-live-resolve-rekey"
	const chatName = "Rekeyed chat title"

	frames := fixture.subscribeExplicit(durableID)
	fixture.emitUnboundTask(durableID, 1)
	fallback := frames.next(t, "sessions.activity")
	if fallback["sessionId"] != durableID {
		t.Fatalf("fallback frame = %v", fallback)
	}
	if row := assertSoleLiveRow(t, fixture.serverURL, fixture.token); row["id"] != durableID {
		t.Fatalf("unclaimed durable REST row = %v", row)
	}

	fixture.saveChatClaiming(chatID, chatName, durableID)
	fixture.emitUnboundTask(durableID, 2)
	rekeyed := frames.next(t, "sessions.activity")
	if rekeyed["sessionId"] != chatID || rekeyed["title"] != chatName {
		t.Fatalf("re-keyed frame = %v", rekeyed)
	}
	if rekeyed["replacesSessionId"] != durableID {
		t.Fatalf("re-keyed frame must replace the durable-keyed row: %v", rekeyed)
	}
	if row := assertSoleLiveRow(t, fixture.serverURL, fixture.token); row["id"] != chatID {
		t.Fatalf("re-keyed REST rows = %v, want only %q", row, chatID)
	}
}

// A durable owned by no chat keeps its fallback identity across repeated
// snapshots — never re-keyed, duplicated, or dropped.
func TestLiveRowResolutionKeepsUnownedDurableUnderOwnID(t *testing.T) {
	fixture := newLiveResolveFixture(t)
	const durableID = "durable-live-resolve-orphan"

	frames := fixture.subscribeExplicit(durableID)
	fixture.emitUnboundTask(durableID, 1)
	first := frames.next(t, "sessions.activity")
	if first["sessionId"] != durableID {
		t.Fatalf("orphan frame = %v", first)
	}
	if row := assertSoleLiveRow(t, fixture.serverURL, fixture.token); row["id"] != durableID {
		t.Fatalf("orphan REST row = %v", row)
	}

	fixture.emitUnboundTask(durableID, 2)
	second := frames.next(t, "sessions.activity")
	if second["sessionId"] != durableID {
		t.Fatalf("repeat orphan frame = %v", second)
	}
	if _, replaced := second["replacesSessionId"]; replaced {
		t.Fatalf("orphan row must not replace anything: %v", second)
	}
	if row := assertSoleLiveRow(t, fixture.serverURL, fixture.token); row["id"] != durableID {
		t.Fatalf("repeat orphan REST row = %v", row)
	}
}

// renameChatE2E renames a stored chat through the authenticated REST surface
// the frontend uses, so the manager hook fires exactly as in production.
func renameChatE2E(t *testing.T, f *liveResolveFixture, chatID, name string) {
	t.Helper()
	body, err := json.Marshal(map[string]string{"name": name})
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodPatch,
		f.serverURL+"/api/workspaces/"+f.storeWorkspaceID()+"/chats/"+chatID,
		bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: f.token})
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("rename status = %d", resp.StatusCode)
	}
}

// Renaming a stored chat refreshes the cached live row's title on both wire
// surfaces: the existing subscription is republished, a brand-new
// subscription's initial snapshot carries the new name, and the next engine
// snapshot advances the freshness revision even when its payload is
// unchanged, because the title is part of the revision projection.
func TestLiveRowResolutionRenameRefreshesCachedRowTitle(t *testing.T) {
	fixture := newLiveResolveFixture(t)
	const chatID, durableID = "chat-live-resolve-rename", "durable-live-resolve-rename"
	const originalName, renamedName = "Original rename title", "Renamed live title"
	fixture.saveChatClaiming(chatID, originalName, durableID)

	frames := fixture.subscribeExplicit(chatID)
	fixture.emitUnboundTask(durableID, 1)
	first := frames.next(t, "sessions.activity")
	if first["sessionId"] != chatID || first["title"] != originalName {
		t.Fatalf("subscriber frame = %v", first)
	}
	firstRevision, _ := first["last_activity_ms"].(float64)

	renameChatE2E(t, fixture, chatID, renamedName)

	refreshed := frames.next(t, "sessions.activity")
	if refreshed["sessionId"] != chatID || refreshed["title"] != renamedName {
		t.Fatalf("existing subscriber missed rename: %v", refreshed)
	}
	if row := assertSoleLiveRow(t, fixture.serverURL, fixture.token); row["title"] != renamedName {
		t.Fatalf("REST row after rename = %v", row)
	}

	resubscribed := fixture.subscribeExplicit(chatID)
	initial := resubscribed.next(t, "sessions.activity")
	if initial["sessionId"] != chatID || initial["title"] != renamedName {
		t.Fatalf("new subscription initial frame = %v", initial)
	}

	// The repeated revision isolates the title from payload-driven advances.
	fixture.emitUnboundTask(durableID, 1)
	late := frames.next(t, "sessions.activity")
	if late["title"] != renamedName {
		t.Fatalf("post-rename activity frame = %v", late)
	}
	lateRevision, _ := late["last_activity_ms"].(float64)
	if lateRevision <= firstRevision {
		t.Fatalf("revision did not advance across rename: %v -> %v", firstRevision, lateRevision)
	}
}
