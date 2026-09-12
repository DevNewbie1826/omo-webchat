package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

const engineRestartTimeout = 2 * time.Minute

type engineRestartResponse struct {
	Restarted           bool   `json:"restarted"`
	EngineVersionBefore string `json:"engineVersionBefore"`
	EngineVersionAfter  string `json:"engineVersionAfter"`
	ActiveChats         int    `json:"activeChats"`
}

// handleSystemEngineRestart replaces the running omo engine with a fresh
// process. Stopping a supervisor never closes the long-lived RPC client, so
// the client's reconnect hook spawns the successor engine and the session
// manager reopens the durable chats on the new connection epoch.
func (s *Server) handleSystemEngineRestart(w http.ResponseWriter, r *http.Request) {
	// There is deliberately no command, argument, or version input.
	// Require exactly one empty JSON object rather than silently ignoring fields.
	r.Body = http.MaxBytesReader(w, r.Body, 1024)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var request *struct{}
	if err := decoder.Decode(&request); err != nil || request == nil {
		writeError(w, http.StatusBadRequest, "expected an empty JSON object")
		return
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		writeError(w, http.StatusBadRequest, "expected a single empty JSON object")
		return
	}
	// Installation updates and engine restarts replace the same binary, so
	// they must never overlap; both endpoints single-flight on this mutex.
	if !s.updateMu.TryLock() {
		writeError(w, http.StatusConflict, "engine restart already running")
		return
	}
	defer s.updateMu.Unlock()
	activeChats := s.activeChatCount()
	// A closed tab must not interrupt a running restart; server shutdown and
	// this deadline still cancel the whole replacement sequence.
	ctx, cancel := context.WithTimeout(s.ctx, engineRestartTimeout)
	defer cancel()
	before, after, err := s.restartEngine(ctx)
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, omorpc.ErrDaemonNotOwned) {
			status = http.StatusConflict
		} else if errors.Is(err, context.DeadlineExceeded) {
			status = http.StatusGatewayTimeout
		}
		writeError(w, status, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, engineRestartResponse{
		Restarted: true, EngineVersionBefore: before, EngineVersionAfter: after, ActiveChats: activeChats,
	})
}

// activeChatCount reports chats whose provider run is currently active, so
// the UI can warn before an engine replacement interrupts streaming turns.
func (s *Server) activeChatCount() int {
	if s.manager == nil {
		return 0
	}
	active := 0
	for _, summary := range s.manager.LiveSummaries() {
		if summary.Active {
			active++
		}
	}
	return active
}
