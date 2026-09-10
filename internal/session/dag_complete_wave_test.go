package session

import (
	"encoding/json"
	"testing"
)

// The stored DAG checkpoint carries the engine's authored waves: the lane
// assignment (which column) and, inside each wave, the deliberate node order.
// parseCompleteDag must return that arrangement verbatim for valid waves —
// recomputing layers loses the engine's within-wave order (sorted node ids
// reorder a column alphabetically) and can flatten a later independent node
// into the first column. Real checkpoints diverge from the recomputation in
// within-wave order alone, but the passthrough must honor both facets.

type waveStoredDefinition struct {
	ID        string   `json:"id"`
	Label     string   `json:"label"`
	Prompt    *string  `json:"prompt"`
	DependsOn []string `json:"dependsOn"`
}

type waveStoredNode struct {
	ID     string  `json:"id"`
	State  string  `json:"state"`
	Prompt *string `json:"prompt"`
}

func wavePrompt(text string) *string { return &text }

// waveTestCheckpoint builds a valid stored checkpoint: document node order is
// b, a, c (deliberately non-alphabetical), c depends on nothing.
func waveTestCheckpoint(t *testing.T, waves string) []byte {
	t.Helper()
	prompt := wavePrompt("do the work")
	document := map[string]any{
		"runId":  "run-wave-order",
		"runKey": "key",
		"name":   "wave order",
		"status": "running",
		"definition": map[string]any{
			"nodes": []waveStoredDefinition{
				{ID: "b", Label: "b", Prompt: prompt, DependsOn: []string{}},
				{ID: "a", Label: "a", Prompt: prompt, DependsOn: []string{}},
				{ID: "c", Label: "c", Prompt: prompt, DependsOn: []string{}},
			},
		},
		"nodes": []waveStoredNode{
			{ID: "b", State: "pending", Prompt: prompt},
			{ID: "a", State: "pending", Prompt: prompt},
			{ID: "c", State: "pending", Prompt: prompt},
		},
	}
	if waves != "" {
		raw := json.RawMessage(waves)
		document["waves"] = raw
	}
	data, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func assertWaveLayout(t *testing.T, got []activityDagWave, want [][]string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("wave count = %d, want %d (%+v)", len(got), len(want), got)
	}
	for index, wave := range got {
		if wave.Index != index {
			t.Fatalf("wave %d has index %d, want %d", index, wave.Index, index)
		}
		if len(wave.NodeIDs) != len(want[index]) {
			t.Fatalf("wave %d nodes = %v, want %v", index, wave.NodeIDs, want[index])
		}
		for id := range want[index] {
			if wave.NodeIDs[id] != want[index][id] {
				t.Fatalf("wave %d nodes = %v, want %v", index, wave.NodeIDs, want[index])
			}
		}
	}
}

func TestParseCompleteDagHonorsStoredWaveOrder(t *testing.T) {
	data := waveTestCheckpoint(t, `[{"index":0,"nodeIds":["b","a"]},{"index":1,"nodeIds":["c"]}]`)
	document, err := parseCompleteDag(data)
	if err != nil {
		t.Fatal(err)
	}
	assertWaveLayout(t, document.Run.Waves, [][]string{{"b", "a"}, {"c"}})
}

func TestParseCompleteDagHonorsStoredWaveLaneAssignment(t *testing.T) {
	data := waveTestCheckpoint(t, `[{"index":0,"nodeIds":["b","a"]},{"index":1,"nodeIds":["c"]}]`)
	document, err := parseCompleteDag(data)
	if err != nil {
		t.Fatal(err)
	}
	assertWaveLayout(t, document.Run.Waves, [][]string{{"b", "a"}, {"c"}})
}

// Characterization: without stored waves the recomputed layout (frontier
// layers, ids sorted within a wave) is unchanged.
func TestParseCompleteDagWithoutWavesKeepsComputedLayout(t *testing.T) {
	document, err := parseCompleteDag(waveTestCheckpoint(t, ""))
	if err != nil {
		t.Fatal(err)
	}
	assertWaveLayout(t, document.Run.Waves, [][]string{{"a", "b", "c"}})
}

// C3: structurally invalid stored waves (unknown id, duplicate coverage,
// incomplete coverage, or a repeated lane index) fall back to the computed
// layout and never lose or duplicate a node.
func TestParseCompleteDagInvalidStoredWavesFallBack(t *testing.T) {
	invalid := []string{
		`[{"index":0,"nodeIds":["b","a","ghost"]}]`,
		`[{"index":0,"nodeIds":["b","a","a"]}]`,
		`[{"index":0,"nodeIds":["b"]}]`,
		`[{"index":0,"nodeIds":["b","a"]},{"index":0,"nodeIds":["c"]}]`,
		`[{"index":-1,"nodeIds":["b","a","c"]}]`,
	}
	for _, waves := range invalid {
		document, err := parseCompleteDag(waveTestCheckpoint(t, waves))
		if err != nil {
			t.Fatalf("waves %s: %v", waves, err)
		}
		assertWaveLayout(t, document.Run.Waves, [][]string{{"a", "b", "c"}})
	}
}
