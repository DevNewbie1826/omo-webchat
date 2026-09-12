package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"
)

const installationUpdateTimeout = 10 * time.Minute

func (s *Server) handleSystemUpdate(w http.ResponseWriter, r *http.Request) {
	// There is deliberately no command, argument, package, or version input.
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
	if !s.updateMu.TryLock() {
		writeError(w, http.StatusConflict, "installation update already running")
		return
	}
	defer s.updateMu.Unlock()
	// A closed tab must not interrupt npm's reification of the installed package.
	// Server shutdown and this deadline still cancel the entire installer tree.
	ctx, cancel := context.WithTimeout(s.ctx, installationUpdateTimeout)
	defer cancel()
	if err := s.updateInstallation(ctx); err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, context.DeadlineExceeded) {
			status = http.StatusGatewayTimeout
		} else if errors.Is(err, context.Canceled) {
			status = http.StatusServiceUnavailable
		}
		writeError(w, status, err.Error())
		return
	}
	// The running daemon and this webchat process retain their current code.
	writeJSON(w, http.StatusOK, struct {
		RestartRequired bool `json:"restartRequired"`
	}{RestartRequired: true})
}
