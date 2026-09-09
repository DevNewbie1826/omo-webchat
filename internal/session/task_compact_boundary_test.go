package session

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// These receipts are consumed by activityState.taskCompactBoundary.test.ts.
// Normal Go tests compare every emitted frame with the checked-in fixture;
// regeneration is explicit, and only the nondeterministic receipt clock is omitted.
func TestTaskStateOrderingCompactBoundary(t *testing.T) {
	for _, mode := range []string{"compact-only", "mixed"} {
		t.Run(mode, func(t *testing.T) {
			h := newDAGOrderingHarness(t, "bound")
			r := newRecorder(32)
			detach := h.s.Attach(r)
			defer detach()
			capture := func() []map[string]any {
				injectEvent(t, h.s, map[string]any{"type": "state_changed"})
				before, _ := r.await(t, FrameState)
				frames := make([]map[string]any, 0)
				for _, f := range before {
					if f.Kind != FrameExtensionEvent {
						continue
					}
					data := f.Data.(map[string]any)
					if data["name"] != activitySnapshotOrder[0] {
						continue
					}
					payload, _ := json.Marshal(data["data"])
					var fixtureData map[string]any
					_ = json.Unmarshal(payload, &fixtureData)
					delete(fixtureData, "agent_running_count")
					delete(fixtureData, "agent_total_count")
					delete(fixtureData, "running_count")
					delete(fixtureData, "total_count")
					frames = append(frames, map[string]any{"type": "extensionEvent", "sessionId": "review-chat", "name": data["name"], "data": fixtureData})
				}
				return frames
			}
			row := taskOrderingRow("task-r", "running", dagCurrent)
			row["padding"] = strings.Repeat("x", maxActivitySnapshotBytes)
			h.emit(t, activitySnapshotOrder[0], taskOrderingSnapshot(row))
			if mode == "mixed" {
				data := taskOrderingSnapshot(taskOrderingRow("other", "pending", dagCurrent))
				data["truncated_tasks"] = true
				h.emit(t, activitySnapshotOrder[0], data)
			}
			h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(dagOrderingRun("r", "completed", dagNewer)))
			frames := capture()
			summary := h.summary()
			if len(frames) < 2 || summary.TaskDigest == nil {
				t.Fatal("missing producer receipts")
			}
			expected := TaskDigestEntry{TaskID: "task-r", Status: "completed", RawStatus: "running", UpdatedAt: dagCurrent}
			found := false
			for _, task := range summary.TaskDigest.Tasks {
				if task == expected {
					found = true
				}
			}
			if !found || !summary.TaskDigest.Truncated {
				t.Fatalf("compact winner lost: %+v", summary.TaskDigest)
			}
			digestJSON, _ := json.Marshal(summary.TaskDigest)
			if len(digestJSON) > maxActivitySnapshotBytes || len(summary.ActivityPair.Task) > maxActivitySnapshotBytes {
				t.Fatal("cache/digest exceeded 64KiB")
			}
			// Minimal attached corrections must not be stored as complete rich replay:
			// equal-version provider data still has to refill the evicted description.
			rich := taskOrderingRow("task-r", "running", dagCurrent)
			rich["name"], rich["task_summary"] = "Refilled task", "Full description"
			data := taskOrderingSnapshot(rich)
			data["truncated_tasks"] = true
			h.emit(t, activitySnapshotOrder[0], data)
			enrichment := capture()
			enriched := false
			for _, task := range taskOrderingRows(t, h.summary().ActivityPair.Task) {
				if task["task_id"] == "task-r" && task["name"] == rich["name"] && task["task_summary"] == rich["task_summary"] && task["status"] == "completed" && task["raw_status"] == "running" && task["updated_at"] == dagCurrent {
					enriched = true
				}
			}
			if !enriched {
				t.Fatal("equal rich enrichment blocked by compact projection")
			}
			summary.TaskDigest.ReceivedAt = "" // Receipt time is not source authority.
			// This cross-client ordering fixture predates scalar authority and covers
			// retained correction rows only; exact scalar wire coverage is separate.
			fixtureDigest := struct {
				Tasks        []TaskDigestEntry `json:"tasks"`
				Truncated    bool              `json:"truncated"`
				RunningCount int               `json:"running_count"`
				TotalCount   int               `json:"total_count"`
			}{summary.TaskDigest.Tasks, summary.TaskDigest.Truncated, 0, 1}
			receipt := map[string]any{"frames": frames, "taskDigest": fixtureDigest, "expectedTask": expected, "enrichmentFrames": enrichment}
			payload, err := json.MarshalIndent(receipt, "", "  ")
			if err != nil {
				t.Fatal(err)
			}
			payload = append(payload, '\n')
			fixture := filepath.Join("..", "..", "frontend", "test", "fixtures", "task-compact-boundary", mode+".json")
			if os.Getenv("UPDATE_TASK_COMPACT_FIXTURES") == "1" {
				if err := os.MkdirAll(filepath.Dir(fixture), 0755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(fixture, payload, 0644); err != nil {
					t.Fatal(err)
				}
			}
			shipped, err := os.ReadFile(fixture)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(shipped, payload) {
				t.Errorf("producer output differs from frontend-consumed fixture %s", fixture)
			}
			if dir := os.Getenv("TASK_COMPACT_RECEIPT_DIR"); dir != "" {
				path := filepath.Join(dir, "emitted-"+mode+".json")
				if err := os.WriteFile(path, payload, 0600); err != nil {
					t.Fatal(err)
				}
				t.Logf("receipt=%s", path)
			}
			latest, _ := json.Marshal(frames[len(frames)-1]["data"])
			var correction struct {
				Tasks     []TaskDigestEntry `json:"tasks"`
				Truncated bool              `json:"truncated_tasks"`
			}
			if err := json.Unmarshal(latest, &correction); err != nil {
				t.Fatal(err)
			}
			found = false
			for _, task := range correction.Tasks {
				if task == expected {
					found = true
				}
			}
			if !found || !correction.Truncated {
				t.Errorf("attached compact correction missing: %s", latest)
			}
		})
	}
}

// A retained rich prefix must not crowd out any representable compact winner.
func TestTaskStateOrderingCompactWinners(t *testing.T) {
	h := newDAGOrderingHarness(t, "bound")
	r := newRecorder(32)
	detach := h.s.Attach(r)
	defer detach()
	ids := []string{"task-r", "task-s", "task-t"}
	rows := make([]map[string]any, 0, len(ids))
	nodes := make([]any, 0, len(ids))
	for _, id := range ids {
		row := taskOrderingRow(id, "running", dagCurrent)
		row["padding"] = strings.Repeat("x", maxActivitySnapshotBytes)
		rows = append(rows, row)
		nodes = append(nodes, map[string]any{"task_id": id, "state": "completed"})
	}
	h.emit(t, activitySnapshotOrder[0], taskOrderingSnapshot(rows...))
	prefix := taskOrderingRow("other", "pending", dagCurrent)
	prefix["padding"] = strings.Repeat("y", maxActivitySnapshotBytes-220)
	data := taskOrderingSnapshot(prefix)
	data["truncated_tasks"] = true
	h.emit(t, activitySnapshotOrder[0], data)
	run := dagOrderingRun("r", "completed", dagNewer)
	run["nodes"] = nodes
	h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(run))
	injectEvent(t, h.s, map[string]any{"type": "state_changed"})
	before, _ := r.await(t, FrameState)
	var latest json.RawMessage
	for _, f := range before {
		if f.Kind != FrameExtensionEvent {
			continue
		}
		data := f.Data.(map[string]any)
		if data["name"] == activitySnapshotOrder[0] {
			latest, _ = json.Marshal(data["data"])
		}
	}
	found := make(map[string]bool)
	for _, row := range taskOrderingRows(t, latest) {
		id := row["task_id"].(string)
		if id == "other" {
			continue
		}
		if row["status"] != "completed" || row["raw_status"] != "running" || row["updated_at"] != dagCurrent {
			t.Fatalf("invalid compact correction: %v", row)
		}
		if found[id] {
			t.Fatalf("duplicate correction: %s", id)
		}
		found[id] = true
	}
	for _, id := range ids {
		if !found[id] {
			t.Errorf("missing compact winner %s beside rich prefix", id)
		}
	}
	summary := h.summary()
	digest, _ := json.Marshal(summary.TaskDigest)
	if summary.TaskDigest == nil || !summary.TaskDigest.Truncated || len(digest) > maxActivitySnapshotBytes || len(summary.ActivityPair.Task) > maxActivitySnapshotBytes {
		t.Fatal("cache/digest bound or partial disclosure lost")
	}
	if len(taskOrderingRows(t, summary.ActivityPair.Task)) != 1 {
		t.Fatal("compact projection polluted rich replay")
	}
}
