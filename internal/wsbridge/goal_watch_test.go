package wsbridge

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
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
	"github.com/DevNewbie1826/omo-webchat/internal/session"
	"github.com/DevNewbie1826/omo-webchat/internal/wscontract"
)

// TestGoalWatchPushesOnChange drives a bound socket against a goal document
// that appears, updates, and disappears while attached. The bind snapshot is
// explicit even when absent, and every later transition is pushed.
func TestGoalWatchPushesOnChange(t *testing.T) {
	dir, err := os.MkdirTemp("", "wsbridge-goal-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	agentDir := t.TempDir()
	t.Setenv("OMO_CODING_AGENT_DIR", agentDir)
	d := omorpctest.New(dir)
	if err := d.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(d.Stop)
	client, err := omorpc.Dial(t.Context(), d.SocketPath())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	store, err := cursorstore.Open(filepath.Join(dir, "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SaveWorkspace(cursorstore.Workspace{ID: "ws-goal", Name: "work", Path: dir}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveChat(cursorstore.Chat{ID: "chat-goal", WorkspaceID: "ws-goal", CWD: dir, Name: "goal"}); err != nil {
		t.Fatal(err)
	}
	mgr := session.NewManager(session.Config{Client: client, Store: (*CursorStore)(store)})
	t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	sessions := auth.NewSessionStore(t.Context(), "pw", logger)
	token, err := sessions.Create(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	handler := sessions.Middleware(New(Config{Manager: mgr, Store: store, ServerVersion: client.ServerVersion(), Logger: logger}))
	ts := httptest.NewServer(handler)
	t.Cleanup(ts.Close)

	c := &collector{notify: make(chan struct{}, 256)}
	conn, _, err := gws.NewClient(c, &gws.ClientOption{
		Addr:          "ws" + strings.TrimPrefix(ts.URL, "http"),
		RequestHeader: map[string][]string{"Cookie": {auth.CookieName + "=" + token}},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.WriteClose(1000, nil) })
	go conn.ReadLoop()
	c.next(t, "hello")
	writeClient(t, conn, map[string]any{"type": "hello", "version": 2})
	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-goal", "chatId": "chat-goal"})
	c.next(t, "ready")
	initial := c.nextWithin(t, "chat.goal", 5*time.Second)
	if goal, exists := initial["goal"]; !exists || goal != nil {
		t.Fatalf("bind-time frame = %v, want explicit goal:null", initial)
	}

	chat, err := store.GetChat("chat-goal")
	if err != nil || chat.DurableSessionID == "" {
		t.Fatalf("durable identity missing after open: %+v, %v", chat, err)
	}
	goalPath, ok := session.GoalStatePath(agentDir, dir, chat.DurableSessionID)
	if !ok {
		t.Fatal("goal path rejected")
	}
	if err := os.MkdirAll(filepath.Dir(goalPath), 0o700); err != nil {
		t.Fatal(err)
	}
	writeGoal := func(objective, status string) {
		t.Helper()
		body := `{"version":1,"goal":{"threadId":"` + chat.DurableSessionID + `","objective":"` + objective + `","status":"` + status + `","createdAt":100,"updatedAt":200}}`
		if err := os.WriteFile(goalPath, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		future := time.Now().Add(time.Second)
		if err := os.Chtimes(goalPath, future, future); err != nil {
			t.Fatal(err)
		}
	}
	awaitGoal := func(t *testing.T) map[string]any {
		t.Helper()
		frame := c.nextWithin(t, "chat.goal", 5*time.Second)
		goal, ok := frame["goal"].(map[string]any)
		if !ok {
			t.Fatalf("chat.goal frame without goal object: %v", frame)
		}
		return goal
	}

	// Appear: the watcher reports the goal set on the CLI side.
	writeGoal("골 상태 실시간 웹 표시", "active")
	if goal := awaitGoal(t); goal["objective"] != "골 상태 실시간 웹 표시" || goal["status"] != "active" {
		t.Fatalf("appear goal = %v", goal)
	}

	// Update: a new objective is pushed without rebinding.
	writeGoal("updated objective", "blocked")
	update := awaitGoal(t)
	if update["objective"] != "updated objective" || update["status"] != "blocked" {
		t.Fatalf("update goal = %v", update)
	}
	if reason, ok := update["blockedReason"]; ok {
		t.Fatalf("unexpected blockedReason on update goal: %v", reason)
	}

	// Disappear: the watcher clears the banner with an explicit null.
	if err := os.Remove(goalPath); err != nil {
		t.Fatal(err)
	}
	frame := c.nextWithin(t, "chat.goal", 5*time.Second)
	if goal, exists := frame["goal"]; !exists || goal != nil {
		t.Fatalf("disappearance frame = %v", frame)
	}
}

func TestGoalWatchStateRetriesTransientReadAndDetectsPostBindDeletion(t *testing.T) {
	path := filepath.Join(t.TempDir(), "goal.json")
	if err := os.WriteFile(path, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	initialInfo, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	old := &session.GoalState{Objective: "old", Status: "active"}
	var state goalWatchState
	if !state.accept(old, initialInfo) {
		t.Fatal("bind-time goal was not selected for push")
	}

	if err := os.WriteFile(path, []byte("changed"), 0o600); err != nil {
		t.Fatal(err)
	}
	changedInfo, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	changedStamp, _ := goalStampFromInfo(changedInfo)
	if !state.needsRead(changedStamp, true) {
		t.Fatal("changed goal did not request a read")
	}
	// A transient read error does not call accept, so the same observed stamp
	// must remain pending on every subsequent watch pass.
	transientReads := 0
	transient := func() (*session.GoalState, os.FileInfo, error) {
		transientReads++
		return nil, nil, errGoalStampTransient
	}
	for range 2 {
		if _, push := state.refresh(transient); push {
			t.Fatal("transient read selected a null push")
		}
		if !state.needsRead(changedStamp, true) || !session.EqualGoalState(state.last, old) {
			t.Fatal("transient read acknowledged the stamp or cleared the last goal")
		}
	}
	if transientReads != 2 {
		t.Fatalf("transient read attempts = %d, want 2", transientReads)
	}

	// Deletion before any stamp pass after bind is visible because accept
	// seeded both existence and identity from the bind-time stable read.
	if !state.needsRead(goalFileStamp{}, false) {
		t.Fatal("post-bind deletion was not detected")
	}
	if !state.accept(nil, nil) || state.last != nil || state.hadStamp {
		t.Fatal("post-bind deletion did not select an explicit null push")
	}
}

func TestGoalWatchStampDetectsEqualSizeMtimeReplacement(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "goal.json")
	fixed := time.Unix(1_700_000_000, 1234)
	write := func(path, body string) os.FileInfo {
		t.Helper()
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(path, fixed, fixed); err != nil {
			t.Fatal(err)
		}
		info, err := os.Lstat(path)
		if err != nil {
			t.Fatal(err)
		}
		return info
	}
	oldInfo := write(path, "old")
	var state goalWatchState
	state.accept(&session.GoalState{Objective: "old", Status: "active"}, oldInfo)

	replacement := filepath.Join(dir, "replacement.json")
	write(replacement, "new")
	if err := os.Rename(replacement, path); err != nil {
		t.Fatal(err)
	}
	newInfo, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	oldStamp, _ := goalStampFromInfo(oldInfo)
	newStamp, _ := goalStampFromInfo(newInfo)
	if oldStamp.size != newStamp.size || oldStamp.mod != newStamp.mod {
		t.Fatalf("fixture stamps differ by size/mtime: old=%+v new=%+v", oldStamp, newStamp)
	}
	if oldStamp.device == newStamp.device && oldStamp.inode == newStamp.inode {
		t.Fatal("fixture replacement reused file identity")
	}
	if !state.needsRead(newStamp, true) {
		t.Fatal("inode replacement was invisible to watcher")
	}
	if !state.accept(&session.GoalState{Objective: "new", Status: "active"}, newInfo) {
		t.Fatal("inode replacement did not select changed goal for push")
	}
}

func TestGoalWatchFrameSurvivesContractRoundTrip(t *testing.T) {
	// The generated parser must accept exactly what goalToWire emits,
	// including the explicit null goal of a cleared banner.
	goal := goalToWire(&session.GoalState{
		Objective: "obj", Status: "blocked", BlockedReason: "why",
		CreatedAt: ptrInt64(1), UpdatedAt: ptrInt64(2), CompletedAt: ptrInt64(3),
	})
	for _, frame := range []wscontract.ChatGoalFrame{
		{Type: "chat.goal", SessionID: "chat-goal", Goal: goal},
		{Type: "chat.goal", SessionID: "chat-goal"},
	} {
		raw, err := json.Marshal(frame)
		if err != nil {
			t.Fatal(err)
		}
		parsed, err := wscontract.ParseServerFrame(raw)
		if err != nil {
			t.Fatalf("parser rejected %s: %v", raw, err)
		}
		got, ok := parsed.(*wscontract.ChatGoalFrame)
		if !ok || got.SessionID != "chat-goal" {
			t.Fatalf("round trip = %#v (sent %s)", parsed, raw)
		}
		if (got.Goal == nil) != (frame.Goal == nil) {
			t.Fatalf("goal nil-ness changed: sent %s", raw)
		}
		if got.Goal != nil {
			sent, err := json.Marshal(frame.Goal)
			if err != nil {
				t.Fatal(err)
			}
			back, err := json.Marshal(got.Goal)
			if err != nil {
				t.Fatal(err)
			}
			if string(sent) != string(back) {
				t.Fatalf("goal content changed: sent %s got %s", sent, back)
			}
		}
	}
}

func ptrInt64(v int64) *int64 { return &v }
