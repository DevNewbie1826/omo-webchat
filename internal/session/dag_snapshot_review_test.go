package session

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
)

func TestDAGSnapshotOrderingCheckedTransferDestinationIsUnpublished(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 64)
	arrived := make(chan Summary, 4)
	unsubscribe := mgr.SubscribeOverview(func(snapshot Summary) { arrived <- snapshot })
	defer unsubscribe()
	const durableID = "durable-00000001-4f2a-9c31"
	current := dagOrderingRun("ordering-run", "completed", dagCurrent)
	newer := dagOrderingRun("ordering-run", "running", dagNewer)
	emitUnboundActivity(d, durableID, activitySnapshotOrder[1], dagOrderingSnapshot(current))
	assertDAGOrderingRows(t, awaitOverview(t, arrived).ActivityPair.Dag, current)

	initialized := false
	s, started, detach, err := mgr.AcquireInitializedChecked(context.Background(), testChat{id: "checked-ordering-chat", cwd: t.TempDir()}, nil,
		func(destination *Session, started bool, _ func()) {
			initialized = true
			if !started {
				t.Error("expected a newly allocated destination")
			}
			mgr.mu.Lock()
			routed := mgr.byRoute[destination.routingID] == destination
			mgr.mu.Unlock()
			if routed {
				t.Error("destination was published before checked initialization")
			}
			// Deliver through the real provider/client/manager path while checked
			// initialization holds publication. The overview event is the barrier.
			data := dagOrderingSnapshot(newer)
			data["parent_session_id"] = destination.ID()
			d.Emit(map[string]any{"type": "extension_event", "sessionId": destination.RoutingID(), "name": activitySnapshotOrder[1], "data": data})
			assertDAGOrderingRows(t, awaitOverview(t, arrived).ActivityPair.Dag, newer)
			destination.lifecycleMu.Lock()
			empty := len(destination.activitySnapshots) == 0 && destination.dagDigest == nil && len(destination.dagSnapshots.runs) == 0
			destination.lifecycleMu.Unlock()
			if !empty {
				t.Error("unpublished destination accepted DAG state before transfer")
			}
		}, func() error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	defer detach()
	if !initialized || !started {
		t.Fatal("checked initialization was not exercised")
	}
	assertDAGOrderingRows(t, awaitOverview(t, arrived).ActivityPair.Dag, newer)
	stale := dagOrderingSnapshot(current)
	stale["parent_session_id"] = s.ID()
	d.Emit(map[string]any{"type": "extension_event", "sessionId": s.RoutingID(), "name": activitySnapshotOrder[1], "data": stale})
	assertDAGOrderingRows(t, awaitOverview(t, arrived).ActivityPair.Dag, newer)
}

func TestDAGSnapshotOrderingEvictionProjectsAcceptedMembership(t *testing.T) {
	for _, mode := range []string{"bound", "unbound", "transfer"} {
		t.Run(mode, func(t *testing.T) {
			h := newDAGOrderingHarness(t, mode)
			rows := make([]map[string]any, maxActivityDigestEntries)
			for i := range rows {
				rows[i] = map[string]any{"run_id": fmt.Sprintf("run-%03d", i), "status": "completed", "updated_at": dagCurrent}
			}
			h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(rows...))
			if mode == "transfer" {
				h.bind()
			}
			// A new row arrives first at capacity, followed by a stale update for
			// the oldest incumbent. Eviction cannot turn that stale row into new work.
			incoming := append([]map[string]any{{"run_id": "new-run", "status": "running", "updated_at": dagNewer}}, rows...)
			incoming[1] = map[string]any{"run_id": "run-000", "status": "running", "updated_at": dagOlder}
			h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(incoming...))
			summary := h.summary()
			var doc struct {
				Runs []struct {
					RunID  string `json:"run_id"`
					Status string `json:"status"`
				} `json:"runs"`
				Truncated bool `json:"truncated_runs"`
			}
			if err := json.Unmarshal(summary.ActivityPair.Dag, &doc); err != nil {
				t.Fatal(err)
			}
			if len(doc.Runs) != maxActivityDigestEntries || !doc.Truncated {
				t.Fatalf("eviction membership: rows=%d truncated=%v", len(doc.Runs), doc.Truncated)
			}
			active := make(map[string]string)
			for _, row := range doc.Runs {
				if row.RunID == "run-000" && row.Status != "completed" {
					t.Errorf("same-snapshot eviction admitted stale incumbent: %+v", row)
				}
				if !terminalDagStatuses[row.Status] {
					active[row.RunID] = row.Status
				}
			}
			if summary.DagDigest == nil || !summary.DagDigest.Truncated {
				t.Fatal("digest does not disclose evicted membership")
			}
			for _, row := range summary.DagDigest.Runs {
				if active[row.RunID] != row.Status {
					t.Errorf("digest diverged from accepted raw membership: %+v", row)
				}
				delete(active, row.RunID)
			}
			if len(active) != 0 {
				t.Errorf("digest omitted reconstructable active rows: %v", active)
			}
		})
	}
}

func TestDAGSnapshotOrderingRetainsPartialDisclosure(t *testing.T) {
	for _, mode := range []string{"bound", "unbound", "transfer"} {
		for _, otherPartial := range []bool{false, true} {
			for _, stage := range []string{"mixed", "complete_a", "complete_all"} {
				t.Run(fmt.Sprintf("%s/other_partial_%v/%s", mode, otherPartial, stage), func(t *testing.T) {
					h := newDAGOrderingHarness(t, mode)
					partialA := dagOrderingRun("a", "running", dagCurrent)
					partialA["nodes"], partialA["edges"], partialA["waves"] = []any{}, []any{}, []any{}
					partialA["counts"] = map[string]any{"total": 0, "running": 0, "completed": 0}
					partialC := dagOrderingRun("c", "completed", dagCurrent)
					partialC["nodes"], partialC["edges"], partialC["waves"] = []any{}, []any{}, []any{}
					partialC["counts"] = map[string]any{"total": 0, "running": 0, "completed": 0}
					initial := []map[string]any{partialA}
					if otherPartial {
						initial = append(initial, partialC)
					}
					seed := dagOrderingSnapshot(initial...)
					seed["truncated_runs"] = true
					h.emit(t, activitySnapshotOrder[1], seed)
					if mode == "transfer" {
						h.bind()
					}
					live := newRecorder(8)
					detach := h.s.Attach(live)
					defer detach()
					if !h.unbound {
						live.await(t, FrameExtensionEvent) // Drain the seed replay before live input.
					}
					b := dagOrderingRun("b", "running", dagNewer)
					incoming := []map[string]any{dagOrderingRun("a", "running", dagOlder), b}
					if otherPartial {
						incoming = append(incoming, partialC)
					}
					complete := dagOrderingSnapshot(incoming...)
					complete["truncated_runs"] = false
					h.emit(t, activitySnapshotOrder[1], complete)
					want := []map[string]any{partialA, b}
					if otherPartial {
						want = append(want, partialC)
					}
					wantTruncated := true
					if stage != "mixed" {
						if !h.unbound {
							live.await(t, FrameExtensionEvent)
						}
						want[0] = dagOrderingRun("a", "running", dagNewer)
						h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(want...))
						wantTruncated = otherPartial
					}
					if stage == "complete_all" && otherPartial {
						if !h.unbound {
							live.await(t, FrameExtensionEvent)
						}
						want[2] = dagOrderingRun("c", "completed", dagNewer)
						h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(want...))
						wantTruncated = false
					}
					assertProjection := func(surface string, raw json.RawMessage) {
						t.Helper()
						assertDAGOrderingRows(t, raw, want...)
						var doc struct {
							Truncated bool `json:"truncated_runs"`
						}
						if err := json.Unmarshal(raw, &doc); err != nil {
							t.Fatal(err)
						}
						if doc.Truncated != wantTruncated {
							t.Errorf("%s truncated_runs=%v, want %v", surface, doc.Truncated, wantTruncated)
						}
					}
					summary := h.summary()
					assertProjection("raw replay", summary.ActivityPair.Dag)
					if summary.DagDigest == nil || summary.DagDigest.Truncated != wantTruncated || len(summary.DagDigest.Runs) != 2 {
						t.Errorf("active digest=%+v, want two runs and truncated=%v", summary.DagDigest, wantTruncated)
					}
					if h.unbound {
						h.bind() // Transfer forwards to the subscriber established above.
					}
					assertFrame := func(surface string, frame Frame) {
						t.Helper()
						raw, err := json.Marshal(frame.Data.(map[string]any)["data"])
						if err != nil {
							t.Fatal(err)
						}
						assertProjection(surface, raw)
					}
					_, frame := live.await(t, FrameExtensionEvent)
					assertFrame("forwarded/transfer", frame)
					refresh := h.s.ActivitySnapshot()
					if len(refresh) != 1 {
						t.Fatalf("refresh frame count=%d", len(refresh))
					}
					assertFrame("refresh", refresh[0])
					replay := newRecorder(8)
					detachReplay := h.s.Attach(replay)
					defer detachReplay()
					_, frame = replay.await(t, FrameExtensionEvent)
					assertFrame("attach", frame)
				})
			}
		}
	}
}
