package api

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/rpcwatch"
)

// enrollmentCaller models only the daemon's read-only list/state boundary.
// Persistence, reconciliation, HTTP projection, and deletion remain real.
type enrollmentCaller struct {
	sessions []rpcwatch.Session
}

func (c *enrollmentCaller) CallInEpoch(_ context.Context, cmd omorpc.Command) (*omorpc.Response, omorpc.EpochToken, error) {
	var data any
	switch cmd := cmd.(type) {
	case omorpc.ListSessions:
		data = map[string]any{"sessions": c.sessions}
	case omorpc.GetState:
		for _, s := range c.sessions {
			if s.SessionID != cmd.SessionID {
				continue
			}
			data = map[string]any{"sessionId": s.DurableSessionID, "sessionFile": s.SessionPath, "sessionName": s.Name, "messageCount": s.MessageCount,
				"isStreaming": s.Status == "working", "isCompacting": false}
		}
	default:
		return nil, omorpc.EpochToken{}, fmt.Errorf("unexpected command %T", cmd)
	}
	raw, err := json.Marshal(data)
	return &omorpc.Response{Success: true, Data: raw}, omorpc.EpochToken{}, err
}

func enrollmentFixture(t *testing.T) (*Server, *cursorstore.Store, *enrollmentCaller, cursorstore.Workspace) {
	t.Helper()
	s, store, ws := newChatCreateTestServer(t)
	t.Setenv("OMO_CODING_AGENT_DIR", t.TempDir())
	caller := &enrollmentCaller{}
	s.rpcWatcher = rpcwatch.New(caller, rpcwatch.WithSnapshot(func(snapshot []rpcwatch.Session) {
		if err := s.reconcileEnrollment(snapshot); err != nil {
			t.Fatal(err)
		}
	}))
	return s, store.Store, caller, ws
}

func observedEnrollment(ws cursorstore.Workspace, id string) rpcwatch.Session {
	return rpcwatch.Session{SessionID: "rpc-" + id, DurableSessionID: id, SessionPath: filepath.Join(ws.Path, id+".jsonl"), Cwd: ws.Path, Status: "working", MessageCount: 3}
}

func TestEnrollmentLiveStatusFollowsWatcherAndClearsAfterEnd(t *testing.T) {
	// Given: an unclicked daemon session, including a not-yet-written file.
	s, store, caller, ws := enrollmentFixture(t)
	caller.sessions = []rpcwatch.Session{observedEnrollment(ws, "durable-live")}
	s.rpcWatcher.Tick(t.Context())
	chats := store.ListChats(ws.ID)
	if len(chats) != 1 {
		t.Fatalf("enrolled chats = %+v", chats)
	}
	for _, status := range []string{"working", "idle", "ended"} {
		t.Run(status, func(t *testing.T) {
			// When: the daemon changes state or no longer lists the route.
			if status == "ended" {
				caller.sessions = nil
			} else {
				caller.sessions[0].Status = status
			}
			s.rpcWatcher.Tick(t.Context())
			page := listWorkspaceSessions(t, s, ws.ID, "")
			// Then: the same stored row exposes durable identity and current live
			// state, and ending only clears live, not the persistent chat.
			if len(page.Items) != 1 || page.Items[0].ID != chats[0].ID || page.Items[0].DurableSessionID != "durable-live" {
				t.Fatalf("stored identity projection = %+v", page.Items)
			}
			live := page.Items[0].Live
			if status == "ended" {
				if live {
					t.Fatalf("ended session retained live")
				}
			} else {
				if !live {
					t.Fatalf("known daemon status %s not projected live", status)
				}
			}
		})
	}
}
