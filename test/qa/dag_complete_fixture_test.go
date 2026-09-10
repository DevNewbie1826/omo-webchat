//go:build ignore

package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFixtureSeedPreservesScaleIdentityAndOwnership(t *testing.T) {
	root := t.TempDir()
	manifest, _, err := seedFixture(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(manifest.Runs) != 539 || len(manifest.NewestFirst) != 539 {
		t.Fatalf("catalog size=%d newest=%d", len(manifest.Runs), len(manifest.NewestFirst))
	}
	if manifest.NewestFirst[0] != "dense-64" || manifest.NewestFirst[1] != "long-identities" {
		t.Fatalf("newest-first prefix=%v", manifest.NewestFirst[:2])
	}
	stamps := map[string]string{}
	for _, id := range manifest.Runs {
		raw, err := os.ReadFile(filepath.Join(root, manifest.Files[id]))
		if err != nil {
			t.Fatal(err)
		}
		var row checkpoint
		if err := json.Unmarshal(raw, &row); err != nil {
			t.Fatal(err)
		}
		if row.Updated == "" || stamps[row.Updated] != "" {
			t.Fatalf("updated_at collision %s %s %s", row.Updated, stamps[row.Updated], id)
		}
		stamps[row.Updated] = id
	}
	if len(stamps) != 539 {
		t.Fatalf("distinct updated_at=%d", len(stamps))
	}
	for i := 1; i < len(manifest.NewestFirst); i++ {
		newer, err := os.ReadFile(filepath.Join(root, manifest.Files[manifest.NewestFirst[i-1]]))
		if err != nil {
			t.Fatal(err)
		}
		older, err := os.ReadFile(filepath.Join(root, manifest.Files[manifest.NewestFirst[i]]))
		if err != nil {
			t.Fatal(err)
		}
		var a, b checkpoint
		if err := json.Unmarshal(newer, &a); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(older, &b); err != nil {
			t.Fatal(err)
		}
		if a.Updated <= b.Updated {
			t.Fatalf("newest-first order %s %s then %s %s", a.RunID, a.Updated, b.RunID, b.Updated)
		}
	}
	for _, suffix := range []string{"0", "1"} {
		id := strings.Repeat("a", 600) + suffix
		path, ok := manifest.Files[id]
		if !ok {
			t.Fatalf("missing exact 601-byte run ID ending %s", suffix)
		}
		bytes, err := os.ReadFile(filepath.Join(root, path))
		if err != nil {
			t.Fatal(err)
		}
		var long checkpoint
		if err := json.Unmarshal(bytes, &long); err != nil {
			t.Fatal(err)
		}
		if long.RunID != id || len(long.Definition.Nodes) != 2 || len(long.Definition.Nodes[0].ID) <= 512 || long.Definition.Nodes[1].DependsOn[0] != long.Definition.Nodes[0].ID {
			t.Fatal("long original run/node/dependency identities were lost")
		}
	}
	raw, err := os.ReadFile(filepath.Join(root, manifest.Files["dense-64"]))
	if err != nil {
		t.Fatal(err)
	}
	var record checkpoint
	if err := json.Unmarshal(raw, &record); err != nil {
		t.Fatal(err)
	}
	if record.RunID != "dense-64" || record.Parent != "qa-chat" || len(record.Nodes) != 64 {
		t.Fatalf("identity/topology mismatch: %+v", record)
	}
	for i, node := range record.Definition.Nodes {
		if len(node.Prompt) != 2048 || len(node.DependsOn) != i {
			t.Fatalf("node %d bytes=%d deps=%d", i, len(node.Prompt), len(node.DependsOn))
		}
	}
	huge, err := os.Stat(filepath.Join(root, manifest.Files["huge-record"]))
	if err != nil || huge.Size() <= 4<<20 {
		t.Fatalf("large file=%v err=%v", huge, err)
	}
	if filepath.Base(manifest.Files["dense-64"]) == "dense-64.json" {
		t.Fatal("fixture accidentally permits filename lookup")
	}
	link, err := os.Lstat(filepath.Join(root, "workspace", "escape", ".omo", "senpi-task"))
	if err != nil || link.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("symlink fixture=%v err=%v", link, err)
	}
}

func TestFixtureLoginUsesActualHandler(t *testing.T) {
	_, store, err := seedFixture(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	handler := fixtureHandler(t.Context(), store)
	denied := httptest.NewRecorder()
	handler.ServeHTTP(denied, httptest.NewRequest("GET", "/api/workspaces/qa-dag/chats/qa-chat/dag-runs/dense-64", nil))
	if denied.Code != 401 {
		t.Fatalf("unauthenticated=%d", denied.Code)
	}
	login := httptest.NewRecorder()
	handler.ServeHTTP(login, httptest.NewRequest("POST", "/api/login", strings.NewReader(`{"password":"dag-complete-isolated"}`)))
	if login.Code != 200 || len(login.Result().Cookies()) != 1 {
		t.Fatalf("login=%d %s", login.Code, login.Body.String())
	}
	req := httptest.NewRequest("GET", "/api/auth/check", nil)
	req.AddCookie(login.Result().Cookies()[0])
	checked := httptest.NewRecorder()
	handler.ServeHTTP(checked, req)
	if checked.Code != http.StatusOK {
		t.Fatalf("auth check=%d", checked.Code)
	}
}
