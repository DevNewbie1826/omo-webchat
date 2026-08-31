package chat

import (
	"bytes"
	"context"
	"encoding/json"
	"reflect"
	"sync"
	"testing"
	"time"
)

// seedPair is the persisted pair a restored session is seeded from.
var seedPair = ActivitySnapshotPair{
	Task: json.RawMessage(`{"task":{"id":"st_seed_001","name":"seed","title":"Seeded subagent","status":"completed","category":"quick"}}`),
	Dag:  json.RawMessage(`{"dag":{"nodes":[{"id":"st_seed_001","status":"completed"}],"edges":[]}}`),
}

// A session created with a persisted seed must replay it to its first
// attached client — task first, dag second, payloads verbatim — exactly like
// an in-memory snapshot, because a session restored from disk has no live
// activity state until the provider sends real snapshots.
func TestSeedActivitySnapshotsReplayToFirstClient(t *testing.T) {
	opts := managedMockOptions(t, "chat-seed-replay")
	seed := seedPair
	opts.SeedActivity = &seed

	s, err := StartSession(context.Background(), opts)
	if err != nil {
		t.Fatalf("start session: %v", err)
	}
	t.Cleanup(func() {
		if err := s.Close(); err != nil {
			t.Errorf("close session: %v", err)
		}
	})

	w := newCollectWriter()
	s.Attach(w)

	replayed := collectExtEventFrames(t, w.snapshot())
	if names := extEventNames(replayed); !reflect.DeepEqual(names, []string{"omo.task.updated", "omo.dag.updated"}) {
		t.Fatalf("seeded session replayed extensionEvent names = %v, want exactly [omo.task.updated omo.dag.updated]; frames: %s", names, w.typesString())
	}
	for i, want := range []string{string(seedPair.Task), string(seedPair.Dag)} {
		var got, expected any
		if err := json.Unmarshal(replayed[i].Data, &got); err != nil {
			t.Fatalf("replayed frame %d data is not valid JSON: %v (%s)", i, err, replayed[i].Data)
		}
		if err := json.Unmarshal([]byte(want), &expected); err != nil {
			t.Fatalf("fixture data is not valid JSON: %v", err)
		}
		if !reflect.DeepEqual(got, expected) {
			t.Fatalf("replayed frame %d data = %s, want the seeded payload %s", i, replayed[i].Data, want)
		}
	}
	if replayed[0].SessionID != "chat-seed-replay" {
		t.Fatalf("replayed frame sessionId = %q, want chat-seed-replay", replayed[0].SessionID)
	}
}

// A live provider snapshot must supersede the seeded value name-by-name: the
// replayed pair carries the live task payload while the dag payload that the
// provider has not refreshed yet still comes from the seed. Replay order is
// unchanged (task first, dag second).
func TestLiveSnapshotSupersedesSeededSnapshot(t *testing.T) {
	s := newTestSession("chat-seed-supersede", nil)
	s.seedActivitySnapshots(&seedPair)

	liveTask := json.RawMessage(`{"task":{"id":"st_live_001","name":"live","title":"Live subagent","status":"running","category":"quick"}}`)
	dispatchEvent(s, "extension_event", `{"type":"extension_event","name":"omo.task.updated","data":{"task":{"id":"st_live_001","name":"live","title":"Live subagent","status":"running","category":"quick"}}}`)

	late := newCollectWriter()
	s.Attach(late)

	replayed := collectExtEventFrames(t, late.snapshot())
	if names := extEventNames(replayed); !reflect.DeepEqual(names, []string{"omo.task.updated", "omo.dag.updated"}) {
		t.Fatalf("replayed extensionEvent names = %v, want exactly [omo.task.updated omo.dag.updated]; frames: %s", names, late.typesString())
	}
	var gotTask, wantLive any
	if err := json.Unmarshal(replayed[0].Data, &gotTask); err != nil {
		t.Fatalf("replayed task is not valid JSON: %v (%s)", err, replayed[0].Data)
	}
	if err := json.Unmarshal(liveTask, &wantLive); err != nil {
		t.Fatalf("fixture data is not valid JSON: %v", err)
	}
	if !reflect.DeepEqual(gotTask, wantLive) {
		t.Fatalf("replayed task = %s, want the live payload %s (seed must be superseded)", replayed[0].Data, liveTask)
	}
	var gotDag, wantSeed any
	if err := json.Unmarshal(replayed[1].Data, &gotDag); err != nil {
		t.Fatalf("replayed dag is not valid JSON: %v (%s)", err, replayed[1].Data)
	}
	if err := json.Unmarshal(seedPair.Dag, &wantSeed); err != nil {
		t.Fatalf("fixture data is not valid JSON: %v", err)
	}
	if !reflect.DeepEqual(gotDag, wantSeed) {
		t.Fatalf("replayed dag = %s, want the seeded payload %s", replayed[1].Data, seedPair.Dag)
	}
}

// Run completion is the persistence boundary: the replayable pair is handed
// to the callback exactly when a run settles, only when it changed since the
// last handoff, and never from activity arriving outside a settling run.
func TestRunCompletionPersistsActivityPair(t *testing.T) {
	s := newTestSession("chat-seed-persist", nil)
	var calls []ActivitySnapshotPair
	s.onActivitySnapshot = func(source *Session, pair ActivitySnapshotPair) bool {
		if source != s {
			t.Errorf("persist callback source = %v, want the session itself", source)
		}
		calls = append(calls, pair)
		return true
	}

	// Activity during a run is cached but not persisted: the run has not
	// settled, and more snapshots may still arrive.
	dispatchEvent(s, "agent_start", `{"type":"agent_start"}`)
	dispatchEvent(s, "extension_event", `{"type":"extension_event","name":"omo.task.updated","data":{"task":{"id":"st_1","status":"running"}}}`)
	dispatchEvent(s, "extension_event", `{"type":"extension_event","name":"omo.dag.updated","data":{"dag":{"nodes":[{"id":"st_1","status":"running"}],"edges":[]}}}`)
	if len(calls) != 0 {
		t.Fatalf("pair persisted before run completion: %d calls, want 0", len(calls))
	}

	dispatchEvent(s, "agent_settled", `{"type":"agent_settled"}`)
	if len(calls) != 1 {
		t.Fatalf("persist calls after first settled run = %d, want 1", len(calls))
	}
	if got, want := string(calls[0].Task), `{"task":{"id":"st_1","status":"running"}}`; got != want {
		t.Fatalf("persisted task = %s, want %s", got, want)
	}
	if got, want := string(calls[0].Dag), `{"dag":{"nodes":[{"id":"st_1","status":"running"}],"edges":[]}}`; got != want {
		t.Fatalf("persisted dag = %s, want %s", got, want)
	}

	// A second settle with an unchanged pair must not rewrite the store.
	dispatchEvent(s, "agent_start", `{"type":"agent_start"}`)
	dispatchEvent(s, "agent_settled", `{"type":"agent_settled"}`)
	if len(calls) != 1 {
		t.Fatalf("persist calls after unchanged settle = %d, want still 1 (deduplicated)", len(calls))
	}

	// A changed pair persists again.
	dispatchEvent(s, "agent_start", `{"type":"agent_start"}`)
	dispatchEvent(s, "extension_event", `{"type":"extension_event","name":"omo.task.updated","data":{"task":{"id":"st_1","status":"completed"}}}`)
	dispatchEvent(s, "agent_settled", `{"type":"agent_settled"}`)
	if len(calls) != 2 {
		t.Fatalf("persist calls after changed settle = %d, want 2", len(calls))
	}
	if got, want := string(calls[1].Task), `{"task":{"id":"st_1","status":"completed"}}`; got != want {
		t.Fatalf("persisted task = %s, want %s", got, want)
	}
	if got, want := string(calls[1].Dag), `{"dag":{"nodes":[{"id":"st_1","status":"running"}],"edges":[]}}`; got != want {
		t.Fatalf("persisted dag = %s, want the unchanged dag payload %s", got, want)
	}
}

// A task row whose dag node belongs to a TERMINAL dag run must not persist as
// "running": at settle the run-level dag status is authoritative, so the ghost
// row is demoted to "completed". A running row with no dag evidence is left
// untouched — demotion requires the dag to vouch for the task.
func TestSettleDemotesTasksOfTerminalDagRuns(t *testing.T) {
	s := newTestSession("chat-ghost-settle", nil)
	// A task row whose dag node belongs to a TERMINAL dag run must not persist as
	var calls []ActivitySnapshotPair
	s.onActivitySnapshot = func(source *Session, pair ActivitySnapshotPair) bool {
		if source != s {
			t.Errorf("persist callback source = %v, want the session itself", source)
		}
		calls = append(calls, pair)
		return true
	}

	dispatchEvent(s, "agent_start", `{"type":"agent_start"}`)
	dispatchEvent(s, "extension_event", `{"type":"extension_event","name":"omo.task.updated","data":{"parent_session_id":"chat-ghost-settle","truncated_tasks":false,"tasks":[{"task_id":"t1","name":"ghost","task_summary":"ghost","status":"running","category":"quick","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:01Z","live_progress":{"step":"wait"}},{"task_id":"t2","name":"live","task_summary":"live","status":"running","category":"quick","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:01Z"}]}}`)
	dispatchEvent(s, "extension_event", `{"type":"extension_event","name":"omo.dag.updated","data":{"parent_session_id":"chat-ghost-settle","truncated_runs":false,"runs":[{"run_id":"r1","run_key":"r1","name":"r1","status":"completed","nodes":[{"id":"n1","label":"ghost","state":"completed","task_id":"t1"}],"edges":[],"waves":1}]}}`)
	dispatchEvent(s, "agent_settled", `{"type":"agent_settled"}`)
	if len(calls) != 1 {
		t.Fatalf("persist calls after settled run = %d, want 1", len(calls))
	}

	var taskPayload struct {
		Tasks []struct {
			TaskID string `json:"task_id"`
			Status string `json:"status"`
		} `json:"tasks"`
	}
	if err := json.Unmarshal(calls[0].Task, &taskPayload); err != nil {
		t.Fatalf("persisted task payload is not valid JSON: %v (%s)", err, calls[0].Task)
	}
	statuses := map[string]string{}
	for _, row := range taskPayload.Tasks {
		statuses[row.TaskID] = row.Status
	}
	if got := statuses["t1"]; got != "completed" {
		t.Fatalf("persisted t1 (node of terminal dag run) status = %q, want completed; payload: %s", got, calls[0].Task)
	}
	if got := statuses["t2"]; got != "running" {
		t.Fatalf("persisted t2 (no dag evidence) status = %q, want still running; payload: %s", got, calls[0].Task)
	}
}

type runDoneSnapshotWriter struct {
	s        *Session
	once     sync.Once
	observed chan ActivitySnapshotPair
}

func (w *runDoneSnapshotWriter) WriteJSON(frame []byte) error {
	var envelope struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(frame, &envelope) == nil && envelope.Type == "run.done" {
		w.once.Do(func() { w.observed <- w.s.ActivitySnapshot() })
	}
	return nil
}

// A terminal dag can arrive before a late running task snapshot. The settle
// sweep must reconcile that reverse-ordered pair before run.done is published,
// so a refresh triggered by run.done can never replay the contradictory pair.
func TestSettleReconcilesLateTaskBeforeRunDone(t *testing.T) {
	s := newTestSession("chat-ghost-reverse", nil)
	var persisted []ActivitySnapshotPair
	s.onActivitySnapshot = func(_ *Session, pair ActivitySnapshotPair) bool {
		persisted = append(persisted, pair)
		return true
	}

	dispatchEvent(s, "agent_start", `{"type":"agent_start"}`)
	dispatchEvent(s, "extension_event", `{"type":"extension_event","name":"omo.dag.updated","data":{"runs":[{"status":"failed","nodes":[{"task_id":"late","state":"failed"}]}]}}`)
	dispatchEvent(s, "extension_event", `{"type":"extension_event","name":"omo.task.updated","data":{"tasks":[{"task_id":"late","status":"running"}]}}`)

	writer := &runDoneSnapshotWriter{s: s, observed: make(chan ActivitySnapshotPair, 1)}
	detach := s.Attach(writer)
	defer detach()
	dispatchEvent(s, "agent_settled", `{"type":"agent_settled"}`)

	var observed ActivitySnapshotPair
	select {
	case observed = <-writer.observed:
	case <-time.After(time.Second):
		t.Fatal("run.done did not expose an activity snapshot")
	}
	if !bytes.Contains(observed.Task, []byte(`"status":"failed"`)) {
		t.Fatalf("cache at run.done = %s, want late task reconciled to failed", observed.Task)
	}
	if len(persisted) != 1 || !persisted[0].Equal(observed) {
		t.Fatalf("persisted pair = %+v, want cached pair observed at run.done %+v", persisted, observed)
	}
}

func TestSessionCloseWaitsForActivityPersistence(t *testing.T) {
	s := newTestSession("chat-persist-close", nil)
	persistStarted := make(chan struct{})
	releasePersist := make(chan struct{})
	persistFinished := make(chan struct{})
	s.onActivitySnapshot = func(_ *Session, _ ActivitySnapshotPair) bool {
		close(persistStarted)
		<-releasePersist
		close(persistFinished)
		return true
	}

	dispatchEvent(s, "agent_start", `{"type":"agent_start"}`)
	dispatchEvent(s, "extension_event", `{"type":"extension_event","name":"omo.task.updated","data":{"task":{"id":"st_1"}}}`)
	settled := make(chan struct{})
	go func() {
		dispatchEvent(s, "agent_settled", `{"type":"agent_settled"}`)
		close(settled)
	}()

	select {
	case <-persistStarted:
	case <-time.After(time.Second):
		t.Fatal("activity persistence did not start")
	}

	closeStarted := make(chan struct{})
	closeDone := make(chan error, 1)
	go func() {
		close(closeStarted)
		closeDone <- s.Close()
	}()
	<-closeStarted
	select {
	case err := <-closeDone:
		t.Fatalf("Close returned before activity persistence was released: %v", err)
	default:
	}

	close(releasePersist)
	select {
	case err := <-closeDone:
		if err != nil {
			t.Fatalf("Close returned error: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Close did not return after activity persistence finished")
	}
	select {
	case <-persistFinished:
	default:
		t.Fatal("Close returned before activity persistence finished")
	}
	select {
	case <-settled:
	case <-time.After(time.Second):
		t.Fatal("run completion did not return after activity persistence finished")
	}
}

// A failed store write must not advance the deduplication marker: the next
// settle carrying the same pair is handed off again. After a successful
// write, that same pair is suppressed exactly as on the happy path.
func TestFailedActivityPersistRetriesSamePair(t *testing.T) {
	s := newTestSession("chat-seed-persist-retry", nil)
	var calls []ActivitySnapshotPair
	s.onActivitySnapshot = func(source *Session, pair ActivitySnapshotPair) bool {
		if source != s {
			t.Errorf("persist callback source = %v, want the session itself", source)
		}
		calls = append(calls, pair)
		return len(calls) > 1
	}

	dispatchEvent(s, "agent_start", `{"type":"agent_start"}`)
	dispatchEvent(s, "extension_event", `{"type":"extension_event","name":"omo.task.updated","data":{"task":{"id":"st_1","status":"running"}}}`)
	dispatchEvent(s, "extension_event", `{"type":"extension_event","name":"omo.dag.updated","data":{"dag":{"nodes":[{"id":"st_1","status":"running"}],"edges":[]}}}`)
	dispatchEvent(s, "agent_settled", `{"type":"agent_settled"}`)
	if len(calls) != 1 {
		t.Fatalf("persist calls after first settled run = %d, want 1", len(calls))
	}

	// The first write failed, so the marker must stay put: the same pair is
	// handed off again on the next settle, and that attempt succeeds.
	dispatchEvent(s, "agent_start", `{"type":"agent_start"}`)
	dispatchEvent(s, "agent_settled", `{"type":"agent_settled"}`)
	if len(calls) != 2 {
		t.Fatalf("persist calls after retry settle = %d, want 2 (failed write must retry)", len(calls))
	}
	if !calls[1].Equal(calls[0]) {
		t.Fatalf("retried pair = %+v, want the same pair %+v", calls[1], calls[0])
	}

	// After the successful write, an unchanged pair is suppressed.
	dispatchEvent(s, "agent_start", `{"type":"agent_start"}`)
	dispatchEvent(s, "agent_settled", `{"type":"agent_settled"}`)
	if len(calls) != 2 {
		t.Fatalf("persist calls after successful write = %d, want still 2 (deduplicated)", len(calls))
	}
}
