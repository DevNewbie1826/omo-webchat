package main

import (
	"net/http"
	"time"
)

// awaitClose observes completed protocol closes, not just received requests.
// The durable counter also handles a close that finishes before HTTP admission.
func (c *controls) awaitClose(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Count int `json:"count"`
	}
	if !decode(w, r, &request) {
		return
	}
	if request.Count < 1 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "count must be positive"})
		return
	}
	if !c.daemon.AwaitCloseCount(request.Count, 30*time.Second) {
		writeJSON(w, http.StatusGatewayTimeout, map[string]string{"error": "close barrier timed out"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"completed": true, "closeCount": c.daemon.CloseCount(), "sessions": c.daemon.SessionSnapshots(),
	})
}
