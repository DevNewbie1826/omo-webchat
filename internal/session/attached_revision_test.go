package session

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func attachedRevision(t *testing.T, frame Frame) int64 {
	t.Helper()
	raw, err := json.Marshal(frame)
	if err != nil {
		t.Fatal(err)
	}
	var fields struct{ Revision int64 }
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatal(err)
	}
	if fields.Revision <= 0 || fields.Revision > maxLiveInteger {
		t.Fatalf("attached content has no safe production revision: %s", raw)
	}
	return fields.Revision
}

func TestAttachedRevisionProductionAndReplay(t *testing.T) {
	// Given a manager clock already ahead of wall time and a bound session.
	h := newDAGOrderingHarness(t, "bound")
	h.m.mu.Lock()
	h.m.overviewRevisionClock = 4_000_000_000_000
	h.m.mu.Unlock()
	live := newRecorder(16)
	detach := h.s.Attach(live)
	defer detach()
	h.emit(t, activitySnapshotOrder[0], map[string]any{"tasks": []any{}})
	_, first := live.await(t, FrameExtensionEvent)
	firstRevision := attachedRevision(t, first)
	if firstRevision <= 4_000_000_000_000 {
		t.Fatalf("attached revision bypassed manager clock: %d", firstRevision)
	}
	// When a DAG changes the combined task counts, both cached projections
	// are produced anew, before any accessor or replay is called.
	h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(dagOrderingRun("new", "running", dagCurrent)))
	_, dag := live.await(t, FrameExtensionEvent)
	snapshot := h.s.ActivitySnapshot()
	if len(snapshot) != 2 {
		t.Fatalf("snapshot = %+v", snapshot)
	}
	for _, frame := range snapshot {
		if revision := attachedRevision(t, frame); revision <= firstRevision {
			t.Fatalf("changed replay content kept old authority: %d <= %d", revision, firstRevision)
		}
	}
	if attachedRevision(t, snapshot[1]) != attachedRevision(t, dag) {
		t.Fatal("live and identical cached DAG content have different revisions")
	}
	h.m.mu.Lock()
	beforeReplay := h.m.issueOverviewRevisionLocked()
	h.m.mu.Unlock()
	replay := newRecorder(16)
	detachReplay := h.s.Attach(replay)
	defer detachReplay()
	// Then replay and refresh preserve content and revision despite newer
	// overview authority, and the already-produced old frame stays old.
	for i := range snapshot {
		_, frame := replay.await(t, FrameExtensionEvent)
		if !reflect.DeepEqual(frame, snapshot[i]) {
			t.Fatalf("replay changed content or authority: %+v != %+v", frame, snapshot[i])
		}
	}
	if next := h.s.ActivitySnapshot(); !reflect.DeepEqual(next, snapshot) {
		t.Fatalf("refresh changed content or authority: %+v != %+v", next, snapshot)
	}
	h.m.mu.Lock()
	afterReplay := h.m.overviewRevisionClock
	h.m.mu.Unlock()
	if afterReplay != beforeReplay || attachedRevision(t, first) != firstRevision {
		t.Fatal("delivery or replay minted fresh authority")
	}
}

func TestAttachedRevisionUnboundTransferPreservesProduction(t *testing.T) {
	// Given task/DAG content produced while no route owns the durable.
	h := newDAGOrderingHarness(t, "transfer")
	h.emit(t, activitySnapshotOrder[0], map[string]any{"tasks": []any{}})
	h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(dagOrderingRun("cached", "running", dagCurrent)))
	h.m.mu.Lock()
	producedBefore := h.m.overviewRevisionClock
	h.m.overviewRevisionClock += 1000
	h.m.mu.Unlock()
	live := newRecorder(16)
	detach := h.s.Attach(live)
	defer detach()
	// When the cache is transferred to a newly bound session.
	h.bind()
	snapshot := h.s.ActivitySnapshot()
	// Then neither transfer nor attach-time enrichment restamps old content.
	for _, expected := range snapshot {
		_, frame := live.await(t, FrameExtensionEvent)
		if revision := attachedRevision(t, frame); revision > producedBefore {
			t.Fatalf("cached content acquired fresh authority: %d > %d", revision, producedBefore)
		}
		if !reflect.DeepEqual(frame, expected) {
			t.Fatalf("transfer and refresh differ: %+v != %+v", frame, expected)
		}
	}
	if len(snapshot) != 2 {
		t.Fatalf("transferred snapshot count = %d", len(snapshot))
	}
}

func TestAttachedRevisionDuplicateContentKeepsAuthority(t *testing.T) {
	for _, name := range []string{"omo.task.updated", "omo.dag.updated", "omo.dag.activity"} {
		t.Run(name, func(t *testing.T) {
			// Given an oversized live payload (not retained as rich replay),
			// or a transient activity event with no task/DAG replay at all.
			h := newDAGOrderingHarness(t, "bound")
			live := newRecorder(16)
			detach := h.s.Attach(live)
			defer detach()
			data := map[string]any{
				"tasks": []any{}, "runs": []any{},
				"detail": strings.Repeat("x", maxActivitySnapshotBytes+1),
				"at":     dagCurrent,
			}
			h.emit(t, name, data)
			_, first := live.await(t, FrameExtensionEvent)
			// When the same content is delivered again after newer authority.
			h.m.mu.Lock()
			h.m.issueOverviewRevisionLocked()
			h.m.mu.Unlock()
			h.emit(t, name, data)
			_, second := live.await(t, FrameExtensionEvent)
			// Then duplicate content cannot renew its production authority.
			if !reflect.DeepEqual(first.Data, second.Data) {
				t.Fatal("fixture did not produce identical content")
			}
			if a, b := attachedRevision(t, first), attachedRevision(t, second); a != b {
				t.Fatalf("identical content acquired fresh authority: %d -> %d", a, b)
			}
		})
	}
}

func TestAttachedRevisionHydrationDrainKeepsProductionAuthority(t *testing.T) {
	// Given a subscriber with the real hydration replay gate already armed.
	h := newDAGOrderingHarness(t, "bound")
	live := newRecorder(16)
	detach, target, err := h.s.attachCheckedReplayTarget(live)
	if err != nil {
		t.Fatal(err)
	}
	defer detach()
	h.emit(t, "omo.task.updated", map[string]any{"tasks": []any{}})
	produced := h.s.ActivitySnapshot()[0]
	// When newer overview authority is issued before pendingLive drains.
	h.m.mu.Lock()
	later := h.m.issueOverviewRevisionLocked()
	h.m.mu.Unlock()
	ctx, cancel := context.WithTimeout(t.Context(), testTimeout)
	defer cancel()
	if err := target.enqueueReplayBarrier(ctx); err != nil {
		t.Fatal(err)
	}
	_, drained := live.await(t, FrameExtensionEvent)
	// Then delayed delivery carries the original payload and older revision.
	if !reflect.DeepEqual(produced, drained) || attachedRevision(t, drained) >= later {
		t.Fatalf("hydration drain restamped content: %+v -> %+v", produced, drained)
	}
}
