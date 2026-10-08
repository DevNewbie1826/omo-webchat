package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

// attachEnrolled resolves a current routing handle without open_session.
// The state request is fenced to the list's exact connection epoch: a restarted
// daemon must not let a reused route ID masquerade as the listed session.
func (m *Manager) attachEnrolled(ctx context.Context, cur Cursor) (omorpc.OpenSessionData, omorpc.EpochToken, bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	resp, epoch, err := m.cfg.Client.CallInEpoch(ctx, omorpc.ListSessions{})
	if err != nil {
		return omorpc.OpenSessionData{}, epoch, false, err
	}
	if err := resp.Err(); err != nil {
		return omorpc.OpenSessionData{}, epoch, false, err
	}
	var list struct {
		Sessions []struct {
			SessionID        string `json:"sessionId"`
			DurableSessionID string `json:"durableSessionId"`
			SessionPath      string `json:"sessionPath"`
			SessionFile      string `json:"sessionFile"`
		} `json:"sessions"`
	}
	if err := json.Unmarshal(resp.Data, &list); err != nil {
		return omorpc.OpenSessionData{}, epoch, false, fmt.Errorf("decode enrolled routes: %w", err)
	}
	for _, route := range list.Sessions {
		path := route.SessionPath
		if path == "" {
			path = route.SessionFile
		}
		// Some daemon versions omit durable ids from list_sessions. Read state
		// for those routes so a durable identity moved to a new path still attaches.
		if route.DurableSessionID != "" && route.DurableSessionID != cur.DurableSessionID && path != cur.SessionFile {
			continue
		}
		stateResp, stateEpoch, err := m.cfg.Client.CallInEpochToken(ctx, epoch, omorpc.GetState{SessionID: route.SessionID})
		if err == nil {
			err = stateResp.Err()
		}
		if err != nil {
			var stable *omorpc.StableError
			if errors.As(err, &stable) && stable.Code == omorpc.ErrCodeUnknownSession {
				if (cur.DurableSessionID != "" && route.DurableSessionID == cur.DurableSessionID) ||
					(cur.DurableSessionID == "" && path == cur.SessionFile) {
					if path == "" {
						path = cur.SessionFile
					}
					return omorpc.OpenSessionData{SessionID: route.SessionID, State: omorpc.SessionState{SessionID: route.DurableSessionID, SessionFile: path}}, stateEpoch, true, nil
				}
				continue
			}
			return omorpc.OpenSessionData{}, stateEpoch, false, err
		}
		var state omorpc.SessionState
		if err := json.Unmarshal(stateResp.Data, &state); err != nil {
			return omorpc.OpenSessionData{}, stateEpoch, false, fmt.Errorf("decode enrolled state: %w", err)
		}
		if cur.DurableSessionID != "" && state.SessionID != cur.DurableSessionID {
			continue
		}
		if cur.DurableSessionID == "" && state.SessionFile != cur.SessionFile {
			continue
		}
		if state.SessionFile == "" {
			state.SessionFile = path
			if state.SessionFile == "" {
				state.SessionFile = cur.SessionFile
			}
		}
		return omorpc.OpenSessionData{SessionID: route.SessionID, State: state}, stateEpoch, true, nil
	}
	return omorpc.OpenSessionData{}, epoch, false, nil
}
