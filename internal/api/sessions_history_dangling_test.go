package api

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/store"
)

// TestListWorkspaceSessionsFlagsDanglingStoredPath pins the list-path dangling
// flag: a stored chat whose piSessionId is an absolute path whose file is gone
// is surfaced as dangling=true, while stored rows whose identity resolves (an
// existing session file), is not a path ("pi-1"), or is empty are NOT flagged,
// and discovered rows omit the field entirely. The response is decoded as raw
// JSON so a missing field is an assertion failure, not a compile error.
func TestListWorkspaceSessionsFlagsDanglingStoredPath(t *testing.T) {
	srv, st, ws, agent := newSessionHistoryTestServer(t)

	dangling := filepath.Join(t.TempDir(), "gone", "dangling-session.jsonl")
	if _, err := os.Stat(dangling); !os.IsNotExist(err) {
		t.Fatalf("setup: dangling path %q unexpectedly exists: %v", dangling, err)
	}
	mtime := time.Now().Add(-time.Minute).UTC().Truncate(time.Second)
	existing := writeDiskSession(t, agent, ws.Path, "existing-session", "Existing session", mtime)
	writeDiskSession(t, agent, ws.Path, "discovered-only", "Discovered only", mtime.Add(-time.Second))

	storeChat := func(name, identity string) string {
		chat, err := st.NewChat(ws.ID, name, ws.Path, "", "omo")
		if err != nil {
			t.Fatalf("create chat %q: %v", name, err)
		}
		if identity != "" {
			if _, err := st.UpdateChat(ws.ID, chat.ID, func(record *store.Chat) {
				record.PiSessionID = identity
			}); err != nil {
				t.Fatalf("persist identity for %q: %v", name, err)
			}
		}
		return chat.ID
	}
	idDangling := storeChat("chat-dangling", dangling)
	idExisting := storeChat("chat-existing", existing)
	idNonPath := storeChat("chat-nonpath", "pi-1")
	idEmpty := storeChat("chat-empty", "")

	rec := listWorkspaceSessions(t, srv, ws.ID, "limit=5")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response body %s: %v", rec.Body.String(), err)
	}
	rawItems, ok := body["items"].([]any)
	if !ok {
		t.Fatalf("items = %#v, want an array", body["items"])
	}
	byID := make(map[string]map[string]any, len(rawItems))
	for _, rawItem := range rawItems {
		item, ok := rawItem.(map[string]any)
		if !ok {
			t.Fatalf("item = %#v, want a JSON object", rawItem)
		}
		id, _ := item["id"].(string)
		byID[id] = item
	}

	// (a) absolute stored path whose file is gone => dangling==true.
	item, found := byID[idDangling]
	if !found {
		t.Fatalf("dangling chat %q missing from items: %v", idDangling, byID)
	}
	raw, present := item["dangling"]
	flag, isBool := raw.(bool)
	if !present || !isBool || !flag {
		t.Fatalf("stored chat with missing session path: dangling = %#v (present=%t), want true; item: %v", raw, present, item)
	}

	// (b) absolute stored path whose file exists => not flagged.
	item, found = byID[idExisting]
	if !found {
		t.Fatalf("existing-path chat %q missing from items: %v", idExisting, byID)
	}
	if raw, present = item["dangling"]; present {
		if flag, isBool = raw.(bool); !isBool || flag {
			t.Fatalf("stored chat with existing session path: dangling = %#v, want absent or false; item: %v", raw, item)
		}
	}

	// (c) non-path identity => not flagged.
	item, found = byID[idNonPath]
	if !found {
		t.Fatalf("non-path chat %q missing from items: %v", idNonPath, byID)
	}
	if raw, present = item["dangling"]; present {
		if flag, isBool = raw.(bool); !isBool || flag {
			t.Fatalf("stored chat with non-path identity: dangling = %#v, want absent or false; item: %v", raw, item)
		}
	}

	// (d) empty identity => not flagged.
	item, found = byID[idEmpty]
	if !found {
		t.Fatalf("empty-identity chat %q missing from items: %v", idEmpty, byID)
	}
	if raw, present = item["dangling"]; present {
		if flag, isBool = raw.(bool); !isBool || flag {
			t.Fatalf("stored chat with empty identity: dangling = %#v, want absent or false; item: %v", raw, item)
		}
	}

	// Discovered rows must omit the flag entirely (Stat applies to stored rows only).
	item, found = byID["discovered-only"]
	if !found {
		t.Fatalf("discovered session missing from items: %v", byID)
	}
	if raw, present = item["dangling"]; present {
		t.Fatalf("discovered row carries a dangling key (%#v), want the field omitted; item: %v", raw, item)
	}
}
