package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/auth"
	"github.com/DevNewbie1826/omo-webchat/internal/chat"
	"github.com/DevNewbie1826/omo-webchat/internal/config"
	"github.com/DevNewbie1826/omo-webchat/internal/store"
)

func TestHandlerListsLiveSessionsWhenAuthenticated(t *testing.T) {
	// Given
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	sessions := auth.NewSessionStore(t.Context(), "pw", logger)
	server := New(t.Context(), &config.Config{}, nil, sessions, logger)
	t.Cleanup(server.chats.CloseAll)
	handler := server.Handler()

	// Then
	unauthorized := httptest.NewRecorder()
	handler.ServeHTTP(unauthorized, httptest.NewRequest(http.MethodGet, "/api/sessions/live", nil))
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status = %d, want %d", unauthorized.Code, http.StatusUnauthorized)
	}

	if _, err := exec.LookPath("node"); err != nil {
		t.Skipf("node not in PATH: %v", err)
	}
	// The multi-session mock tolerates the --multi-session launch flag the
	// shared provider appends and answers open_session, so both sessions run
	// live on one shared provider process.
	if _, started, err := server.chats.Acquire(t.Context(), chat.SessionOptions{ID: "chat-live", Binary: "node", Args: []string{mockPiPath(t)}, Env: os.Environ(), ProviderContext: context.Background()}); err != nil {
		t.Fatalf("acquire live session: %v", err)
	} else if !started {
		t.Fatal("first acquire did not start a live session")
	}
	if _, started, err := server.chats.Acquire(t.Context(), chat.SessionOptions{ID: "chat-live-2", Binary: "node", Args: []string{mockPiPath(t)}, Env: os.Environ(), ProviderContext: context.Background()}); err != nil {
		t.Fatalf("acquire second live session: %v", err)
	} else if !started {
		t.Fatal("second acquire did not start a live session")
	}
	token, err := sessions.Create(t.Context())
	if err != nil {
		t.Fatalf("creating auth session: %v", err)
	}

	// When
	recorder := getLiveSessions(t, handler, token)

	// Then: enriched rows, ids sorted, title present, task/dag null before events.
	if got, want := recorder.Body.String(), "{\"sessions\":[{\"id\":\"chat-live\",\"title\":\"\",\"task\":null,\"dag\":null,\"task_oversized\":false,\"dag_oversized\":false},{\"id\":\"chat-live-2\",\"title\":\"\",\"task\":null,\"dag\":null,\"task_oversized\":false,\"dag_oversized\":false}]}\n"; got != want {
		t.Fatalf("body = %q, want %q", got, want)
	}
	assertLiveSessionShape(t, recorder.Body.Bytes(), []expectedLiveSession{
		{id: "chat-live", titlePresent: true, task: nil, dag: nil},
		{id: "chat-live-2", titlePresent: true, task: nil, dag: nil},
	})

	// Ending one chat session must drop exactly that session from the live
	// list while the sibling on the shared provider process stays live.
	server.chats.Stop("chat-live")
	recorder = getLiveSessions(t, handler, token)
	if got, want := recorder.Body.String(), "{\"sessions\":[{\"id\":\"chat-live-2\",\"title\":\"\",\"task\":null,\"dag\":null,\"task_oversized\":false,\"dag_oversized\":false}]}\n"; got != want {
		t.Fatalf("body after stop = %q, want %q", got, want)
	}
}

func TestHandlerListsLiveSessionsIncludesActivitySnapshots(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skipf("node not in PATH: %v", err)
	}
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	t.Setenv("MOCK_PI_EXT_EVENT", "1")

	ctx := t.Context()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	st, err := store.Load(ctx, logger)
	if err != nil {
		t.Fatalf("load store: %v", err)
	}
	ws, err := st.CreateWorkspace("live-snap", tmp)
	if err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	record, err := st.NewChat(ws.ID, "live-activity-qa", ws.Path, "", "omo")
	if err != nil {
		t.Fatalf("create chat: %v", err)
	}
	sessions := auth.NewSessionStore(ctx, "pw", logger)
	server := New(ctx, &config.Config{Root: tmp}, st, sessions, logger)
	t.Cleanup(server.chats.CloseAll)
	handler := server.Handler()

	frames := newLiveFrameCollector()
	sess, started, detach, err := server.chats.AcquireAttach(ctx, chat.SessionOptions{
		ID: record.ID, Binary: "node", Args: []string{mockPiPath(t)}, Env: os.Environ(),
		ProviderContext: context.Background(),
	}, frames)
	if err != nil {
		t.Fatalf("acquire live session: %v", err)
	}
	if !started {
		t.Fatal("acquire did not start a live session")
	}
	t.Cleanup(detach)

	token, err := sessions.Create(ctx)
	if err != nil {
		t.Fatalf("creating auth session: %v", err)
	}

	// Given: a live session that has not yet received extension events.
	before := getLiveSessions(t, handler, token)
	assertLiveSessionShape(t, before.Body.Bytes(), []expectedLiveSession{
		{id: record.ID, title: "live-activity-qa", titlePresent: true, task: nil, dag: nil},
	})

	// When: the mock fixture emits omo.task.updated + omo.dag.updated.
	if err := sess.SendPrompt("hello", nil); err != nil {
		t.Fatalf("send prompt: %v", err)
	}
	frames.waitForType(t, "run.done", 5*time.Second)

	// Then: the same row carries the raw cached payloads unparsed.
	after := getLiveSessions(t, handler, token)
	assertLiveSessionShape(t, after.Body.Bytes(), []expectedLiveSession{
		{id: record.ID, title: "live-activity-qa", titlePresent: true, task: json.RawMessage(liveTaskData), dag: json.RawMessage(liveDagData)},
	})
}

func TestLiveSessionFromSummaryJSONReportsOversizedFlags(t *testing.T) {
	cachedTask := json.RawMessage(`{"task":{"id":"st_cached"}}`)
	cachedDag := json.RawMessage(`{"dag":{"nodes":[{"id":"st_cached"}]}}`)
	smallTask := json.RawMessage(`{"task":{"id":"st_small"}}`)
	smallDag := json.RawMessage(`{"dag":{"nodes":[{"id":"st_small"}]}}`)
	tests := []struct {
		name         string
		summary      chat.LiveSummary
		wantTaskOver bool
		wantDagOver  bool
		wantTask     json.RawMessage
		wantDag      json.RawMessage
	}{
		{
			name: "oversized task leaves cached task and sets task_oversized",
			summary: chat.LiveSummary{
				ID:            "chat-over",
				Pair:          chat.ActivitySnapshotPair{Task: cachedTask},
				TaskOversized: true,
			},
			wantTaskOver: true,
			wantTask:     cachedTask,
		},
		{
			name: "in-cap task clears task_oversized",
			summary: chat.LiveSummary{
				ID:   "chat-over",
				Pair: chat.ActivitySnapshotPair{Task: smallTask},
			},
			wantTask: smallTask,
		},
		{
			name: "oversized dag leaves cached dag and sets dag_oversized",
			summary: chat.LiveSummary{
				ID:           "chat-over",
				Pair:         chat.ActivitySnapshotPair{Dag: cachedDag},
				DagOversized: true,
			},
			wantDagOver: true,
			wantDag:     cachedDag,
		},
		{
			name: "in-cap dag clears dag_oversized",
			summary: chat.LiveSummary{
				ID:   "chat-over",
				Pair: chat.ActivitySnapshotPair{Dag: smallDag},
			},
			wantDag: smallDag,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Given / When: the live-sessions mapper serializes a summary.
			row := liveSessionFromSummary(tt.summary, "Over")
			raw, err := json.Marshal(row)
			if err != nil {
				t.Fatalf("marshal live session: %v", err)
			}

			// Then: JSON field names match the live-sessions response and flags copy through.
			var parsed map[string]any
			if err := json.Unmarshal(raw, &parsed); err != nil {
				t.Fatalf("decode live session: %v (%s)", err, raw)
			}
			if parsed["task_oversized"] != tt.wantTaskOver {
				t.Fatalf("task_oversized = %#v, want %v (%s)", parsed["task_oversized"], tt.wantTaskOver, raw)
			}
			if parsed["dag_oversized"] != tt.wantDagOver {
				t.Fatalf("dag_oversized = %#v, want %v (%s)", parsed["dag_oversized"], tt.wantDagOver, raw)
			}
			assertOptionalRaw(t, parsed, "task", tt.wantTask, 0)
			assertOptionalRaw(t, parsed, "dag", tt.wantDag, 0)
			if row.Title != "Over" {
				t.Fatalf("title = %q, want Over", row.Title)
			}
		})
	}
}

func TestLiveSessionFromSummaryJSONSerializesEmptyDigestArrays(t *testing.T) {
	row := liveSessionFromSummary(chat.LiveSummary{
		ID:         "chat-empty-digest",
		TaskDigest: &chat.ActivityTaskDigest{},
		DagDigest: &chat.ActivityDagDigest{Runs: []chat.RunDigestEntry{{
			RunID: "r1", Status: "running",
		}}},
	}, "Empty digest")
	raw, err := json.Marshal(row)
	if err != nil {
		t.Fatalf("marshal live session: %v", err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatalf("decode live session: %v (%s)", err, raw)
	}
	taskDigest := parsed["task_digest"].(map[string]any)
	if tasks, ok := taskDigest["tasks"].([]any); !ok || len(tasks) != 0 {
		t.Fatalf("task_digest.tasks = %#v, want [] (%s)", taskDigest["tasks"], raw)
	}
	dagDigest := parsed["dag_digest"].(map[string]any)
	runs := dagDigest["runs"].([]any)
	run := runs[0].(map[string]any)
	if ids, ok := run["running_task_ids"].([]any); !ok || len(ids) != 0 {
		t.Fatalf("running_task_ids = %#v, want [] (%s)", run["running_task_ids"], raw)
	}
}

func TestLiveSessionFromSummaryJSONReportsActivityDigests(t *testing.T) {
	tests := []struct {
		name           string
		summary        chat.LiveSummary
		wantTaskDigest bool
		wantDagDigest  bool
	}{
		{
			name:    "nil digests are omitted",
			summary: chat.LiveSummary{ID: "chat-digest-empty"},
		},
		{
			name: "populated digests use wire field names",
			summary: chat.LiveSummary{
				ID: "chat-digest",
				TaskDigest: &chat.ActivityTaskDigest{
					Tasks: []chat.TaskDigestEntry{
						{TaskID: "t1", Status: "running", UpdatedAt: "2026-01-01T00:00:00Z"},
						{TaskID: "t2", Status: "completed"},
					},
				},
				DagDigest: &chat.ActivityDagDigest{
					Runs: []chat.RunDigestEntry{
						{RunID: "r1", Status: "running", RunningTaskIDs: []string{"t1"}},
					},
				},
			},
			wantTaskDigest: true,
			wantDagDigest:  true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Given / When: the live-sessions mapper serializes a summary.
			row := liveSessionFromSummary(tt.summary, "Digest")
			raw, err := json.Marshal(row)
			if err != nil {
				t.Fatalf("marshal live session: %v", err)
			}

			// Then: task_digest/dag_digest use the wire names and are absent when nil.
			var parsed map[string]any
			if err := json.Unmarshal(raw, &parsed); err != nil {
				t.Fatalf("decode live session: %v (%s)", err, raw)
			}
			taskDigest, hasTaskDigest := parsed["task_digest"]
			dagDigest, hasDagDigest := parsed["dag_digest"]
			if hasTaskDigest != tt.wantTaskDigest {
				t.Fatalf("task_digest present = %v, want %v (%s)", hasTaskDigest, tt.wantTaskDigest, raw)
			}
			if hasDagDigest != tt.wantDagDigest {
				t.Fatalf("dag_digest present = %v, want %v (%s)", hasDagDigest, tt.wantDagDigest, raw)
			}
			if !tt.wantTaskDigest && !tt.wantDagDigest {
				return
			}
			taskObj, ok := taskDigest.(map[string]any)
			if !ok {
				t.Fatalf("task_digest = %#v, want object", taskDigest)
			}
			if _, ok := taskObj["tasks"]; !ok {
				t.Fatalf("task_digest missing tasks (%s)", raw)
			}
			if _, ok := taskObj["truncated"]; !ok {
				t.Fatalf("task_digest missing truncated (%s)", raw)
			}
			tasks, ok := taskObj["tasks"].([]any)
			if !ok || len(tasks) != 2 {
				t.Fatalf("task_digest.tasks = %#v, want 2 entries", taskObj["tasks"])
			}
			first, ok := tasks[0].(map[string]any)
			if !ok {
				t.Fatalf("task_digest.tasks[0] = %#v, want object", tasks[0])
			}
			if first["task_id"] != "t1" || first["status"] != "running" || first["updated_at"] != "2026-01-01T00:00:00Z" {
				t.Fatalf("task_digest.tasks[0] = %#v, want task_id/status/updated_at", first)
			}
			second, ok := tasks[1].(map[string]any)
			if !ok {
				t.Fatalf("task_digest.tasks[1] = %#v, want object", tasks[1])
			}
			if _, hasUpdatedAt := second["updated_at"]; hasUpdatedAt {
				t.Fatalf("task_digest.tasks[1] has updated_at, want omitted (%s)", raw)
			}
			dagObj, ok := dagDigest.(map[string]any)
			if !ok {
				t.Fatalf("dag_digest = %#v, want object", dagDigest)
			}
			runs, ok := dagObj["runs"].([]any)
			if !ok || len(runs) != 1 {
				t.Fatalf("dag_digest.runs = %#v, want 1 entry", dagObj["runs"])
			}
			run, ok := runs[0].(map[string]any)
			if !ok {
				t.Fatalf("dag_digest.runs[0] = %#v, want object", runs[0])
			}
			if run["run_id"] != "r1" || run["status"] != "running" {
				t.Fatalf("dag_digest.runs[0] = %#v, want run_id/status", run)
			}
			ids, ok := run["running_task_ids"].([]any)
			if !ok || len(ids) != 1 || ids[0] != "t1" {
				t.Fatalf("running_task_ids = %#v, want [t1]", run["running_task_ids"])
			}
			if _, ok := dagObj["truncated"]; !ok {
				t.Fatalf("dag_digest missing truncated (%s)", raw)
			}
		})
	}
}

type expectedLiveSession struct {
	id            string
	title         string
	titlePresent  bool
	task          json.RawMessage
	dag           json.RawMessage
	taskOversized bool
	dagOversized  bool
}

func getLiveSessions(t *testing.T, handler http.Handler, token string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, "/api/sessions/live", nil)
	request.AddCookie(&http.Cookie{Name: auth.CookieName, Value: token})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}
	return recorder
}

func assertLiveSessionShape(t *testing.T, body []byte, want []expectedLiveSession) {
	t.Helper()
	var payload struct {
		Sessions []map[string]any `json:"sessions"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("decode live sessions: %v (%s)", err, body)
	}
	if len(payload.Sessions) != len(want) {
		t.Fatalf("sessions len = %d, want %d (%s)", len(payload.Sessions), len(want), body)
	}
	for i, row := range payload.Sessions {
		expect := want[i]
		if got, ok := row["id"].(string); !ok || got != expect.id {
			t.Fatalf("sessions[%d].id = %#v, want %q", i, row["id"], expect.id)
		}
		title, titleOK := row["title"]
		if expect.titlePresent && !titleOK {
			t.Fatalf("sessions[%d].title missing", i)
		}
		if expect.title != "" {
			if got, ok := title.(string); !ok || got != expect.title {
				t.Fatalf("sessions[%d].title = %#v, want %q", i, title, expect.title)
			}
		}
		assertOptionalRaw(t, row, "task", expect.task, i)
		assertOptionalRaw(t, row, "dag", expect.dag, i)
		assertBoolField(t, row, "task_oversized", expect.taskOversized, i)
		assertBoolField(t, row, "dag_oversized", expect.dagOversized, i)
	}
}

func assertBoolField(t *testing.T, row map[string]any, key string, want bool, index int) {
	t.Helper()
	got, ok := row[key]
	if !ok {
		t.Fatalf("sessions[%d].%s missing", index, key)
	}
	if got != want {
		t.Fatalf("sessions[%d].%s = %#v, want %v", index, key, got, want)
	}
}

func assertOptionalRaw(t *testing.T, row map[string]any, key string, want json.RawMessage, index int) {
	t.Helper()
	got, ok := row[key]
	if !ok {
		t.Fatalf("sessions[%d].%s missing", index, key)
	}
	if len(want) == 0 {
		if got != nil {
			t.Fatalf("sessions[%d].%s = %#v, want null", index, key, got)
		}
		return
	}
	var wantValue any
	if err := json.Unmarshal(want, &wantValue); err != nil {
		t.Fatalf("fixture %s is not valid JSON: %v", key, err)
	}
	if !reflect.DeepEqual(got, wantValue) {
		t.Fatalf("sessions[%d].%s = %#v, want %#v", index, key, got, wantValue)
	}
}

type liveFrameCollector struct {
	mu     sync.Mutex
	frames [][]byte
	notify chan struct{}
}

func newLiveFrameCollector() *liveFrameCollector {
	return &liveFrameCollector{notify: make(chan struct{}, 256)}
}

func (c *liveFrameCollector) WriteJSON(b []byte) error {
	c.mu.Lock()
	c.frames = append(c.frames, append([]byte(nil), b...))
	c.mu.Unlock()
	select {
	case c.notify <- struct{}{}:
	default:
	}
	return nil
}

func (c *liveFrameCollector) snapshot() [][]byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([][]byte, len(c.frames))
	for i, frame := range c.frames {
		out[i] = append([]byte(nil), frame...)
	}
	return out
}

func (c *liveFrameCollector) waitForType(t *testing.T, typ string, timeout time.Duration) {
	t.Helper()
	deadline := time.After(timeout)
	for {
		for _, frame := range c.snapshot() {
			var env struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(frame, &env) == nil && env.Type == typ {
				return
			}
		}
		select {
		case <-c.notify:
		case <-deadline:
			t.Fatalf("timed out waiting for %q; have: %s", typ, liveFrameTypes(c.snapshot()))
		}
	}
}

func liveFrameTypes(frames [][]byte) string {
	var types []string
	for _, frame := range frames {
		var env struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(frame, &env) == nil {
			types = append(types, env.Type)
		}
	}
	raw, _ := json.Marshal(types)
	return string(raw)
}
