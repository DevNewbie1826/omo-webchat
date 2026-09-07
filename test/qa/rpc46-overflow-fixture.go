//go:build ignore

// Command rpc46-overflow-fixture serves a real Unix RPC daemon with isolated QA controls.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
)

type controls struct {
	daemon   *omorpctest.Daemon
	root     string
	mu       sync.Mutex
	releases map[string]func()
}

type controlRequest struct {
	Path     string           `json:"path"`
	Events   []map[string]any `json:"events"`
	Count    int              `json:"count"`
	Prefix   string           `json:"prefix"`
	Command  string           `json:"command"`
	Error    string           `json:"error"`
	Attempts int              `json:"attempts"`
}

func (c *controls) snapshot() map[string]any {
	return map[string]any{"root": c.root, "sessions": c.daemon.SessionSnapshots(), "requests": c.daemon.Requests(),
		"promptCount": c.daemon.RequestCount(omorpc.CmdPrompt), "compactCount": c.daemon.RequestCount(omorpc.CmdCompact)}
}

func respond(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		log.Printf("control response: %v", err)
	}
}

func (c *controls) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /state", func(w http.ResponseWriter, r *http.Request) { respond(w, 200, c.snapshot()) })
	mux.HandleFunc("POST /", func(w http.ResponseWriter, r *http.Request) {
		var req controlRequest
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&req); err != nil {
			respond(w, 400, map[string]any{"error": err.Error()})
			return
		}
		known := false
		for _, session := range c.daemon.SessionSnapshots() {
			if session.Path == req.Path {
				known = true
			}
		}
		if !known {
			respond(w, 404, map[string]any{"error": "unknown isolated session path"})
			return
		}
		switch r.URL.Path {
		case "/events":
			for _, event := range req.Events {
				c.daemon.EmitSession(req.Path, event)
			}
		case "/history":
			if req.Count < 1 || req.Count > 2000 {
				respond(w, 400, map[string]any{"error": "count must be 1..2000"})
				return
			}
			prefix := req.Prefix
			if prefix == "" {
				prefix = "rpc46-history"
			}
			for i := 1; i <= req.Count; i++ {
				role := "user"
				if i%2 == 0 {
					role = "assistant"
				}
				if !c.daemon.AppendHistory(req.Path, role, fmt.Sprintf("%s-%03d", prefix, i)) {
					respond(w, 404, map[string]any{"error": "session disappeared"})
					return
				}
			}
		case "/configure":
			c.mu.Lock()
			if c.releases["prompt:"+req.Path] == nil {
				c.daemon.SetPromptScript(req.Path, map[string]any{"type": "agent_start"})
				c.daemon.SetCompactScript(req.Path)
				c.releases["prompt:"+req.Path] = c.daemon.HoldPrompt(req.Path)
			}
			c.mu.Unlock()
		case "/hold-compact":
			c.mu.Lock()
			if c.releases["compact:"+req.Path] == nil {
				c.releases["compact:"+req.Path] = c.daemon.BlockHandlerForPath(omorpc.CmdCompact, req.Path)
			}
			c.mu.Unlock()
		case "/release":
			c.mu.Lock()
			release := c.releases[req.Command+":"+req.Path]
			delete(c.releases, req.Command+":"+req.Path)
			c.mu.Unlock()
			if release == nil {
				respond(w, 409, map[string]any{"error": "no matching hold"})
				return
			}
			release()
		case "/await-request":
			if req.Count < 1 || req.Command == "" {
				respond(w, 400, map[string]any{"error": "command and positive count required"})
				return
			}
			if !c.daemon.AwaitRequestCountForPath(req.Command, req.Path, req.Count, 10*time.Second) {
				respond(w, 408, map[string]any{"error": "request barrier deadline"})
				return
			}
		case "/silent":
			c.daemon.EvictSessionSilently(req.Path)
		case "/fail-open":
			if req.Attempts < 1 || req.Error != omorpc.ErrCodeSessionPathInUse {
				respond(w, 400, map[string]any{"error": "FailOpenPath supports only session_path_in_use; positive attempts required"})
				return
			}
			c.daemon.FailOpenPath(req.Path, req.Error, req.Attempts)
		default:
			respond(w, 404, map[string]any{"error": "unknown control"})
			return
		}
		respond(w, 200, c.snapshot())
	})
	return mux
}

func (c *controls) releaseAll() {
	c.mu.Lock()
	defer c.mu.Unlock()
	for key, release := range c.releases {
		release()
		delete(c.releases, key)
	}
}

func run() error {
	root := flag.String("root", "", "fresh isolated root (required)")
	address := flag.String("control", "127.0.0.1:25271", "loopback QA control address")
	flag.Parse()
	if *root == "" {
		return errors.New("--root is required")
	}
	absolute, err := filepath.Abs(*root)
	if err != nil {
		return err
	}
	for _, dir := range []string{"agent/rpc", "workspace", "state"} {
		if err := os.MkdirAll(filepath.Join(absolute, dir), 0700); err != nil {
			return err
		}
	}
	d := omorpctest.NewAt(filepath.Join(absolute, "engine"), filepath.Join(absolute, "agent/rpc/rpc.sock"))
	if err := d.Start(); err != nil {
		return err
	}
	defer d.Stop()
	c := &controls{daemon: d, root: absolute, releases: make(map[string]func())}
	defer c.releaseAll()
	ln, err := net.Listen("tcp", *address)
	if err != nil {
		return err
	}
	server := &http.Server{Handler: c.handler(), ReadHeaderTimeout: 5 * time.Second}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	stopped := make(chan error, 1)
	go func() { stopped <- server.Serve(ln) }()
	fmt.Printf("RPC46_FIXTURE_READY %s\n", ln.Addr())
	select {
	case err := <-stopped:
		return err
	case <-ctx.Done():
		c.releaseAll()
		shutdown, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		if err := server.Shutdown(shutdown); err != nil {
			return err
		}
		if err := <-stopped; !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	}
	return nil
}

func main() {
	if err := run(); err != nil {
		log.Print(err)
		os.Exit(1)
	}
}
