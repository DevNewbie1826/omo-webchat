//go:build ignore

// An isolated socket RPC fixture with task-local HTTP controls.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
)

type controls struct {
	d     *omorpctest.Daemon
	root  string
	mu    sync.Mutex
	chats map[string]string
	holds map[string]func()
}
type request struct {
	Chat     string           `json:"chat"`
	Path     string           `json:"path"`
	Error    string           `json:"error"`
	Attempts int              `json:"attempts"`
	Count    int              `json:"count"`
	Events   []map[string]any `json:"events"`
}

func reply(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(value); err != nil {
		log.Printf("control response: %v", err)
	}
}
func (c *controls) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /state", func(w http.ResponseWriter, r *http.Request) {
		reply(w, map[string]any{"root": c.root, "sessions": c.d.SessionSnapshots(), "requests": c.d.Requests(), "openCount": c.d.OpenCount()})
	})
	mux.HandleFunc("POST /", func(w http.ResponseWriter, r *http.Request) {
		var q request
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 128<<10))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&q); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		c.mu.Lock()
		defer c.mu.Unlock()
		if r.URL.Path == "/bind" {
			found := false
			for _, s := range c.d.SessionSnapshots() {
				if s.Path == q.Path {
					found = true
				}
			}
			if !found || (q.Chat != "A" && q.Chat != "B") {
				http.Error(w, "unknown chat/path", 400)
				return
			}
			c.chats[q.Chat] = q.Path
			reply(w, map[string]any{"ok": true})
			return
		}
		path := c.chats[q.Chat]
		if path == "" {
			http.Error(w, "bind chat first", 400)
			return
		}
		switch r.URL.Path {
		case "/evict":
			c.d.EvictSessionSilently(path)
		case "/fail-open":
			if q.Attempts < 1 || q.Attempts > 10 {
				http.Error(w, "attempts must be 1..10", 400)
				return
			}
			c.d.FailOpenPath(path, q.Error, q.Attempts)
		case "/history":
			if q.Count < 1 || q.Count > 2000 {
				http.Error(w, "count must be 1..2000", 400)
				return
			}
			for i := 1; i <= q.Count; i++ {
				role := "user"
				if i%2 == 0 {
					role = "assistant"
				}
				if !c.d.AppendHistory(path, role, fmt.Sprintf("rpc46-%s-history-%03d", q.Chat, i)) {
					http.Error(w, "history path missing", 500)
					return
				}
			}
		case "/events":
			for _, event := range q.Events {
				c.d.EmitSession(path, event)
			}
		case "/prompt-script":
			c.d.SetPromptScript(path, q.Events...)
		case "/compact-script":
			c.d.SetCompactScript(path, q.Events...)
		case "/hold-prompt":
			if c.holds[path] != nil {
				http.Error(w, "already held", 409)
				return
			}
			c.holds[path] = c.d.HoldPrompt(path)
		case "/release-prompt":
			if release := c.holds[path]; release != nil {
				release()
				delete(c.holds, path)
			}
		default:
			http.NotFound(w, r)
			return
		}
		reply(w, map[string]any{"ok": true})
	})
	return mux
}

func run(root string, selfcheck bool) error {
	root, err := filepath.Abs(root)
	if err != nil {
		return err
	}
	socket := filepath.Join(root, "agent", "rpc", "rpc.sock")
	if err := os.MkdirAll(filepath.Dir(socket), 0700); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(root, "workspace"), 0700); err != nil {
		return err
	}
	d := omorpctest.NewAt(filepath.Join(root, "engine"), socket)
	d.SetDefaultPromptScript(map[string]any{"type": "agent_start"}, map[string]any{"type": "message", "message": map[string]any{"role": "assistant", "content": "rpc46-fixture-response"}}, map[string]any{"type": "agent_end", "willRetry": false}, map[string]any{"type": "agent_settled", "reason": "end_turn"})
	if err := d.Start(); err != nil {
		return err
	}
	defer d.Stop()
	c := &controls{d: d, root: root, chats: map[string]string{}, holds: map[string]func(){}}
	defer func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		for _, release := range c.holds {
			release()
		}
	}()
	if selfcheck {
		return checkFixture(c, socket)
	}
	tcp, err := net.Listen("tcp", "127.0.0.1:25272")
	if err != nil {
		return err
	}
	server := &http.Server{Handler: c.handler(), ReadHeaderTimeout: 5 * time.Second}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	stopped := make(chan error, 1)
	go func() { stopped <- server.Serve(tcp) }()
	fmt.Println("RPC46_FIXTURE_READY")
	select {
	case err := <-stopped:
		return err
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdown); err != nil {
			return err
		}
		if err := <-stopped; !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	}
}
func checkFixture(c *controls, socket string) error {
	if c.d.SocketPath() != socket {
		return fmt.Errorf("daemon socket %q differs from public socket %q", c.d.SocketPath(), socket)
	}
	conn, err := net.Dial("unix", socket)
	if err != nil {
		return err
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(10 * time.Second)); err != nil {
		return err
	}
	enc := json.NewEncoder(conn)
	dec := json.NewDecoder(conn)
	exchange := func(req map[string]any) (map[string]any, error) {
		if err := enc.Encode(req); err != nil {
			return nil, err
		}
		var frame map[string]any
		if err := dec.Decode(&frame); err != nil {
			return nil, err
		}
		if frame["id"] != req["id"] || frame["type"] != "response" || frame["command"] != req["type"] {
			return nil, fmt.Errorf("uncorrelated response: %v for %v", frame, req)
		}
		return frame, nil
	}
	fresh, err := exchange(map[string]any{"id": "new", "type": "open_session", "cwd": filepath.Join(c.root, "workspace")})
	if err != nil {
		return err
	}
	if fresh["success"] != true {
		return fmt.Errorf("fresh: %v", fresh)
	}
	snapshots := c.d.SessionSnapshots()
	if len(snapshots) != 1 {
		return fmt.Errorf("sessions: %v", snapshots)
	}
	path := snapshots[0].Path
	post := func(route string, body request) error {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		recorder := httptest.NewRecorder()
		c.handler().ServeHTTP(recorder, httptest.NewRequest("POST", route, strings.NewReader(string(raw))))
		if recorder.Code != 200 {
			return fmt.Errorf("%s: %d %s", route, recorder.Code, recorder.Body.String())
		}
		return nil
	}
	if err := post("/bind", request{Chat: "A", Path: path}); err != nil {
		return err
	}
	for i, text := range []string{"open_failed: QA_CONTEXT_LIMIT 311799 > 272000", "arbitrary internal error", "open_failed:", "open_failed: \n\t", "open_failed: <img src=x onerror=alert(1)>\nline two", omorpc.ErrCodeSessionPathInUse, ""} {
		if err := post("/evict", request{Chat: "A"}); err != nil {
			return err
		}
		if err := post("/fail-open", request{Chat: "A", Error: text, Attempts: 1}); err != nil {
			return err
		}
		failed, err := exchange(map[string]any{"id": fmt.Sprint(i), "type": "open_session", "sessionPath": path})
		if err != nil {
			return err
		}
		want := text
		if want == "" {
			want = omorpc.ErrCodeSessionPathInUse
		}
		if failed["success"] != false || failed["error"] != want {
			return fmt.Errorf("exact direct daemon failure: got %v want %q", failed, want)
		}
		recovered, err := exchange(map[string]any{"id": fmt.Sprintf("retry-%d", i), "type": "open_session", "sessionPath": path})
		if err != nil {
			return err
		}
		if recovered["success"] != true {
			return fmt.Errorf("one-shot recovery: %v", recovered)
		}
	}
	if len(c.d.Requests()) != 15 || c.d.OpenCount() != 15 {
		return fmt.Errorf("requests: %d", len(c.d.Requests()))
	}
	if err := post("/history", request{Chat: "A", Count: 240}); err != nil {
		return err
	}
	if c.d.SessionSnapshots()[0].EntryCount != 240 {
		return io.ErrUnexpectedEOF
	}
	fmt.Println("RPC46_FIXTURE_SELFCHECK_OK cases=7 requests=15 history=240 controls=bind,evict,fail-open,history")
	return nil
}
func main() {
	root := flag.String("root", "", "owned isolated root")
	selfcheck := flag.Bool("selfcheck", false, "check exact socket failures without app")
	flag.Parse()
	if *root == "" {
		log.Fatal("--root required")
	}
	if err := run(*root, *selfcheck); err != nil {
		log.Fatal(err)
	}
}
