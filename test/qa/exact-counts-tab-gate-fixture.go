//go:build ignore

// Command exact-counts-tab-gate-fixture serves the committed application on
// an isolated loopback API/WS stack and owns all state it creates. Every live
// task fixture it publishes is a named row, and /__qa/complete flips named
// rows to a terminal status and replays the full membership so the QA can
// observe the engine's published count transitions on the real surface.
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
	runningRows = 50
	digestRows  = 550
	totalRows   = runningRows + digestRows
)

type qaTask struct {
	id, name, status string
	rosterFile       string
}

// qaState owns the named task membership, the emission generation that
// strictly advances every row clock, and the recorded traffic receipt.
type qaState struct {
	mu        sync.Mutex
	requests  []map[string]any
	tasks     []qaTask
	byID      map[string]int
	emissions int
	completed []string
	emitted   bool
}

func newQAState() *qaState {
	state := &qaState{byID: make(map[string]int, totalRows)}
	for i := 0; i < runningRows; i++ {
		state.tasks = append(state.tasks, qaTask{
			id: fmt.Sprintf("running-%03d", i), name: fmt.Sprintf("Running task %03d", i+1),
			status: "running", rosterFile: fmt.Sprintf("task-%03d.json", i),
		})
	}
	for i := 0; i < digestRows; i++ {
		state.tasks = append(state.tasks, qaTask{
			id: fmt.Sprintf("digest-%03d", i), name: fmt.Sprintf("Digest task %03d", i+1), status: "completed",
		})
	}
	for index, task := range state.tasks {
		state.byID[task.id] = index
	}
	return state
}

func (s *qaState) addRequest(req *http.Request) {
	row := map[string]any{"method": req.Method, "path": req.URL.RequestURI(), "at": time.Now().UTC().Format(time.RFC3339Nano)}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.requests = append(s.requests, row)
}

func (s *qaState) receipt() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	return map[string]any{
		"requests": append([]map[string]any(nil), s.requests...),
		"emitted":  s.emitted, "emissions": s.emissions,
		"completed": append([]string(nil), s.completed...), "total_rows": totalRows,
	}
}

// stampLocked is the emission clock: every replay advances it by a minute, so
// each revision is strictly newer than the previously accepted member state.
func (s *qaState) stampLocked() string {
	return fmt.Sprintf("2026-09-10T10:%02d:00Z", s.emissions)
}

func (s *qaState) rowsLocked() []any {
	stamp := s.stampLocked()
	rows := make([]any, 0, len(s.tasks))
	for _, task := range s.tasks {
		rows = append(rows, map[string]any{"task_id": task.id, "name": task.name, "status": task.status, "updated_at": stamp})
	}
	return rows
}

func (s *qaState) runningLocked() int {
	running := 0
	for _, task := range s.tasks {
		if task.status == "running" {
			running++
		}
	}
	return running
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

func writeRosterRow(dir, parent string, task qaTask, updated string) error {
	row := map[string]any{
		"task_id": task.id, "parent_session_id": parent, "status": task.status, "name": task.name,
		"agent_type": "qa-worker", "created_at": "2026-09-09T10:00:00Z", "updated_at": updated,
	}
	raw, err := json.Marshal(row)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, task.rosterFile), raw, 0600)
}

// rewriteRoster mirrors the current named membership onto the on-disk task
// store that backs the chat's full-roster read.
func rewriteRoster(state *qaState, workspace, parent, stamp string) error {
	state.mu.Lock()
	defer state.mu.Unlock()
	return rewriteRosterUnlocked(state, workspace, parent, stamp)
}

func chatBinding(store *cursorstore.Store) (cursorstore.Chat, cursorstore.Workspace, error) {
	chat, err := store.GetChat(chatID)
	if err != nil {
		return chat, cursorstore.Workspace{}, err
	}
	if chat.SessionFile == "" || chat.DurableSessionID == "" {
		return chat, cursorstore.Workspace{}, errors.New("chat binding is not ready")
	}
	workspace, err := store.GetWorkspace(workspaceID)
	return chat, workspace, err
}

// emit publishes the initial full named membership once. The 600-row source
// stays below its independent byte bound while the 512-entry digest cap still
// proves scalar authority over a truncated digest.
func (s *qaState) emit(store *cursorstore.Store, daemon *omorpctest.Daemon) error {
	s.mu.Lock()
	if s.emitted {
		s.mu.Unlock()
		return errors.New("fixture activity already emitted")
	}
	s.mu.Unlock()
	chat, workspace, err := chatBinding(store)
	if err != nil {
		return err
	}
	if err := rewriteRoster(s, workspace.Path, chat.DurableSessionID, "2026-09-09T10:00:01Z"); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	daemon.EmitSession(chat.SessionFile, map[string]any{
		"type": "extension_event", "name": "omo.task.updated",
		"data": map[string]any{"parent_session_id": chat.DurableSessionID, "truncated_tasks": false, "tasks": s.rowsLocked()},
	})
	s.emitted, s.emissions = true, s.emissions+1
	return nil
}

// complete flips the requested named running rows to completed, mirrors the
// roster, and replays the full membership with an advanced emission clock so
// the server recomputes and republishes its count authority.
func (s *qaState) complete(store *cursorstore.Store, daemon *omorpctest.Daemon, ids []string) ([]string, int, error) {
	s.mu.Lock()
	if !s.emitted {
		s.mu.Unlock()
		return nil, 0, errors.New("fixture activity not emitted yet")
	}
	if len(ids) == 0 {
		s.mu.Unlock()
		return nil, 0, errors.New("no task ids supplied")
	}
	for _, id := range ids {
		index, ok := s.byID[id]
		if !ok {
			s.mu.Unlock()
			return nil, 0, fmt.Errorf("unknown task %q", id)
		}
		if s.tasks[index].status != "running" {
			s.mu.Unlock()
			return nil, 0, fmt.Errorf("task %q is not running", id)
		}
	}
	s.mu.Unlock()
	chat, workspace, err := chatBinding(store)
	if err != nil {
		return nil, 0, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, id := range ids {
		s.tasks[s.byID[id]].status = "completed"
	}
	stamp := fmt.Sprintf("2026-09-10T10:%02d:00Z", s.emissions+1)
	s.emissions++
	// Mirror the flipped membership onto the on-disk task store under the
	// same lock, so the roster and the replay below never disagree.
	if err := rewriteRosterUnlocked(s, workspace.Path, chat.DurableSessionID, stamp); err != nil {
		return nil, 0, err
	}
	daemon.EmitSession(chat.SessionFile, map[string]any{
		"type": "extension_event", "name": "omo.task.updated",
		"data": map[string]any{"parent_session_id": chat.DurableSessionID, "truncated_tasks": false, "tasks": s.rowsLocked()},
	})
	flipped := append([]string(nil), ids...)
	s.completed = append(s.completed, flipped...)
	return flipped, s.runningLocked(), nil
}

// rewriteRosterUnlocked shares rewriteRoster's body for callers already
// holding the state lock.
func rewriteRosterUnlocked(s *qaState, workspace, parent, stamp string) error {
	dir := filepath.Join(workspace, ".omo", "senpi-task", "tasks")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	for _, task := range s.tasks {
		if task.rosterFile == "" {
			continue
		}
		if err := writeRosterRow(dir, parent, task, stamp); err != nil {
			return err
		}
	}
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
	state := newQAState()
	handler := http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		state.addRequest(req)
		switch req.URL.Path {
		case "/__qa/emit":
			if req.Method != http.MethodPost {
				w.WriteHeader(http.StatusMethodNotAllowed)
				return
			}
			if err := state.emit(store, daemon); err != nil {
				writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"emitted": true, "running": runningRows, "payload_tasks": totalRows, "roster_tasks": runningRows, "named_rows": true})
		case "/__qa/complete":
			if req.Method != http.MethodPost {
				w.WriteHeader(http.StatusMethodNotAllowed)
				return
			}
			var payload struct {
				TaskIDs []string `json:"taskIds"`
			}
			if err := json.NewDecoder(io.LimitReader(req.Body, 1<<20)).Decode(&payload); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			flipped, running, err := state.complete(store, daemon, payload.TaskIDs)
			if err != nil {
				writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"emitted": true, "completed": flipped, "running": running, "total": totalRows})
		case "/__qa/receipt":
			writeJSON(w, http.StatusOK, state.receipt())
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
