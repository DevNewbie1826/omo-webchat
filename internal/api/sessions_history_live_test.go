package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/rpcwatch"
)

type unifiedCaller struct {
	rows []rpcwatch.Session
}

func (c *unifiedCaller) CallInEpoch(_ context.Context, cmd omorpc.Command) (*omorpc.Response, omorpc.EpochToken, error) {
	var data any
	switch cmd := cmd.(type) {
	case omorpc.ListSessions:
		data = map[string]any{"sessions": c.rows}
	case omorpc.GetState:
		for _, row := range c.rows {
			if row.SessionID == cmd.SessionID {
				state := map[string]any{"sessionId": row.DurableSessionID, "sessionFile": row.SessionPath, "sessionName": row.Name, "messageCount": row.MessageCount, "isStreaming": row.Status == "working"}
				if row.Status == "blocked" {
					state["pendingQuestions"] = []any{map[string]any{"questions": []any{map[string]string{"question": "Continue?"}}}}
				}
				data = state
			}
		}
	default:
		return nil, omorpc.EpochToken{}, fmt.Errorf("unexpected command %T", cmd)
	}
	raw, err := json.Marshal(data)
	return &omorpc.Response{Success: true, Data: raw}, omorpc.EpochToken{}, err
}

type unifiedPage struct {
	Items []struct {
		ID     string `json:"id"`
		Source string `json:"source"`
		Live   *struct {
			Status    string   `json:"status"`
			Questions []string `json:"questions"`
		} `json:"live"`
	} `json:"items"`
	NextCursor string             `json:"nextCursor"`
	Live       []rpcwatch.Session `json:"live"`
}

func unifiedWatch(t *testing.T, s *Server, rows []rpcwatch.Session) (*rpcwatch.Watcher, *unifiedCaller) {
	t.Helper()
	caller := &unifiedCaller{rows: rows}
	watcher := rpcwatch.New(caller, rpcwatch.WithClock(func() time.Time { return time.UnixMilli(123456789) }))
	watcher.Tick(t.Context())
	s.rpcWatcher = watcher
	return watcher, caller
}

func unifiedGet(t *testing.T, s *Server, wsID, query string) unifiedPage {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, "/api/workspaces/"+wsID+"/sessions?"+query, nil)
	r.SetPathValue("wsId", wsID)
	w := httptest.NewRecorder()
	s.handleListWorkspaceSessions(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("HTTP %d: %s", w.Code, w.Body.String())
	}
	var page unifiedPage
	if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	return page
}

func TestUnifiedSessionLiveAlwaysCompleteAcrossHistoryPages(t *testing.T) {
	// Given: six history rows and six watcher-only routes.
	s, st, ws := newChatCreateTestServer(t)
	t.Setenv("OMO_CODING_AGENT_DIR", t.TempDir())
	rows := make([]rpcwatch.Session, 6)
	for i := range rows {
		if err := st.SaveChat(cursorstore.Chat{ID: fmt.Sprintf("chat-%d", i), WorkspaceID: ws.ID, CWD: ws.Path, CreatedAt: int64(100 + i)}); err != nil {
			t.Fatal(err)
		}
		rows[i] = rpcwatch.Session{SessionID: fmt.Sprintf("route-%d", i), DurableSessionID: fmt.Sprintf("durable-%d", i), SessionPath: filepath.Join(ws.Path, fmt.Sprintf("missing-%d.jsonl", i)), Cwd: ws.Path, Name: "Foreign", Status: "working", MessageCount: 7}
	}
	unifiedWatch(t, s, rows)
	// When: request both pages.
	first := unifiedGet(t, s, ws.ID, "limit=5")
	second := unifiedGet(t, s, ws.ID, "cursor="+first.NextCursor)
	// Then: live is complete and independent of pagination.
	if len(first.Items) != 5 || first.NextCursor == "" || len(second.Items) != 1 || second.NextCursor != "" || len(first.Live) != 6 || len(second.Live) != 6 {
		t.Fatalf("first=%+v second=%+v", first, second)
	}
	if first.Live[5].SessionID != "route-5" || first.Live[5].UpdatedAt != 123456789 || first.Live[5].MessageCount != 7 || first.Live[5].Status != "working" || first.Live[5].Questions == nil {
		t.Fatalf("sixth live=%+v", first.Live[5])
	}
}

func TestUnifiedSessionVanishedLiveRemoved(t *testing.T) {
	s, _, ws := newChatCreateTestServer(t)
	watcher, caller := unifiedWatch(t, s, []rpcwatch.Session{{SessionID: "gone", Cwd: ws.Path}})
	if page := unifiedGet(t, s, ws.ID, ""); len(page.Live) != 1 {
		t.Fatalf("initial live=%+v", page.Live)
	}
	// When: the next list no longer contains the route.
	caller.rows = nil
	watcher.Tick(t.Context())
	// Then: no retention.
	if page := unifiedGet(t, s, ws.ID, ""); page.Live == nil || len(page.Live) != 0 {
		t.Fatalf("vanished live=%+v", page.Live)
	}
}

func TestUnifiedSessionBindingRequiresPathAndCompatibleDurableID(t *testing.T) {
	for _, tc := range []struct {
		name, provenance, storedID string
		differentPath              bool
		wantLive                   int
	}{
		{"native", cursorstore.SessionProvenanceNative, "durable", false, 0},
		{"in-place", cursorstore.SessionProvenanceInPlace, "durable", false, 0},
		{"adopted", cursorstore.SessionProvenanceAdopted, "durable", false, 0},
		{"unknown stored durable", cursorstore.SessionProvenanceNative, "", false, 0},
		{"conflicting replacement", cursorstore.SessionProvenanceInPlace, "old", false, 1},
		{"adopted copy distinct path", cursorstore.SessionProvenanceAdopted, "durable", true, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// Given: a stored chat and watcher route, no manager ownership.
			s, st, ws := newChatCreateTestServer(t)
			t.Setenv("OMO_CODING_AGENT_DIR", t.TempDir())
			path := filepath.Join(ws.Path, "missing.jsonl")
			chatPath := path
			if tc.differentPath {
				chatPath = filepath.Join(ws.Path, "copy.jsonl")
			}
			if err := st.SaveChat(cursorstore.Chat{ID: "bound", WorkspaceID: ws.ID, CWD: ws.Path, SessionFile: chatPath, DurableSessionID: tc.storedID, SessionProvenance: tc.provenance}); err != nil {
				t.Fatal(err)
			}
			unifiedWatch(t, s, []rpcwatch.Session{{SessionID: "route", DurableSessionID: "durable", SessionPath: path, Cwd: ws.Path, Status: "blocked"}})
			// When
			page := unifiedGet(t, s, ws.ID, "")
			// Then
			if len(page.Items) != 1 || len(page.Live) != tc.wantLive {
				t.Fatalf("page=%+v", page)
			}
			if tc.wantLive == 0 {
				if page.Items[0].Live == nil || page.Items[0].Live.Status != "blocked" || len(page.Items[0].Live.Questions) != 1 || page.Items[0].Live.Questions[0] != "Continue?" {
					t.Fatalf("bound live=%+v", page.Items[0])
				}
			} else if page.Items[0].Live != nil {
				t.Fatalf("nonmatching chat got watcher state: %+v", page.Items[0])
			}
		})
	}
}

func TestUnifiedSessionExistingDiskRowSuppressedByLive(t *testing.T) {
	s, _, ws := newChatCreateTestServer(t)
	agent := t.TempDir()
	t.Setenv("OMO_CODING_AGENT_DIR", agent)
	path := writeDiskSession(t, agent, ws.Path, "durable", "disk", time.UnixMilli(1))
	unifiedWatch(t, s, []rpcwatch.Session{{SessionID: "route", DurableSessionID: "durable", SessionPath: path, Cwd: ws.Path}})
	// When
	page := unifiedGet(t, s, ws.ID, "")
	// Then: real existing file does not create a duplicate discovered row.
	if len(page.Items) != 0 || len(page.Live) != 1 {
		t.Fatalf("page=%+v", page)
	}
}

func TestUnifiedSessionCanonicalCWDAndPath(t *testing.T) {
	s, st, ws := newChatCreateTestServer(t)
	alias := filepath.Join(t.TempDir(), "alias")
	if err := os.Symlink(ws.Path, alias); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if err := st.SaveChat(cursorstore.Chat{ID: "bound", WorkspaceID: ws.ID, CWD: ws.Path, SessionFile: filepath.Join(ws.Path, "missing.jsonl"), DurableSessionID: "durable"}); err != nil {
		t.Fatal(err)
	}
	unifiedWatch(t, s, []rpcwatch.Session{
		{SessionID: "bound-route", DurableSessionID: "durable", Cwd: alias, SessionPath: filepath.Join(alias, "missing.jsonl"), Status: "working"},
		{SessionID: "unbound", Cwd: alias},
		{SessionID: "foreign", Cwd: t.TempDir()},
	})
	page := unifiedGet(t, s, ws.ID, "")
	if len(page.Live) != 1 || page.Live[0].SessionID != "unbound" || len(page.Items) != 1 || page.Items[0].Live == nil {
		t.Fatalf("canonical union=%+v", page)
	}
}

func TestUnifiedSessionWithoutWatcherHasEmptyLiveArray(t *testing.T) {
	s, _, ws := newChatCreateTestServer(t)
	page := unifiedGet(t, s, ws.ID, "")
	if page.Live == nil || len(page.Live) != 0 {
		t.Fatalf("live=%+v, want []", page.Live)
	}
}

func TestUnifiedSessionHTTPContract(t *testing.T) {
	// Given: the real router and auth middleware on a TCP listener.
	s, _, ws := newChatCreateTestServer(t)
	unifiedWatch(t, s, []rpcwatch.Session{{SessionID: "http-route", Cwd: ws.Path, Status: "working"}})
	server := httptest.NewServer(s.Handler())
	defer server.Close()
	client := server.Client()
	client.Timeout = 5 * time.Second
	login, err := client.Post(server.URL+"/api/login", "application/json", strings.NewReader(`{"password":"pw"}`))
	if err != nil {
		t.Fatal(err)
	}
	cookies := login.Cookies()
	login.Body.Close()
	if login.StatusCode != http.StatusOK || len(cookies) == 0 {
		t.Fatalf("login=%d cookies=%v", login.StatusCode, cookies)
	}
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, server.URL+"/api/workspaces/"+ws.ID+"/sessions?limit=5", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(cookies[0])
	// When
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("%s %s\nheaders=%v\nbody=%s", resp.Proto, resp.Status, resp.Header, body)
	var page unifiedPage
	if err := json.Unmarshal(body, &page); err != nil {
		t.Fatal(err)
	}
	// Then
	if resp.StatusCode != http.StatusOK || resp.Header.Get("Content-Type") != "application/json" || len(page.Live) != 1 || page.Live[0].SessionID != "http-route" || page.Items == nil {
		t.Fatalf("HTTP union contract=%+v", page)
	}
	t.Cleanup(func() { t.Log("cleanup: httptest TCP server closed; test-owned files removed by testing.TempDir") })
}
