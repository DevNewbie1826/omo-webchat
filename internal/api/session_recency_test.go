package api

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/auth"
	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
)

func TestUnifiedSessionRecency(t *testing.T) {
	for _, represented := range []bool{false, true} {
		name := "discovered"
		if represented {
			name = "represented"
		}
		t.Run(name, func(t *testing.T) {
			// Given: disk activity is newer than web use, despite old creation.
			s, st, ws := newChatCreateTestServer(t)
			ws.ID = "ws-order"
			if err := st.SaveWorkspace(ws); err != nil {
				t.Fatal(err)
			}
			agent := t.TempDir()
			t.Setenv("OMO_CODING_AGENT_DIR", agent)
			activity := time.Date(2026, 1, 10, 12, 0, 0, 0, time.UTC)
			created := activity.AddDate(-1, 0, 0)
			stubSessionClock(t, activity.AddDate(0, 1, 0))
			path := writeDiskSession(t, agent, ws.Path, "disk-a", "Disk A", created)
			if err := os.Chtimes(path, activity, activity); err != nil {
				t.Fatal(err)
			}
			writeDiskSession(t, agent, ws.Path, "disk-c", "Disk C", created)
			fixtures := []cursorstore.Chat{
				{ID: "web-b", LastUsedAt: activity.Add(-24 * time.Hour).UnixMilli(), CreatedAt: created.UnixMilli()},
				{ID: "equal-A", CreatedAt: created.Unix()},
				{ID: "equal-a", CreatedAt: created.UnixMilli()},
				{ID: "absent", SessionFile: filepath.Join(t.TempDir(), "missing.jsonl"), CreatedAt: created.AddDate(-1, 0, 0).UnixMilli()},
				{ID: "unknown"},
			}
			firstID := "disk-a"
			if represented {
				firstID = "web-a"
				fixtures = append(fixtures, cursorstore.Chat{ID: firstID, DurableSessionID: "disk-a", SessionFile: filepath.Join(t.TempDir(), "missing-owned.jsonl"), CreatedAt: created.UnixMilli()})
			}
			for _, c := range fixtures {
				c.WorkspaceID, c.CWD, c.Name = ws.ID, ws.Path, c.ID
				if err := st.SaveChat(c); err != nil {
					t.Fatal(err)
				}
			}
			server := httptest.NewServer(s.Handler())
			defer server.Close()
			token, err := s.sessions.Create(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			// When: traverse real authenticated HTTP pages, merged before pagination.
			var got []sessionHistoryItem
			cursor := ""
			for {
				req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, server.URL+"/api/workspaces/ws-order/sessions?limit=5&cursor="+cursor, nil)
				if err != nil {
					t.Fatal(err)
				}
				req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: token})
				resp, err := server.Client().Do(req)
				if err != nil {
					t.Fatal(err)
				}
				body, err := io.ReadAll(resp.Body)
				resp.Body.Close()
				if err != nil {
					t.Fatal(err)
				}
				t.Logf("GET %s: status=%d headers=%v body=%s", req.URL, resp.StatusCode, resp.Header, body)
				if resp.StatusCode != http.StatusOK {
					t.Fatalf("status=%d", resp.StatusCode)
				}
				var page sessionHistoryPage
				if err := json.Unmarshal(body, &page); err != nil {
					t.Fatal(err)
				}
				got = append(got, page.Items...)
				if page.NextCursor == "" {
					break
				}
				if page.NextCursor == cursor || len(got) > 20 {
					t.Fatal("paging did not advance")
				}
				cursor = page.NextCursor
			}
			// Then: source-neutral exact recency, ordinal ties, complete unique pages.
			ids := make([]string, len(got))
			for i, item := range got {
				ids[i] = item.ID
			}
			want := []string{firstID, "web-b", "disk-c", "equal-A", "equal-a", "absent", "unknown"}
			if !reflect.DeepEqual(ids, want) {
				t.Errorf("order=%v, want %v", ids, want)
			}
			if len(got) == 0 || got[0].RecencyMs != activity.UnixMilli() {
				t.Errorf("activity recency lost: %+v", got)
			}
		})
	}
	t.Run("invalid_and_missing_header_time", func(t *testing.T) {
		// Given: valid session identity with no valid creation timestamp.
		for _, stamp := range []string{"", "invalid"} {
			path := filepath.Join(t.TempDir(), "session.jsonl")
			header, err := json.Marshal(map[string]string{"type": "session", "id": "disk", "cwd": t.TempDir(), "timestamp": stamp})
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, header, 0o600); err != nil {
				t.Fatal(err)
			}
			activity := time.Date(2026, 1, 10, 12, 0, 0, 0, time.UTC)
			if err := os.Chtimes(path, activity, activity); err != nil {
				t.Fatal(err)
			}
			// When
			got, ok := parseSessionFile(path)
			// Then
			if !ok || got.RecencyMs != activity.UnixMilli() {
				t.Errorf("timestamp=%q: %+v, parsed=%v", stamp, got, ok)
			}
		}
	})
}
