//go:build ignore

// Isolated RPC loss controls for real-server browser QA.
package main

import (
	"context"
	"encoding/json"
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

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
)

func main() {
	root := flag.String("root", "", "exclusive temporary runtime")
	flag.Parse()
	if *root == "" {
		log.Fatal("root required")
	}
	socket := filepath.Join(*root, "agent", "rpc", "rpc.sock")
	for _, p := range []string{filepath.Dir(socket), filepath.Join(*root, "workspace")} {
		if err := os.MkdirAll(p, 0700); err != nil {
			log.Fatal(err)
		}
	}
	d := omorpctest.NewAt(filepath.Join(*root, "engine"), socket)
	d.SetDefaultPromptScript(map[string]any{"type": "agent_start"}, map[string]any{"type": "message", "message": map[string]any{"role": "assistant", "content": "QA assistant response"}}, map[string]any{"type": "agent_end", "willRetry": false}, map[string]any{"type": "agent_settled", "reason": "end_turn"})
	if err := d.Start(); err != nil {
		log.Fatal(err)
	}
	defer d.Stop()
	var mu sync.Mutex
	gates := map[string]func(){}
	promptEntered := map[string]<-chan struct{}{}
	defer func() {
		for _, release := range gates {
			release()
		}
	}()
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		reply := func(v any) {
			if err := json.NewEncoder(w).Encode(v); err != nil {
				log.Printf("reply: %v", err)
			}
		}
		if r.URL.Path == "/state" {
			reply(map[string]any{"sessions": d.SessionSnapshots(), "requests": d.Requests()})
			return
		}
		var q struct {
			Path    string           `json:"path"`
			Command string           `json:"command"`
			Count   int              `json:"count"`
			Error   string           `json:"error"`
			Events  []map[string]any `json:"events"`
		}
		if err := json.NewDecoder(r.Body).Decode(&q); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		// Await uses the daemon's exact request feed; other controls remain available.
		if r.URL.Path == "/await" {
			if !d.AwaitRequestCountForPath(q.Command, q.Path, q.Count, 15*time.Second) {
				http.Error(w, "request deadline", 504)
				return
			}
			reply(map[string]any{"ok": true})
			return
		}
		if r.URL.Path == "/await-history" {
			if !d.AwaitSessionEntryCount(q.Path, q.Count, 15*time.Second) {
				http.Error(w, "durable application deadline", 504)
				return
			}
			reply(map[string]any{"ok": true})
			return
		}
		if r.URL.Path == "/await-prompt-before-apply" {
			mu.Lock()
			entered := promptEntered[q.Path]
			mu.Unlock()
			if entered == nil {
				http.Error(w, "no prompt barrier", 409)
				return
			}
			ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
			defer cancel()
			select {
			case <-entered:
				reply(map[string]any{"ok": true})
			case <-ctx.Done():
				http.Error(w, "prompt application barrier deadline", 504)
			}
			return
		}
		mu.Lock()
		defer mu.Unlock()
		key := q.Command + q.Path
		switch r.URL.Path {
		case "/prompt-before-apply":
			key = "prompt" + q.Path
			if gates[key] != nil {
				http.Error(w, "gate already held", 409)
				return
			}
			promptEntered[q.Path], gates[key] = d.BlockPromptBeforeApply(q.Path)
		case "/gate":
			if gates[key] != nil {
				http.Error(w, "gate already held", 409)
				return
			}
			gates[key] = d.BlockHandlerForPath(q.Command, q.Path)
		case "/release":
			if release := gates[key]; release != nil {
				release()
				delete(gates, key)
				if q.Command == "prompt" {
					delete(promptEntered, q.Path)
				}
			}
		case "/drop":
			d.DropConnections()
		case "/fail-open":
			d.FailOpenPath(q.Path, q.Error, 1)
		case "/events":
			for _, event := range q.Events {
				d.EmitSession(q.Path, event)
			}
		case "/history":
			if !d.AppendHistory(q.Path, "assistant", "QA durable history") {
				http.Error(w, "unknown history path", 400)
				return
			}
		case "/script":
			d.SetPromptScript(q.Path, q.Events...)
		default:
			http.NotFound(w, r)
			return
		}
		reply(map[string]any{"ok": true})
	})
	listener, err := net.Listen("tcp", "127.0.0.1:25372")
	if err != nil {
		log.Fatal(err)
	}
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	stopped := make(chan error, 1)
	go func() { stopped <- server.Serve(listener) }()
	fmt.Println("RPC_LOSS_FIXTURE_READY")
	<-ctx.Done()
	shutdown, done := context.WithTimeout(context.Background(), 5*time.Second)
	defer done()
	if err := server.Shutdown(shutdown); err != nil {
		log.Print(err)
	}
	if err := <-stopped; err != http.ErrServerClosed {
		log.Print(err)
	}
}
