package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/rpcwatch"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
	"github.com/DevNewbie1826/omo-webchat/internal/wsbridge"
)

type liveEnrollmentCaller struct {
	*enrollmentCaller
	failList bool
}

func (c *liveEnrollmentCaller) CallInEpoch(ctx context.Context, cmd omorpc.Command) (*omorpc.Response, omorpc.EpochToken, error) {
	if _, list := cmd.(omorpc.ListSessions); list && c.failList {
		return nil, omorpc.EpochToken{}, errors.New("temporary list failure")
	}
	return c.enrollmentCaller.CallInEpoch(ctx, cmd)
}

func liveEnrollmentFixture(t *testing.T) (*Server, *cursorstore.Store, *liveEnrollmentCaller, cursorstore.Workspace) {
	t.Helper()
	s, store, caller, ws := enrollmentFixture(t)
	s.manager = session.NewManager(session.Config{Store: (*wsbridge.CursorStore)(store)})
	t.Cleanup(func() {
		if err := s.manager.CloseAll(context.Background()); err != nil {
			t.Error(err)
		}
	})
	wrapped := &liveEnrollmentCaller{enrollmentCaller: caller}
	s.rpcWatcher = rpcwatch.New(wrapped, rpcwatch.WithSnapshot(func(snapshot []rpcwatch.Session) {
		if err := s.reconcileEnrollment(snapshot); err != nil {
			t.Fatal(err)
		}
		s.applyEnrollmentLive(t.Context(), snapshot)
	}))
	return s, store, wrapped, ws
}

func enrollmentLiveRows(t *testing.T, s *Server) []liveSessionResponse {
	t.Helper()
	rec := httptest.NewRecorder()
	s.handleListLiveSessions(rec, httptest.NewRequest(http.MethodGet, "/api/sessions/live", nil))
	var body liveSessionsResponse
	if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &body) != nil {
		t.Fatalf("live REST = %d %s", rec.Code, rec.Body.String())
	}
	return body.Sessions
}

func TestDaemonEnrollmentLiveRESTDiskCounts(t *testing.T) {
	s, store, caller, ws := liveEnrollmentFixture(t)
	live := observedEnrollment(ws, "disk-durable")
	live.Name = "Disk session"
	taskDir := filepath.Join(ws.Path, ".omo", "senpi-task", "tasks")
	if err := os.MkdirAll(taskDir, 0o700); err != nil {
		t.Fatal(err)
	}
	write := func(status string) {
		for _, id := range []string{"one", "two"} {
			data, err := json.Marshal(map[string]any{"task_id": id, "parent_session_id": live.DurableSessionID, "status": status})
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(taskDir, id+".json"), data, 0o600); err != nil {
				t.Fatal(err)
			}
		}
	}
	write("running")
	caller.sessions = []rpcwatch.Session{live}
	s.rpcWatcher.Tick(t.Context())
	chat := store.ListChats(ws.ID)[0]
	rows := enrollmentLiveRows(t, s)
	if len(rows) != 1 || rows[0].ID != chat.ID || rows[0].Title != live.Name || !rows[0].Active || rows[0].BindingID != "" || rows[0].Running.Agents != 2 || rows[0].Running.Tasks != 2 {
		t.Fatalf("disk live REST = %+v", rows)
	}
	write("completed")
	caller.sessions[0].Status = "idle"
	s.rpcWatcher.Tick(t.Context())
	rows = enrollmentLiveRows(t, s)
	if len(rows) != 1 || rows[0].Active || rows[0].Running.Agents != 0 {
		t.Fatalf("completed live REST = %+v", rows)
	}
}

func TestDaemonEnrollmentListFailureKeepsLiveRow(t *testing.T) {
	s, _, caller, ws := liveEnrollmentFixture(t)
	caller.sessions = []rpcwatch.Session{observedEnrollment(ws, "list-durable")}
	s.rpcWatcher.Tick(t.Context())
	before := enrollmentLiveRows(t, s)
	if len(before) != 1 || !before[0].Active {
		t.Fatalf("initial live row = %+v", before)
	}
	caller.failList = true
	s.rpcWatcher.Tick(t.Context())
	after := enrollmentLiveRows(t, s)
	beforeJSON, _ := json.Marshal(before)
	afterJSON, _ := json.Marshal(after)
	if string(beforeJSON) != string(afterJSON) {
		t.Fatalf("failed list changed row: %s -> %s", beforeJSON, afterJSON)
	}
}

func TestDaemonEnrollmentTombstoneNoLiveRow(t *testing.T) {
	s, store, caller, ws := liveEnrollmentFixture(t)
	live := observedEnrollment(ws, "tombstoned-live")
	caller.sessions = []rpcwatch.Session{live}
	s.rpcWatcher.Tick(t.Context())
	chat := store.ListChats(ws.ID)[0]
	// Preserve a stored alias for the same durable: the tombstone must win
	// even if ChatForDurable can still resolve a different stored chat.
	if err := store.SaveChat(cursorstore.Chat{ID: "alias", WorkspaceID: ws.ID, CWD: ws.Path, DurableSessionID: live.DurableSessionID, Name: "Alias"}); err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteChat(chat.ID); err != nil {
		t.Fatal(err)
	}
	if !store.EnrollmentDeleted(live.DurableSessionID) {
		t.Fatal("fixture did not persist enrollment tombstone")
	}
	updates := make(chan session.Summary, 4)
	stop := s.manager.SubscribeOverview(func(row session.Summary) { updates <- row })
	defer stop()
	s.rpcWatcher.Tick(t.Context())
	if rows := enrollmentLiveRows(t, s); len(rows) != 0 {
		t.Fatalf("tombstone resurrected live rows: %+v", rows)
	}
	select {
	case row := <-updates:
		if row.Active {
			t.Fatalf("tombstone republished active: %+v", row)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("tombstone removal not published")
	}
}
