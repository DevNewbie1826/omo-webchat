// Command idlefixture serves an isolated observed-contract RPC fixture and QA controls.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
)

type pathRequest struct {
	Path string `json:"path"`
}

type noticeRequest struct {
	Path  string `json:"path"`
	Shape string `json:"shape"`
}

type historyRequest struct {
	Path  string `json:"path"`
	Count int    `json:"count"`
}

type failureRequest struct {
	Path     string `json:"path"`
	Attempts int    `json:"attempts"`
}

type tokenRequest struct {
	Token string `json:"token"`
}

type finalBarrier struct {
	path     string
	command  string
	baseline int
	evict    bool
	release  func()
}

const qaPromptReply = "fixture response"

func configureQAPromptLifecycle(d *omorpctest.Daemon) {
	d.SetDefaultPromptScript(
		map[string]any{"type": omorpctest.EventAgentStart},
		map[string]any{
			"type":    omorpctest.EventMessage,
			"message": map[string]any{"role": "assistant", "content": qaPromptReply},
		},
		map[string]any{"type": omorpctest.EventAgentEnd, "willRetry": false},
		map[string]any{"type": omorpctest.EventAgentSettled, "reason": "end_turn"},
	)
}

type controls struct {
	daemon *omorpctest.Daemon
	root   string

	mu       sync.Mutex
	next     uint64
	barriers map[string]finalBarrier
}

func (c *controls) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /state", c.state)
	mux.HandleFunc("POST /notice", c.notice)
	mux.HandleFunc("POST /silent", c.silent)
	mux.HandleFunc("POST /history", c.history)
	mux.HandleFunc("POST /open-failure", c.openFailure)
	mux.HandleFunc("POST /final-query/arm", c.armFinalQuery)
	mux.HandleFunc("POST /final-query/evict", c.evictAtBarrier)
	mux.HandleFunc("POST /open-barrier/arm", c.armOpen)
	mux.HandleFunc("POST /open-barrier/await", c.awaitBarrier)
	mux.HandleFunc("POST /open-barrier/release", c.releaseBarrier)
	return mux
}

func main() {
	root := flag.String("root", "", "isolated fixture root (required)")
	address := flag.String("control", "127.0.0.1:25024", "control listen address")
	flag.Parse()
	if *root == "" {
		fmt.Fprintln(os.Stderr, "--root is required")
		os.Exit(2)
	}
	absolute, err := filepath.Abs(*root)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	agentDir := filepath.Join(absolute, "agent")
	if err := os.MkdirAll(filepath.Join(agentDir, "rpc"), 0o700); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	for _, name := range []string{"chat-a", "chat-b"} {
		if err := os.MkdirAll(filepath.Join(absolute, "workspaces", name), 0o700); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	}
	d := omorpctest.NewAt(filepath.Join(absolute, "engine"), filepath.Join(agentDir, "rpc", "rpc.sock"))
	configureQAPromptLifecycle(d)
	if err := d.Start(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer d.Stop()

	control := &controls{daemon: d, root: absolute, barriers: make(map[string]finalBarrier)}
	server := &http.Server{Addr: *address, Handler: control.handler(), ReadHeaderTimeout: 5 * time.Second}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	go func() {
		<-ctx.Done()
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer shutdownCancel()
		_ = server.Shutdown(shutdownCtx)
	}()
	slog.Info("idle recovery fixture ready", "control", "http://"+*address, "agent_dir", agentDir, "root", absolute)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		slog.Error("fixture server failed", "error", err)
		os.Exit(1)
	}
}

func (c *controls) state(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"root": c.root, "agentDir": filepath.Join(c.root, "agent"),
		"workspaceA": filepath.Join(c.root, "workspaces", "chat-a"),
		"workspaceB": filepath.Join(c.root, "workspaces", "chat-b"),
		"openCount":  c.daemon.OpenCount(), "promptCount": c.daemon.RequestCount(omorpc.CmdPrompt),
		"sessions": c.daemon.SessionSnapshots(),
	})
}

func (c *controls) notice(w http.ResponseWriter, r *http.Request) {
	var request noticeRequest
	if !decode(w, r, &request) {
		return
	}
	switch request.Shape {
	case "session_closed", "session_unloaded":
		c.daemon.EvictSessionWithEvent(request.Path, request.Shape)
	case "close_session":
		c.daemon.EmitCloseSessionResponse(request.Path, true)
	case "close_session_negative":
		c.daemon.EmitCloseSessionResponse(request.Path, false)
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unknown notice shape"})
		return
	}
	// Ordinary empty queue_update on the same engine stream after the lifecycle
	// record. HTTP completed means both records were written, not app dispatch.
	c.daemon.EmitSession(request.Path, map[string]any{
		"type": omorpc.EventQueueUpdate, "ordered": []any{}, "pendingMessageCount": 0,
	})
	writeJSON(w, http.StatusOK, map[string]any{"completed": true, "shape": request.Shape})
}

func (c *controls) silent(w http.ResponseWriter, r *http.Request) {
	var request pathRequest
	if !decode(w, r, &request) {
		return
	}
	c.daemon.EvictSessionSilently(request.Path)
	writeJSON(w, http.StatusOK, map[string]any{"completed": true})
}

func (c *controls) history(w http.ResponseWriter, r *http.Request) {
	var request historyRequest
	if !decode(w, r, &request) || request.Count < 1 || request.Count > 2000 {
		if request.Count < 1 || request.Count > 2000 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "count must be 1..2000"})
		}
		return
	}
	for index := 1; index <= request.Count; index++ {
		role := "user"
		if index%2 == 0 {
			role = "assistant"
		}
		if !c.daemon.AppendHistory(request.Path, role, "fixture-entry-"+strconv.Itoa(index)) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown session path"})
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"completed": true, "added": request.Count})
}

func (c *controls) openFailure(w http.ResponseWriter, r *http.Request) {
	var request failureRequest
	if !decode(w, r, &request) || request.Attempts < 1 || request.Attempts > 10 {
		if request.Attempts < 1 || request.Attempts > 10 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "attempts must be 1..10"})
		}
		return
	}
	c.daemon.FailOpenPath(request.Path, omorpc.ErrCodeSessionPathInUse, request.Attempts)
	writeJSON(w, http.StatusOK, map[string]any{"completed": true, "attempts": request.Attempts})
}
