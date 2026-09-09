//go:build ignore

// Command exact-counts-tab-gate-fixture serves the committed application on
// an isolated loopback API/WS stack and owns all state it creates.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/api"
	"github.com/DevNewbie1826/omo-webchat/internal/auth"
	"github.com/DevNewbie1826/omo-webchat/internal/config"
	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
	"github.com/DevNewbie1826/omo-webchat/internal/wsbridge"
)

const (
	workspaceID = "qa-counts"
	chatID      = "qa-counts-chat"
	password    = "exact-counts-isolated"
)

type trafficRecorder struct {
	mu       sync.Mutex
	requests []map[string]any
	emitted  bool
}

func (r *trafficRecorder) add(req *http.Request) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.requests = append(r.requests, map[string]any{"method": req.Method, "path": req.URL.RequestURI(), "at": time.Now().UTC().Format(time.RFC3339Nano)})
}

func (r *trafficRecorder) receipt() map[string]any {
	r.mu.Lock()
	defer r.mu.Unlock()
	return map[string]any{"requests": append([]map[string]any(nil), r.requests...), "emitted": r.emitted}
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func seedStore(root string) (*cursorstore.Store, error) {
	store, err := cursorstore.Open(filepath.Join(root, "state.json"))
	if err != nil {
		return nil, err
	}
	workspace := filepath.Join(root, "workspace")
	if err := os.MkdirAll(workspace, 0700); err != nil {
		return nil, err
	}
	if err := store.SaveWorkspace(cursorstore.Workspace{ID: workspaceID, Name: "Exact counts QA", Path: workspace}); err != nil {
		return nil, err
	}
	if err := store.SaveChat(cursorstore.Chat{ID: chatID, WorkspaceID: workspaceID, Name: "Fifty running agents", NameSource: cursorstore.NameSourceUser, CWD: workspace, Provider: "omo", SessionProvenance: cursorstore.SessionProvenanceNative}); err != nil {
		return nil, err
	}
	if err := store.SetLayout(json.RawMessage(`{"kind":"leaf","id":"qa-pane","sessionId":"qa-counts-chat"}`)); err != nil {
		return nil, err
	}
	return store, nil
}

func writeRoster(workspace, parent string) error {
	dir := filepath.Join(workspace, ".omo", "senpi-task", "tasks")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	for i := 0; i < 50; i++ {
		row := map[string]any{
			"task_id": fmt.Sprintf("running-%03d", i), "parent_session_id": parent,
			"status": "running", "name": fmt.Sprintf("Running task %03d", i+1),
			"agent_type": "qa-worker", "created_at": "2026-09-09T10:00:00Z", "updated_at": "2026-09-09T10:00:01Z",
		}
		raw, err := json.Marshal(row)
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("task-%03d.json", i)), raw, 0600); err != nil {
			return err
		}
	}
	return nil
}

func emitCounts(store *cursorstore.Store, daemon *omorpctest.Daemon, recorder *trafficRecorder) error {
	recorder.mu.Lock()
	if recorder.emitted {
		recorder.mu.Unlock()
		return errors.New("fixture activity already emitted")
	}
	recorder.mu.Unlock()
	chat, err := store.GetChat(chatID)
	if err != nil {
		return err
	}
	if chat.SessionFile == "" || chat.DurableSessionID == "" {
		return errors.New("chat binding is not ready")
	}
	workspace, err := store.GetWorkspace(workspaceID)
	if err != nil {
		return err
	}
	if err := writeRoster(workspace.Path, chat.DurableSessionID); err != nil {
		return err
	}
	tasks := make([]any, 0, 600)
	for i := 0; i < 600; i++ {
		status, id := "completed", fmt.Sprintf("digest-%03d", i)
		if i < 50 {
			status, id = "running", fmt.Sprintf("running-%03d", i)
		}
		// Keep the source snapshot below its independent byte bound. Its full
		// membership then reaches the attached activity shelf while the 512-row
		// digest cap still proves scalar authority over a truncated digest.
		tasks = append(tasks, map[string]any{"task_id": id, "status": status})
	}
	daemon.EmitSession(chat.SessionFile, map[string]any{
		"type": "extension_event", "name": "omo.task.updated",
		"data": map[string]any{"parent_session_id": chat.DurableSessionID, "truncated_tasks": false, "tasks": tasks},
	})
	recorder.mu.Lock()
	recorder.emitted = true
	recorder.mu.Unlock()
	return nil
}

func run() error {
	root := flag.String("root", "", "fresh empty owned root")
	address := flag.String("listen", "127.0.0.1:0", "loopback listen address")
	flag.Parse()
	if !filepath.IsAbs(*root) {
		return errors.New("absolute --root required")
	}
	entries, err := os.ReadDir(*root)
	if err != nil || len(entries) != 0 {
		return errors.New("--root must be an existing empty directory")
	}
	host, _, err := net.SplitHostPort(*address)
	if err != nil || host != "127.0.0.1" {
		return errors.New("loopback listen address required")
	}
	store, err := seedStore(*root)
	if err != nil {
		return err
	}
	daemonRoot := filepath.Join(*root, "daemon")
	if err := os.MkdirAll(daemonRoot, 0700); err != nil {
		return err
	}
	daemon := omorpctest.New(daemonRoot)
	if err := daemon.Start(); err != nil {
		return err
	}
	defer daemon.Stop()
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	client, err := omorpc.Dial(ctx, daemon.SocketPath())
	if err != nil {
		return err
	}
	defer client.Close()
	manager := session.NewManager(session.Config{Client: client, Store: (*wsbridge.CursorStore)(store)})
	defer func() {
		shutdown, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = manager.CloseAll(shutdown)
	}()
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	sessions := auth.NewSessionStore(ctx, password, logger)
	bridge := wsbridge.New(wsbridge.Config{
		Context: ctx, Manager: manager, Store: store, ServerVersion: client.ServerVersion(), Logger: logger,
	})
	server := api.New(ctx, &config.Config{Root: *root}, store, sessions, manager, bridge, logger)
	app := server.Handler()
	recorder := &trafficRecorder{}
	handler := http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		recorder.add(req)
		switch req.URL.Path {
		case "/__qa/emit":
			if req.Method != http.MethodPost {
				w.WriteHeader(http.StatusMethodNotAllowed)
				return
			}
			if err := emitCounts(store, daemon, recorder); err != nil {
				writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"emitted": true, "running": 50, "payload_tasks": 600, "roster_tasks": 50})
		case "/__qa/receipt":
			writeJSON(w, http.StatusOK, recorder.receipt())
		default:
			app.ServeHTTP(w, req)
		}
	})
	listener, err := net.Listen("tcp", *address)
	if err != nil {
		return err
	}
	httpServer := &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second}
	stopped := make(chan error, 1)
	go func() { stopped <- httpServer.Serve(listener) }()
	fmt.Printf("EXACT_COUNTS_QA_READY http://%s\n", listener.Addr())
	select {
	case err := <-stopped:
		return err
	case <-ctx.Done():
		shutdown, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		if err := httpServer.Shutdown(shutdown); err != nil {
			return errors.Join(err, httpServer.Close())
		}
		if err := <-stopped; !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	}
	fmt.Println("EXACT_COUNTS_QA_STOPPED")
	return nil
}

func main() {
	if err := run(); err != nil && !errors.Is(err, io.EOF) {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
