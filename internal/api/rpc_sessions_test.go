package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/auth"
	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/rpcwatch"
	"github.com/DevNewbie1826/omo-webchat/internal/wsbridge"
)

type rpcOpenCaller struct{ row rpcwatch.Session }

func (c rpcOpenCaller) CallInEpoch(_ context.Context, cmd omorpc.Command) (*omorpc.Response, omorpc.EpochToken, error) {
	var value any
	switch cmd.(type) {
	case omorpc.ListSessions:
		value = map[string]any{"sessions": []rpcwatch.Session{c.row}}
	case omorpc.GetState:
		value = map[string]any{"sessionId": c.row.DurableSessionID, "sessionFile": c.row.SessionPath, "sessionName": c.row.Name}
	}
	raw, err := json.Marshal(value)
	return &omorpc.Response{Success: true, Data: raw}, omorpc.EpochToken{}, err
}

func rpcOpenHTTP(t *testing.T, server *Server, wsID, route string) (int, chatResponse) {
	t.Helper()
	httpServer := httptest.NewServer(server.Handler())
	defer httpServer.Close()
	token, err := server.sessions.Create(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(map[string]string{"sessionId": route})
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodPost, httpServer.URL+"/api/workspaces/"+wsID+"/rpc-sessions/open", bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	request.AddCookie(&http.Cookie{Name: auth.CookieName, Value: token})
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("POST %s {sessionId:%q}: %s headers=%v body=%s", request.URL.Path, route, response.Status, response.Header, body)
	var chat chatResponse
	if response.StatusCode < 300 {
		if err := json.Unmarshal(body, &chat); err != nil {
			t.Fatal(err)
		}
	}
	return response.StatusCode, chat
}

func TestRPCOpenActivationBranches(t *testing.T) {
	for _, tc := range []struct {
		name, provenance, storedID string
		wantStatus                 int
	}{
		{"unbound", "", "", 201},
		{"in-place", cursorstore.SessionProvenanceInPlace, "durable-new", 200},
		{"native", cursorstore.SessionProvenanceNative, "durable-new", 200},
		{"adopted", cursorstore.SessionProvenanceAdopted, "durable-new", 200},
		{"unknown durable", cursorstore.SessionProvenanceInPlace, "", 200},
		{"replacement", cursorstore.SessionProvenanceInPlace, "durable-old", 201},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server, store, ws := newChatCreateTestServer(t)
			path := filepath.Join(ws.Path, "missing.jsonl")
			row := rpcwatch.Session{SessionID: "route", DurableSessionID: "durable-new", SessionPath: path, Cwd: ws.Path, Name: "Live title"}
			server.rpcWatcher = rpcwatch.New(rpcOpenCaller{row})
			server.rpcWatcher.Tick(t.Context())
			old := cursorstore.Chat{ID: "old-chat", WorkspaceID: ws.ID, CWD: ws.Path, SessionFile: path, DurableSessionID: tc.storedID, SessionProvenance: tc.provenance, Name: "Old title"}
			if tc.provenance != "" {
				if err := store.SaveChat(old); err != nil {
					t.Fatal(err)
				}
				var err error
				old, err = store.GetChat(old.ID)
				if err != nil {
					t.Fatal(err)
				}
			}
			server.activityCheck = func(context.Context, string, time.Duration) (sessionActivity, error) {
				return sessionActivity{Changed: true}, nil
			}
			status, opened := rpcOpenHTTP(t, server, ws.ID, "route")
			if status != tc.wantStatus {
				t.Fatalf("status=%d want=%d", status, tc.wantStatus)
			}
			if tc.wantStatus == 200 && opened.ID != old.ID {
				t.Fatal("compatible chat replaced")
			}
			if tc.provenance != "" {
				after, err := store.GetChat(old.ID)
				if err != nil || after != old {
					t.Fatalf("old chat mutated: %+v err=%v", after, err)
				}
			}
			if tc.name == "replacement" && opened.ID == old.ID {
				t.Fatal("replacement reused old chat")
			}
			if tc.name == "native" || tc.name == "adopted" {
				// Transition the selected chat to in-place only to expose any
				// unauthorized force bit. The active checker must still reject.
				if err := store.UpdateInPlaceIdentity(old.ID, path, tc.storedID); err != nil {
					t.Fatal(err)
				}
				server.authorizeInPlaceOpen(old.ID, false)
				if _, err := (*wsbridge.CursorStore)(store.Store).CursorForOpen(t.Context(), old.ID); err == nil {
					t.Fatal("plain select armed force")
				}
				return
			}
			cur, err := (*wsbridge.CursorStore)(store.Store).CursorForOpen(t.Context(), opened.ID)
			if err != nil || !cur.InPlace {
				t.Fatalf("forced cursor=%+v err=%v", cur, err)
			}
			if _, err := (*wsbridge.CursorStore)(store.Store).CursorForOpen(t.Context(), opened.ID); err == nil {
				t.Fatal("force was not one-shot")
			}
			status, reopened := rpcOpenHTTP(t, server, ws.ID, "route")
			if status != 200 || reopened.ID != opened.ID {
				t.Fatal("reopen did not select new compatible chat")
			}
			if _, err := (*wsbridge.CursorStore)(store.Store).CursorForOpen(t.Context(), opened.ID); err != nil {
				t.Fatalf("reopen did not reauthorize: %v", err)
			}
		})
	}
}

func TestRPCOpenRejectsAbsentAndMismatchedCWD(t *testing.T) {
	server, _, ws := newChatCreateTestServer(t)
	server.rpcWatcher = rpcwatch.New(rpcOpenCaller{rpcwatch.Session{SessionID: "route", SessionPath: filepath.Join(ws.Path, "missing"), Cwd: t.TempDir()}})
	server.rpcWatcher.Tick(t.Context())
	for _, tc := range []struct {
		id     string
		status int
	}{{"absent", 404}, {"route", 400}} {
		status, _ := rpcOpenHTTP(t, server, ws.ID, tc.id)
		if status != tc.status {
			t.Fatalf("%s status=%d want=%d", tc.id, status, tc.status)
		}
	}
}
