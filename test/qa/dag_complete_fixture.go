//go:build ignore

// The fixture owns only the root allocated by its caller. Login and DAG routes
// are served unchanged by api.Server.Handler; no DAG route is implemented here.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/api"
	"github.com/DevNewbie1826/omo-webchat/internal/auth"
	"github.com/DevNewbie1826/omo-webchat/internal/config"
	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/wsbridge"
)

type definitionNode struct {
	ID        string   `json:"id"`
	Label     string   `json:"label"`
	Prompt    string   `json:"prompt"`
	DependsOn []string `json:"dependsOn"`
}
type runtimeNode struct {
	ID          string `json:"id"`
	State       string `json:"state"`
	Attempt     int    `json:"attempt"`
	TaskID      string `json:"taskId"`
	StartedAt   string `json:"startedAt"`
	CompletedAt string `json:"completedAt,omitempty"`
}
type checkpoint struct {
	Schema     int    `json:"schemaVersion"`
	RunID      string `json:"runId"`
	RunKey     string `json:"runKey"`
	Name       string `json:"name"`
	Parent     string `json:"parentSessionId"`
	Status     string `json:"status"`
	Created    string `json:"createdAt"`
	Updated    string `json:"updatedAt"`
	Definition struct {
		Nodes []definitionNode `json:"nodes"`
	} `json:"definition"`
	Nodes []runtimeNode `json:"nodes"`
}
type fixtureManifest struct {
	Runs  []string          `json:"runs"`
	Files map[string]string `json:"files"`
}

func makeCheckpoint(id string, count, promptBytes int) checkpoint {
	const stamp = "2026-09-08T10:00:00Z"
	states := []string{"pending", "blocked", "scheduled", "running", "completed", "failed", "cancelled", "skipped"}
	row := checkpoint{Schema: 1, RunID: id, RunKey: id, Name: id, Parent: "qa-chat", Status: "running", Created: stamp, Updated: stamp, Nodes: []runtimeNode{}}
	row.Definition.Nodes = []definitionNode{}
	for i := 0; i < count; i++ {
		nodeID := fmt.Sprintf("node-%02d", i)
		if id == "long-identities" {
			nodeID = strings.Repeat("identity-", 70) + fmt.Sprint(i)
		}
		deps := []string{}
		for _, earlier := range row.Definition.Nodes {
			deps = append(deps, earlier.ID)
		}
		prompt := fmt.Sprintf("QA-%s-%02d-BEGIN-", id, i)
		prompt += strings.Repeat("x", promptBytes-len(prompt)-4) + "-END"
		row.Definition.Nodes = append(row.Definition.Nodes, definitionNode{ID: nodeID, Label: nodeID, Prompt: prompt, DependsOn: deps})
		node := runtimeNode{ID: nodeID, State: states[i%len(states)], Attempt: i%3 + 1, TaskID: fmt.Sprintf("task-%s-%02d", id, i), StartedAt: stamp}
		if node.State == "completed" {
			node.CompletedAt = stamp
		}
		row.Nodes = append(row.Nodes, node)
	}
	return row
}

func writeFixtureJSON(path string, value any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return os.WriteFile(path, raw, 0600)
}

func seedFixture(root string) (fixtureManifest, *cursorstore.Store, error) {
	manifest := fixtureManifest{Runs: []string{}, Files: map[string]string{}}
	store, err := cursorstore.Open(filepath.Join(root, "state.json"))
	if err != nil {
		return manifest, nil, err
	}
	workspace := filepath.Join(root, "workspace")
	if err := os.MkdirAll(workspace, 0700); err != nil {
		return manifest, nil, err
	}
	if err := store.SaveWorkspace(cursorstore.Workspace{ID: "qa-dag", Name: "QA DAG", Path: workspace}); err != nil {
		return manifest, nil, err
	}
	for _, id := range []string{"qa-chat", "other-chat", "malformed-chat", "escape-chat"} {
		cwd := workspace
		if id == "malformed-chat" {
			cwd = filepath.Join(workspace, "malformed")
		}
		if id == "escape-chat" {
			cwd = filepath.Join(workspace, "escape")
		}
		if err := os.MkdirAll(cwd, 0700); err != nil {
			return manifest, nil, err
		}
		chat := cursorstore.Chat{ID: id, WorkspaceID: "qa-dag", Name: id, NameSource: cursorstore.NameSourceUser, CWD: cwd, DurableSessionID: id, Provider: "omo", SessionProvenance: cursorstore.SessionProvenanceNative}
		if err := store.SaveChat(chat); err != nil {
			return manifest, nil, err
		}
	}
	if err := store.SaveWorkspace(cursorstore.Workspace{ID: "other-workspace", Name: "Other", Path: filepath.Join(root, "other")}); err != nil {
		return manifest, nil, err
	}
	add := func(row checkpoint) error {
		relative := filepath.Join("workspace", ".omo", "senpi-task", "dag", "runs", fmt.Sprintf("record-%04d.json", len(manifest.Runs)))
		if err := writeFixtureJSON(filepath.Join(root, relative), row); err != nil {
			return err
		}
		manifest.Runs = append(manifest.Runs, row.RunID)
		manifest.Files[row.RunID] = relative
		return nil
	}
	for i := 0; i < 518; i++ {
		if err := add(makeCheckpoint(fmt.Sprintf("history-%03d", i), 1, 128)); err != nil {
			return manifest, nil, err
		}
	}
	// Keep the 539-run catalog while adding two exact run IDs whose legacy
	// 512-byte projections collide. Filenames remain short and unrelated.
	for _, suffix := range []string{"0", "1"} {
		row := makeCheckpoint("long-identities", 2, 2048)
		row.RunID = strings.Repeat("a", 600) + suffix
		row.RunKey = row.RunID
		row.Name = "Long exact run " + suffix
		if err := add(row); err != nil {
			return manifest, nil, err
		}
	}
	for i := 0; i < 16; i++ {
		if err := add(makeCheckpoint(fmt.Sprintf("multi-%02d", i), 16, 2048)); err != nil {
			return manifest, nil, err
		}
	}
	for _, row := range []checkpoint{makeCheckpoint("dense-64", 64, 2048), makeCheckpoint("huge-record", 2, (2<<20)+2048), makeCheckpoint("long-identities", 2, 2048)} {
		if err := add(row); err != nil {
			return manifest, nil, err
		}
	}
	malformed := makeCheckpoint("malformed", 2, 2048)
	malformed.Parent = "malformed-chat"
	malformed.Definition.Nodes[1].ID = malformed.Definition.Nodes[0].ID
	if err := writeFixtureJSON(filepath.Join(workspace, "malformed", ".omo", "senpi-task", "dag", "runs", "owned.json"), malformed); err != nil {
		return manifest, nil, err
	}
	outside := filepath.Join(root, "outside")
	if err := os.MkdirAll(outside, 0700); err != nil {
		return manifest, nil, err
	}
	if err := os.MkdirAll(filepath.Join(workspace, "escape", ".omo"), 0700); err != nil {
		return manifest, nil, err
	}
	if err := os.Symlink(outside, filepath.Join(workspace, "escape", ".omo", "senpi-task")); err != nil {
		return manifest, nil, err
	}
	sort.Strings(manifest.Runs)
	if err := writeFixtureJSON(filepath.Join(root, "manifest.json"), manifest); err != nil {
		return manifest, nil, err
	}
	return manifest, store, nil
}

func fixtureHandler(ctx context.Context, store *cursorstore.Store) http.Handler {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	sessions := auth.NewSessionStore(ctx, "dag-complete-isolated", logger)
	return api.New(ctx, &config.Config{Root: store.StateDir()}, store, sessions, nil, wsbridge.Unavailable("isolated QA transport"), logger).Handler()
}

func runFixture() error {
	root := flag.String("root", "", "fresh empty owned root")
	address := flag.String("listen", "127.0.0.1:0", "loopback listen address")
	transport := flag.String("transport", "", "optional isolated synthetic WS/layout transport")
	flag.Parse()
	if !filepath.IsAbs(*root) {
		return errors.New("absolute --root required")
	}
	entries, err := os.ReadDir(*root)
	if err != nil {
		return err
	}
	if len(entries) != 0 {
		return errors.New("--root must be empty; existing stores are forbidden")
	}
	host, _, err := net.SplitHostPort(*address)
	if err != nil || host != "127.0.0.1" {
		return errors.New("loopback listen address required")
	}
	_, store, err := seedFixture(*root)
	if err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	listener, err := net.Listen("tcp", *address)
	if err != nil {
		return err
	}
	handler := fixtureHandler(ctx, store)
	if *transport != "" {
		target, err := url.Parse(*transport)
		if err != nil || target.Scheme != "http" || target.Hostname() != "127.0.0.1" {
			return errors.New("loopback transport required")
		}
		original, proxy := handler, httputil.NewSingleHostReverseProxy(target)
		handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/api/v2/ws", "/api/layout", "/api/sessions/live", "/api/providers", "/api/workspaces/qa-dag/chats/qa-chat/goal":
				proxy.ServeHTTP(w, r)
			default:
				original.ServeHTTP(w, r)
			}
		})
	}
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second}
	stopped := make(chan error, 1)
	go func() { stopped <- server.Serve(listener) }()
	fmt.Printf("DAG_COMPLETE_READY http://%s\n", listener.Addr())
	select {
	case err := <-stopped:
		return err
	case <-ctx.Done():
		shutdown, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		if err := server.Shutdown(shutdown); err != nil {
			return errors.Join(err, server.Close())
		}
		if err := <-stopped; !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	}
	fmt.Println("DAG_COMPLETE_STOPPED")
	return nil
}
func main() {
	if err := runFixture(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
