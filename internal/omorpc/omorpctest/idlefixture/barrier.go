package main

import (
	"net/http"
	"strconv"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func (c *controls) armFinalQuery(w http.ResponseWriter, r *http.Request) {
	c.armBarrier(w, r, omorpc.CmdGetEntries, true)
}

func (c *controls) armOpen(w http.ResponseWriter, r *http.Request) {
	c.armBarrier(w, r, omorpc.CmdOpenSession, false)
}

func (c *controls) armBarrier(w http.ResponseWriter, r *http.Request, command string, evict bool) {
	var request pathRequest
	if !decode(w, r, &request) {
		return
	}
	c.mu.Lock()
	c.next++
	token := "barrier-" + strconv.FormatUint(c.next, 10)
	c.barriers[token] = finalBarrier{
		path: request.Path, command: command, baseline: c.daemon.RequestCountForPath(command, request.Path), evict: evict,
		release: c.daemon.BlockHandlerForPath(command, request.Path),
	}
	c.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"armed": true, "token": token})
}

func (c *controls) awaitBarrier(w http.ResponseWriter, r *http.Request) {
	var request tokenRequest
	if !decode(w, r, &request) {
		return
	}
	c.mu.Lock()
	barrier, ok := c.barriers[request.Token]
	c.mu.Unlock()
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown barrier"})
		return
	}
	if !c.daemon.AwaitRequestCountForPath(barrier.command, barrier.path, barrier.baseline+1, 30*time.Second) {
		writeJSON(w, http.StatusGatewayTimeout, map[string]string{"error": "request barrier timed out"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"parked": true, "token": request.Token})
}

func (c *controls) releaseBarrier(w http.ResponseWriter, r *http.Request) {
	var request tokenRequest
	if !decode(w, r, &request) {
		return
	}
	c.mu.Lock()
	barrier, ok := c.barriers[request.Token]
	if ok {
		delete(c.barriers, request.Token)
	}
	c.mu.Unlock()
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown barrier"})
		return
	}
	barrier.release()
	writeJSON(w, http.StatusOK, map[string]any{"released": true, "token": request.Token})
}

func (c *controls) evictAtBarrier(w http.ResponseWriter, r *http.Request) {
	var request tokenRequest
	if !decode(w, r, &request) {
		return
	}
	c.mu.Lock()
	barrier, ok := c.barriers[request.Token]
	if ok {
		delete(c.barriers, request.Token)
	}
	c.mu.Unlock()
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown barrier"})
		return
	}
	defer barrier.release()
	if !c.daemon.AwaitRequestCountForPath(barrier.command, barrier.path, barrier.baseline+1, 30*time.Second) {
		writeJSON(w, http.StatusGatewayTimeout, map[string]string{"error": "request barrier timed out"})
		return
	}
	if barrier.evict {
		c.daemon.EvictSessionSilently(barrier.path)
	}
	writeJSON(w, http.StatusOK, map[string]any{"completed": true, "token": request.Token})
}
