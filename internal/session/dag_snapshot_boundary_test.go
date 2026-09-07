package session

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestDAGSnapshotOrderingBoundaries(t *testing.T) {
	for _, test := range []struct {
		name    string
		value   any
		missing bool
	}{
		{name: "missing_timestamp", missing: true},
		{name: "null_timestamp", value: nil},
		{name: "numeric_timestamp", value: 42},
		{name: "object_timestamp", value: map[string]any{}},
		{name: "array_timestamp", value: []any{}},
		{name: "boolean_timestamp", value: false},
		{name: "comma_fraction", value: "2026-09-07T10:03:00,000Z"},
		{name: "single_digit_hour", value: "2026-09-07T1:03:00Z"},
		{name: "offset_minute_60", value: "2026-09-07T10:03:00-00:60"},
		{name: "hour_24", value: "2026-09-07T24:03:00Z"},
		{name: "leap_second", value: "2026-09-07T10:03:60Z"},
	} {
		t.Run(test.name, func(t *testing.T) {
			h := newDAGOrderingHarness(t, "bound")
			current := dagOrderingRun("ordering-run", "completed", dagCurrent)
			h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(current))
			incoming := dagOrderingRun("ordering-run", "running", dagNewer)
			if test.missing {
				delete(incoming, "updated_at")
			} else {
				incoming["updated_at"] = test.value
			}
			h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(incoming))
			assertDAGOrderingRows(t, h.summary().ActivityPair.Dag, current)
		})
	}
	t.Run("terminal_omission", func(t *testing.T) {
		h := newDAGOrderingHarness(t, "bound")
		current := dagOrderingRun("ordering-run", "completed", dagCurrent)
		h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(current))
		h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot())
		assertDAGOrderingRows(t, h.summary().ActivityPair.Dag, current)
	})
	t.Run("newer_partial_is_a_whole_unit", func(t *testing.T) {
		h := newDAGOrderingHarness(t, "bound")
		h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(dagOrderingRun("ordering-run", "completed", dagCurrent)))
		partial := dagOrderingRun("ordering-run", "running", dagNewer)
		partial["nodes"], partial["edges"], partial["waves"] = []any{}, []any{}, []any{}
		partial["counts"] = map[string]any{"total": 0, "running": 0, "completed": 0}
		partial["truncated_nodes"] = true
		snapshot := dagOrderingSnapshot(partial)
		snapshot["truncated_runs"] = true
		h.emit(t, activitySnapshotOrder[1], snapshot)
		assertDAGOrderingRows(t, h.summary().ActivityPair.Dag, partial)
		var doc struct {
			Truncated bool `json:"truncated_runs"`
		}
		if err := json.Unmarshal(h.summary().ActivityPair.Dag, &doc); err != nil {
			t.Fatal(err)
		}
		if !doc.Truncated {
			t.Error("truncated_runs lost")
		}
	})
	t.Run("parent_identity_before_freshness", func(t *testing.T) {
		h := newDAGOrderingHarness(t, "bound")
		foreign := dagOrderingSnapshot(dagOrderingRun("ordering-run", "completed", dagNewer))
		foreign["parent_session_id"] = "other-parent"
		h.emit(t, activitySnapshotOrder[1], foreign)
		current := dagOrderingRun("ordering-run", "running", dagCurrent)
		h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(current))
		assertDAGOrderingRows(t, h.summary().ActivityPair.Dag, current)
	})
	t.Run("oversized_active_digest_survives_partial_refill", func(t *testing.T) {
		h := newDAGOrderingHarness(t, "unbound")
		large := dagOrderingRun("ordering-run", "running", dagNewer)
		large["padding"] = strings.Repeat("x", maxActivitySnapshotBytes)
		h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(large))
		h.bind()
		other := dagOrderingRun("other", "completed", dagNewer)
		h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(dagOrderingRun("ordering-run", "completed", dagCurrent), other))
		summary := h.summary()
		assertDAGOrderingRows(t, summary.ActivityPair.Dag, other)
		if summary.DagDigest == nil || len(summary.DagDigest.Runs) != 1 || summary.DagDigest.Runs[0].RunID != "ordering-run" || len(summary.DagDigest.Runs[0].RunningTaskIDs) != 1 || summary.DagDigest.Runs[0].RunningTaskIDs[0] != "task-ordering-run" || !summary.DagDigest.Truncated {
			t.Fatalf("accepted active oversized digest lost: %+v", summary.DagDigest)
		}
	})
	t.Run("partial_refill_preserves_digest_id_bound", func(t *testing.T) {
		h := newDAGOrderingHarness(t, "bound")
		large := dagOrderingRun("ordering-run", "running", dagNewer)
		nodes := make([]any, maxActivityDigestEntries)
		for i := range nodes {
			nodes[i] = map[string]any{"state": "running", "task_id": fmt.Sprintf("task-%d", i)}
		}
		large["nodes"], large["padding"] = nodes, strings.Repeat("x", maxActivitySnapshotBytes)
		h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(large))
		h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(dagOrderingRun("ordering-run", "completed", dagCurrent), dagOrderingRun("other", "running", dagNewer)))
		digest := h.summary().DagDigest
		ids := 0
		for _, row := range digest.Runs {
			ids += len(row.RunningTaskIDs)
		}
		if ids > maxActivityDigestEntries || !digest.Truncated {
			t.Fatalf("partial refill retained %d task IDs, truncated=%v", ids, digest.Truncated)
		}
	})
	t.Run("compact_high_water_bound", func(t *testing.T) {
		h := newDAGOrderingHarness(t, "bound")
		for i := 0; i < maxActivityDigestEntries+1; i++ {
			row := map[string]any{"run_id": fmt.Sprintf("run-%03d", i), "status": "running", "updated_at": dagCurrent}
			h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(row))
		}
		if len(h.s.dagSnapshots.runs) != maxActivityDigestEntries {
			t.Fatalf("freshness entries = %d", len(h.s.dagSnapshots.runs))
		}
		if _, exists := h.s.dagSnapshots.runs[sha256.Sum256([]byte("run-000"))]; exists {
			t.Error("oldest omitted freshness not evicted")
		}
		h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(map[string]any{"run_id": "run-001", "status": "completed", "updated_at": dagOlder}))
		assertDAGOrderingRows(t, h.summary().ActivityPair.Dag)
	})
	t.Run("oversized_live_not_replayed_on_attach", func(t *testing.T) {
		h := newDAGOrderingHarness(t, "bound")
		r := newRecorder(8)
		detach := h.s.Attach(r)
		defer detach()
		large := dagOrderingRun("ordering-run", "completed", dagCurrent)
		large["padding"] = strings.Repeat("x", maxActivitySnapshotBytes)
		h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(large))
		_, frame := r.await(t, FrameExtensionEvent)
		raw, err := json.Marshal(frame.Data.(map[string]any)["data"])
		if err != nil {
			t.Fatal(err)
		}
		assertDAGOrderingRows(t, raw, large)
		replay := newRecorder(8)
		detachReplay := h.s.Attach(replay)
		defer detachReplay()
		// The following event is an exact delivery barrier for the attach queue.
		injectEvent(t, h.s, map[string]any{"type": "agent_start"})
		prior, _ := replay.await(t, FrameRunStarted)
		if len(prior) != 0 {
			t.Fatalf("attach replayed obsolete/oversized DAG: %d frames", len(prior))
		}
	})
}

func TestDAGSnapshotOrderingProviderTransfer(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 64)
	arrived := make(chan Summary, 4)
	unsubscribe := mgr.SubscribeOverview(func(snapshot Summary) { arrived <- snapshot })
	defer unsubscribe()
	const durableID = "durable-00000001-4f2a-9c31"
	current := dagOrderingRun("ordering-run", "completed", dagCurrent)
	emitUnboundActivity(d, durableID, activitySnapshotOrder[1], dagOrderingSnapshot(current))
	assertDAGOrderingRows(t, awaitOverview(t, arrived).ActivityPair.Dag, current)
	s, _, _ := acquire(t, mgr, testChat{id: "ordering-chat", cwd: t.TempDir()}, nil)
	assertDAGOrderingRows(t, awaitOverview(t, arrived).ActivityPair.Dag, current)
	stale := dagOrderingSnapshot(dagOrderingRun("ordering-run", "running", dagOlder))
	stale["parent_session_id"] = durableID
	d.Emit(map[string]any{"type": "extension_event", "sessionId": "retired-route", "name": activitySnapshotOrder[1], "data": stale})
	assertDAGOrderingRows(t, awaitOverview(t, arrived).ActivityPair.Dag, current)
	frames := s.ActivitySnapshot()
	if len(frames) != 1 {
		t.Fatalf("replay frame count = %d", len(frames))
	}
	raw, err := json.Marshal(frames[0].Data.(map[string]any)["data"])
	if err != nil {
		t.Fatal(err)
	}
	assertDAGOrderingRows(t, raw, current)
}
