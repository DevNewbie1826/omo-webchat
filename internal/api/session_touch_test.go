package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/auth"
	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
)

type activationClock struct{ at time.Time }

func (c activationClock) Now() time.Time { return c.at }

func TestExplicitSessionUse(t *testing.T) {
	// Given: a server-owned clock and a historical cursor, no engine manager.
	s, _, ws := newChatCreateTestServer(t)
	stamp := time.Date(2026, 1, 11, 12, 0, 0, 0, time.UTC)
	path := filepath.Join(t.TempDir(), "state-v2.json")
	st, err := cursorstore.OpenWithClock(path, activationClock{stamp})
	if err != nil {
		t.Fatal(err)
	}
	s.cursors = st
	if err := st.SaveWorkspace(ws); err != nil {
		t.Fatal(err)
	}
	chat := cursorstore.Chat{ID: "used", WorkspaceID: ws.ID, CWD: ws.Path, CreatedAt: 1700000000, LastUsedAt: 1700000001}
	if err := st.SaveChat(chat); err != nil {
		t.Fatal(err)
	}
	token, err := s.sessions.Create(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, workspace, id string
		authenticated       bool
		status              int
	}{
		{"unauthenticated", ws.ID, chat.ID, false, http.StatusUnauthorized},
		{"wrong_workspace", "other", chat.ID, true, http.StatusNotFound},
		{"missing_chat", ws.ID, "absent", true, http.StatusNotFound},
		{"successful_activation", ws.ID, chat.ID, true, http.StatusOK},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/api/workspaces/"+tc.workspace+"/chats/"+tc.id+"/touch", nil)
			if tc.authenticated {
				req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: token})
			}
			rec := httptest.NewRecorder()
			// When: explicit HTTP user activation (never opens/imports an engine).
			s.Handler().ServeHTTP(rec, req)
			// Then: authorization/membership enforced and successful use survives reload.
			if rec.Code != tc.status {
				t.Fatalf("status=%d want=%d body=%s", rec.Code, tc.status, rec.Body)
			}
			persisted, err := cursorstore.Open(path)
			if err != nil {
				t.Fatal(err)
			}
			got, err := persisted.GetChat(chat.ID)
			if err != nil {
				t.Fatal(err)
			}
			want := chat.LastUsedAt
			if tc.status == http.StatusOK {
				want = stamp.UnixMilli()
				var response struct {
					RecencyMs int64 `json:"recencyMs"`
				}
				if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
					t.Fatal(err)
				}
				if response.RecencyMs != want {
					t.Errorf("response=%+v want=%d", response, want)
				}
			}
			if got.LastUsedAt != want || got.CreatedAt != chat.CreatedAt || got.SessionFile != "" {
				t.Errorf("persisted=%+v want use=%d", got, want)
			}
		})
	}
}
