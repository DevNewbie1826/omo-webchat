package main

import (
	"context"
	"encoding/json"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
	"io"
	"log/slog"
	"net/http"
	"os"
	"time"
)

type controls struct {
	journal  *journal
	provider *fakeRPC
	daemon   *omorpctest.Daemon
}
type controlRequest struct {
	Entry   map[string]any   `json:"entry"`
	Parent  string           `json:"parent"`
	Persist bool             `json:"persist"`
	Token   string           `json:"token"`
	Events  []map[string]any `json:"events"`
	Enabled bool             `json:"enabled"`
}

func reply(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(value); err != nil {
		slog.Error("fixture control response", "error", err)
	}
}
func (c *controls) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /state", func(w http.ResponseWriter, r *http.Request) {
		c.journal.mu.Lock()
		leaf := c.journal.leaf
		c.journal.mu.Unlock()
		c.provider.mu.Lock()
		reads := c.provider.reads
		c.provider.mu.Unlock()
		reply(w, map[string]any{"openCount": c.daemon.OpenCount(), "reads": reads, "leafId": leaf, "sessions": c.daemon.SessionSnapshots(), "requests": c.daemon.Requests()})
	})
	mux.HandleFunc("POST /", func(w http.ResponseWriter, r *http.Request) {
		var q controlRequest
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&q); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		if err := dec.Decode(new(any)); err != io.EOF {
			http.Error(w, "expected one JSON object", 400)
			return
		}
		result := map[string]any{"ok": true}
		var err error
		switch r.URL.Path {
		case "/append":
			if q.Entry == nil || (q.Entry["type"] != "custom" && q.Entry["type"] != "message" && q.Entry["type"] != "compaction") {
				http.Error(w, "entry must be custom, message, or compaction", 400)
				return
			}
			if _, exists := q.Entry["id"]; exists {
				http.Error(w, "fixture owns entry coordinates", 400)
				return
			}
			result["entryId"], err = c.journal.append(q.Entry, q.Parent, q.Persist)
		case "/persist":
			c.journal.mu.Lock()
			err = c.journal.persistLocked()
			c.journal.mu.Unlock()
		case "/read/arm":
			result["token"], err = c.journal.arm()
		case "/read/await", "/read/release":
			var g *readGate
			g, err = c.journal.getGate(q.Token)
			if err == nil {
				if r.URL.Path == "/read/release" {
					g.once.Do(func() { close(g.release) })
					ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
					defer cancel()
					select {
					case <-g.completed:
						result["writeCompleted"] = true
					case <-ctx.Done():
						err = ctx.Err()
					}
				} else {
					ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
					defer cancel()
					select {
					case <-g.entered:
						result["snapshot"] = g.snapshot
					case <-ctx.Done():
						err = ctx.Err()
					}
				}
			}
		case "/read/failure":
			c.journal.mu.Lock()
			c.journal.failRead = q.Enabled
			c.journal.mu.Unlock()
		case "/disk/failure":
			if q.Enabled {
				err = os.Rename(c.journal.path, c.journal.path+".held")
			} else {
				err = os.Rename(c.journal.path+".held", c.journal.path)
			}
		case "/events":
			for _, event := range q.Events {
				switch event["type"] {
				case "tool", "tool_execution_start", "tool_execution_end", "agent_start", "agent_end", "agent_settled", "compaction_start", "compaction_end", "message":
				default:
					http.Error(w, "unsupported provider event", 400)
					return
				}
			}
			for _, event := range q.Events {
				c.daemon.EmitSession(c.journal.path, event)
			}
		case "/evict":
			c.daemon.EvictSessionWithEvent(c.journal.path, "session_unloaded")
		case "/drop-provider":
			c.daemon.DropConnections()
		default:
			http.NotFound(w, r)
			return
		}
		if err != nil {
			http.Error(w, err.Error(), 409)
			return
		}
		reply(w, result)
	})
	return mux
}
