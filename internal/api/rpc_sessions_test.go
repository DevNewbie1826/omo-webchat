package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lxzan/gws"

	"github.com/DevNewbie1826/omo-webchat/internal/auth"
	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
	"github.com/DevNewbie1826/omo-webchat/internal/rpcwatch"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
	"github.com/DevNewbie1826/omo-webchat/internal/wsbridge"
)

type rpcSnapshotCaller struct{ sessions []rpcwatch.Session }

func (c *rpcSnapshotCaller) CallInEpoch(_ context.Context, cmd omorpc.Command) (*omorpc.Response, omorpc.EpochToken, error) {
	var value any = map[string]any{"messageCount": 3}
	if _, ok := cmd.(omorpc.ListSessions); ok {
		value = map[string]any{"sessions": c.sessions}
	}
	raw, err := json.Marshal(value)
	return &omorpc.Response{Success: true, Data: raw}, omorpc.EpochToken{}, err
}

func rpcHTTP(t *testing.T, s *Server) (string, func(string, string, string) (int, []byte)) {
	t.Helper()
	h := httptest.NewServer(s.Handler())
	t.Cleanup(h.Close)
	token, err := s.sessions.Create(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	call := func(method, path, body string) (int, []byte) {
		t.Helper()
		req, err := http.NewRequest(method, h.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: token})
		resp, err := h.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		raw, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("%s %s => %s headers=%v body=%s", method, path, resp.Status, resp.Header, raw)
		return resp.StatusCode, raw
	}
	return token + "\n" + h.URL, call
}

func TestRPCListWorkspaceAndPathBindings(t *testing.T) {
	s, store, ws := newChatCreateTestServer(t)
	root, err := filepath.EvalSymlinks(s.cfg.Root)
	if err != nil {
		t.Fatal(err)
	}
	s.cfg.Root = root
	caller := &rpcSnapshotCaller{}
	for _, id := range []string{"unbound", "native", "adopted", "legacy", "inplace", "original"} {
		caller.sessions = append(caller.sessions, rpcwatch.Session{SessionID: id, Cwd: ws.Path + "/", SessionPath: filepath.Join(ws.Path, id+".jsonl"), DurableSessionID: "durable-" + id})
	}
	newPath := filepath.Join(root, "new")
	if err := os.Mkdir(newPath, 0700); err != nil {
		t.Fatal(err)
	}
	caller.sessions = append(caller.sessions, rpcwatch.Session{SessionID: "unmatched", Cwd: newPath, SessionPath: "/elsewhere.jsonl"})
	for _, binding := range []struct{ id, provenance string }{
		{"native", cursorstore.SessionProvenanceNative}, {"adopted", cursorstore.SessionProvenanceAdopted},
		{"legacy", ""}, {"inplace", cursorstore.SessionProvenanceInPlace},
	} {
		if err := store.SaveChat(cursorstore.Chat{ID: "chat-" + binding.id, WorkspaceID: ws.ID, CWD: ws.Path, SessionFile: filepath.Join(ws.Path, binding.id+".jsonl"), SessionProvenance: binding.provenance}); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.SaveChat(cursorstore.Chat{ID: "chat-copy", WorkspaceID: ws.ID, CWD: ws.Path, SessionFile: filepath.Join(t.TempDir(), "copy.jsonl"), DurableSessionID: "durable-original", SessionProvenance: cursorstore.SessionProvenanceAdopted}); err != nil {
		t.Fatal(err)
	}
	s.rpcWatcher = rpcwatch.New(caller)
	s.rpcWatcher.Tick(t.Context())
	_, call := rpcHTTP(t, s)
	code, raw := call("GET", "/api/rpc-sessions", "")
	var result struct {
		Sessions []struct {
			rpcwatch.Session
			WorkspaceID string `json:"workspaceId"`
			ChatID      string `json:"chatId"`
		} `json:"sessions"`
	}
	if code != 200 || json.Unmarshal(raw, &result) != nil || len(result.Sessions) != 3 {
		t.Fatalf("list = %d %s", code, raw)
	}
	found := map[string]string{}
	for _, row := range result.Sessions {
		if row.WorkspaceID != ws.ID {
			t.Fatalf("workspace = %q", row.WorkspaceID)
		}
		found[row.SessionID] = row.ChatID
	}
	if _, ok := found["original"]; !ok {
		t.Fatal("adopted copy hid original")
	}
	if _, ok := found["unbound"]; !ok || found["inplace"] != "chat-inplace" {
		t.Fatalf("bindings = %v", found)
	}
	// Snapshot predates workspace creation: matching must happen per request.
	createBody, err := json.Marshal(map[string]string{"name": "new", "path": newPath})
	if err != nil {
		t.Fatal(err)
	}
	code, raw = call("POST", "/api/workspaces", string(createBody))
	var newWS struct {
		ID string `json:"id"`
	}
	if code != 201 || json.Unmarshal(raw, &newWS) != nil || newWS.ID == "" {
		t.Fatalf("create workspace = %d %s", code, raw)
	}
	code, raw = call("GET", "/api/rpc-sessions", "")
	if code != 200 || json.Unmarshal(raw, &result) != nil || len(result.Sessions) != 4 {
		t.Fatalf("new workspace = %d %s", code, raw)
	}
	for _, row := range result.Sessions {
		if row.SessionID == "unmatched" && row.WorkspaceID != newWS.ID {
			t.Fatalf("new workspace row = %+v", row)
		}
	}
}

func TestRPCDisabledList(t *testing.T) {
	s, _, _ := newChatCreateTestServer(t)
	_, call := rpcHTTP(t, s)
	code, raw := call("GET", "/api/rpc-sessions", "")
	if code != 200 || strings.TrimSpace(string(raw)) != `{"sessions":[]}` {
		t.Fatalf("disabled = %d %s", code, raw)
	}
}

func TestRPCSymlinkPaths(t *testing.T) {
	for _, workspaceSymlink := range []bool{false, true} {
		spelling := map[bool]string{false: "session-symlink", true: "workspace-symlink"}[workspaceSymlink]
		for _, binding := range []string{"unbound", "inplace", "native"} {
			t.Run(spelling+"/"+binding, func(t *testing.T) {
				s, store, ws := newChatCreateTestServer(t)
				dir := t.TempDir()
				realPath := filepath.Join(dir, "real")
				linkPath := filepath.Join(dir, "link")
				if err := os.Mkdir(realPath, 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(realPath, linkPath); err != nil {
					t.Fatal(err)
				}
				realPath, err := filepath.EvalSymlinks(realPath)
				if err != nil {
					t.Fatal(err)
				}
				ws.Path = realPath
				cwd := linkPath
				if workspaceSymlink {
					ws.Path, cwd = linkPath, realPath
				}
				if err := store.SaveWorkspace(ws); err != nil {
					t.Fatal(err)
				}
				// An unpersisted live session exercises the Clean fallback.
				source := filepath.Join(ws.Path, "missing.jsonl")
				if binding != "unbound" {
					source = writeAdoptableDiskSession(t, ws.Path, ws.Path, "durable-symlink", "Symlink session")
					provenance := cursorstore.SessionProvenanceInPlace
					if binding == "native" {
						provenance = cursorstore.SessionProvenanceNative
					}
					if err := store.SaveChat(cursorstore.Chat{
						ID: "chat-bound", WorkspaceID: ws.ID, CWD: ws.Path,
						SessionFile: source, SessionProvenance: provenance,
					}); err != nil {
						t.Fatal(err)
					}
				}
				relativeSource, err := filepath.Rel(ws.Path, source)
				if err != nil {
					t.Fatal(err)
				}
				caller := &rpcSnapshotCaller{sessions: []rpcwatch.Session{{
					SessionID: "symlink", Cwd: cwd,
					SessionPath: filepath.Join(cwd, relativeSource), DurableSessionID: "durable-symlink",
				}}}
				s.rpcWatcher = rpcwatch.New(caller)
				s.rpcWatcher.Tick(t.Context())
				_, call := rpcHTTP(t, s)
				code, raw := call("GET", "/api/rpc-sessions", "")
				var result struct {
					Sessions []rpcSessionResponse `json:"sessions"`
				}
				if code != http.StatusOK || json.Unmarshal(raw, &result) != nil {
					t.Fatalf("list = %d %s", code, raw)
				}
				if binding == "native" {
					if len(result.Sessions) != 0 {
						t.Errorf("native binding listed = %s", raw)
					}
				} else if len(result.Sessions) != 1 || result.Sessions[0].SessionID != "symlink" || result.Sessions[0].WorkspaceID != ws.ID {
					t.Errorf("symlink session not listed under workspace = %s", raw)
				} else if binding == "inplace" && result.Sessions[0].ChatID != "chat-bound" {
					t.Errorf("in-place binding not reused = %s", raw)
				}
				wantID := "chat-bound"
				for attempt := 0; attempt < 2; attempt++ {
					code, raw = call("POST", "/api/workspaces/"+ws.ID+"/rpc-sessions/open", `{"sessionId":"symlink"}`)
					wantCode := http.StatusOK
					if binding == "unbound" && attempt == 0 {
						wantCode = http.StatusCreated
					}
					var chat chatResponse
					if code != wantCode || json.Unmarshal(raw, &chat) != nil {
						t.Fatalf("open = %d %s, want %d", code, raw, wantCode)
					}
					if binding == "unbound" && attempt == 0 {
						wantID = chat.ID
					}
					if chat.ID == "" || chat.ID != wantID {
						t.Fatalf("open changed chat identity = %+v, want %q", chat, wantID)
					}
				}
				t.Cleanup(func() {
					t.Log("cleanup: HTTP server closed and temporary workspace, symlink and store removed by t.Cleanup")
				})
			})
		}
	}
}

func TestRPCOpenRejectsInvalidRows(t *testing.T) {
	s, _, ws := newChatCreateTestServer(t)
	caller := &rpcSnapshotCaller{sessions: []rpcwatch.Session{{SessionID: "closed", Cwd: ws.Path, SessionPath: "/closed.jsonl"}, {SessionID: "wrong", Cwd: t.TempDir(), SessionPath: "/wrong.jsonl"}}}
	s.rpcWatcher = rpcwatch.New(caller)
	s.rpcWatcher.Tick(t.Context())
	caller.sessions = caller.sessions[1:]
	s.rpcWatcher.Tick(t.Context())
	_, call := rpcHTTP(t, s)
	for _, tc := range []struct {
		body string
		code int
	}{
		{`{"sessionId":"absent"}`, 404}, {`{"sessionId":"closed"}`, 404},
		{`{"sessionId":"wrong"}`, 400}, {`{`, 400}, {`{}`, 400},
	} {
		code, raw := call("POST", "/api/workspaces/"+ws.ID+"/rpc-sessions/open", tc.body)
		if code != tc.code {
			t.Fatalf("body %s = %d %s, want %d", tc.body, code, raw, tc.code)
		}
	}
}

func TestRPCOpenForcedSameRoute(t *testing.T) {
	for _, missing := range []bool{false, true} {
		t.Run(map[bool]string{false: "writer", true: "not-persisted"}[missing], func(t *testing.T) {
			s, store, ws := newChatCreateTestServer(t)
			dir, err := os.MkdirTemp("", "rpc-api-")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if err := os.RemoveAll(dir); err != nil {
					t.Error(err)
				}
			})
			d := omorpctest.New(dir)
			d.SetSharedAttachments(true)
			if err := d.Start(); err != nil {
				t.Fatal(err)
			}
			client, err := omorpc.Dial(t.Context(), d.SocketPath())
			if err != nil {
				t.Fatal(err)
			}
			external, err := omorpc.Dial(t.Context(), d.SocketPath())
			if err != nil {
				t.Fatal(err)
			}
			agentDir := t.TempDir()
			source := writeAdoptableDiskSession(t, agentDir, ws.Path, "durable-rpc", "Disk name")
			if err := d.LoadSessionFile(source); err != nil {
				t.Fatal(err)
			}
			opened, err := external.Call(t.Context(), omorpc.OpenSession{CWD: ws.Path, SessionPath: source})
			if err != nil || opened.Err() != nil {
				t.Fatalf("external open: %v %+v", err, opened)
			}
			var live struct {
				SessionID string `json:"sessionId"`
			}
			if err := json.Unmarshal(opened.Data, &live); err != nil {
				t.Fatal(err)
			}
			if missing {
				if err := os.Remove(source); err != nil {
					t.Fatal(err)
				}
			}
			manager := session.NewManager(session.Config{Client: client, Store: (*wsbridge.CursorStore)(store.Store)})
			bridge := wsbridge.New(wsbridge.Config{Context: t.Context(), Manager: manager, Store: store.Store, Logger: s.logger,
				PrepareChatVersion: s.prepareChatVersion, ChatVersion: s.chatLifecycleVersion})
			s.manager, s.bridge = manager, bridge
			s.rpcWatcher = rpcwatch.New(client)
			s.rpcWatcher.Tick(t.Context())
			s.activityCheck = func(context.Context, string, time.Duration) (sessionActivity, error) {
				return sessionActivity{SizeDelta: 1}, nil
			}
			t.Cleanup(func() {
				bridge.CloseConnections()
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				if err := manager.CloseAll(ctx); err != nil {
					t.Error(err)
				}
				_ = external.Close()
				_ = client.Close()
				d.Stop()
				t.Log("cleanup: HTTP server, bridge sockets, manager, clients and Unix daemon stopped; temp directories removed")
			})
			address, call := rpcHTTP(t, s)
			parts := strings.SplitN(address, "\n", 2)
			var chat chatResponse
			for attempt := 0; attempt < 2; attempt++ {
				code, raw := call("POST", "/api/workspaces/"+ws.ID+"/rpc-sessions/open", `{"sessionId":"`+live.SessionID+`"}`)
				want := 201
				if attempt > 0 {
					want = 200
				}
				if code != want || json.Unmarshal(raw, &chat) != nil {
					t.Fatalf("open = %d %s, want %d", code, raw, want)
				}
				stored, err := store.GetChat(chat.ID)
				if err != nil || !cursorstore.IsInPlaceSession(stored) || stored.SessionFile != source || stored.Name != "Disk name" {
					t.Fatalf("identity = %+v err=%v", stored, err)
				}
				if !missing {
					f, err := os.OpenFile(source, os.O_APPEND|os.O_WRONLY, 0600)
					if err != nil {
						t.Fatal(err)
					}
					_, writeErr := f.WriteString("\n")
					closeErr := f.Close()
					if writeErr != nil || closeErr != nil {
						t.Fatal(errors.Join(writeErr, closeErr))
					}
				}
				collector := &activityE2ECollector{notify: make(chan struct{}, 32)}
				conn, _, err := gws.NewClient(collector, &gws.ClientOption{Addr: "ws" + strings.TrimPrefix(parts[1], "http") + "/api/v2/ws", RequestHeader: http.Header{"Cookie": {auth.CookieName + "=" + parts[0]}}})
				if err != nil {
					t.Fatal(err)
				}
				go conn.ReadLoop()
				collector.next(t, "hello")
				writeActivityE2EFrame(t, conn, map[string]any{"type": "hello", "version": 4})
				writeActivityE2EFrame(t, conn, map[string]any{"type": "chat.create", "wsId": ws.ID, "chatId": chat.ID})
				collector.next(t, "ready")
				collector.next(t, "entries")
				if missing && attempt == 0 {
					prompts := d.RequestCount(omorpc.CmdPrompt)
					writeActivityE2EFrame(t, conn, map[string]any{
						"type": "chat.send", "sessionId": chat.ID,
						"run": map[string]any{"kind": "prompt", "message": "first unpersisted prompt"},
					})
					if !d.AwaitRequestCount(omorpc.CmdPrompt, prompts+1, 5*time.Second) {
						collector.mu.Lock()
						frames := append([]map[string]any(nil), collector.frames...)
						collector.mu.Unlock()
						t.Fatalf("first prompt did not reach daemon: %v", frames)
					}
					prompt := d.LastRequest(omorpc.CmdPrompt)
					if prompt["sessionId"] != "rpc-1" || prompt["sessionId"] != live.SessionID || prompt["message"] != "first unpersisted prompt" {
						t.Fatalf("first prompt route = %v, want rpc-1 with original message", prompt)
					}
					t.Logf("chat.send => daemon prompt route=%s message=%s", prompt["sessionId"], prompt["message"])
				}
				writeActivityE2EFrame(t, conn, map[string]any{"type": "ping"})
				collector.next(t, "pong")
				collector.mu.Lock()
				for _, frame := range collector.frames {
					if frame["type"] == "error" {
						t.Errorf("attachment emitted error: %v", frame)
					}
				}
				collector.mu.Unlock()
				request := d.LastRequest(omorpc.CmdOpenSession)
				if request["sessionPath"] != source {
					t.Fatalf("open wire = %v", request)
				}
				rows, err := external.Call(t.Context(), omorpc.ListSessions{})
				if err != nil {
					t.Fatal(err)
				}
				var listing struct {
					Sessions []struct {
						SessionID   string `json:"sessionId"`
						Attachments int    `json:"attachments"`
					} `json:"sessions"`
				}
				if err := json.Unmarshal(rows.Data, &listing); err != nil {
					t.Fatal(err)
				}
				if len(listing.Sessions) != 1 || listing.Sessions[0].SessionID != live.SessionID || listing.Sessions[0].Attachments != 2 {
					t.Fatalf("route forked: %s", rows.Data)
				}
				t.Logf("chat.create => ready, entries, pong; open_session path=%s; shared route=%s attachments=2", source, live.SessionID)
				_ = conn.WriteClose(1000, nil)
				if err := manager.StopContext(t.Context(), chat.ID); err != nil {
					t.Fatal(err)
				}
			}
			// Consumed force must not make an ordinary reopen permissive.
			_, err = (*wsbridge.CursorStore)(store.Store).CursorForOpen(t.Context(), chat.ID)
			if !errors.As(err, new(*wsbridge.SessionActiveError)) {
				t.Fatalf("nonforced gate = %v", err)
			}
			if missing {
				if _, err := os.Stat(source); !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("missing file unexpectedly created: %v", err)
				}
				s.activityCheck = func(context.Context, string, time.Duration) (sessionActivity, error) {
					return sessionActivity{}, nil
				}
				s.authorizeInPlaceOpen(chat.ID, false)
				_, err := (*wsbridge.CursorStore)(store.Store).CursorForOpen(t.Context(), chat.ID)
				if !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("nonforced missing source = %v", err)
				}
			}
		})
	}
}
