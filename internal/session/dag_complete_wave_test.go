package session

import (
	"encoding/json"
	"reflect"
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
		// RawMessage keeps malformed hint shapes (objects, strings, wrong
		// value types) verbatim so the parser meets them as the engine could
		// write them, not as Go types that silently coerce.
		document["waves"] = json.RawMessage(waves)
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

// A malformed optional hint (wrong container or value types the typed decode
// cannot represent) must degrade to the computed layout, not invalidate an
// otherwise readable checkpoint.
func TestParseCompleteDagMalformedWaveHintsFallBack(t *testing.T) {
	malformed := []string{
		`{"index":0,"nodeIds":["b","a","c"]}`,
		`"nope"`,
		`7`,
		`[{"index":"0","nodeIds":["b","a","c"]}]`,
		`[{"index":0.5,"nodeIds":["b","a","c"]}]`,
		`[{"index":0,"nodeIds":["b",2,"c"]}]`,
	}
	for _, waves := range malformed {
		document, err := parseCompleteDag(waveTestCheckpoint(t, waves))
		if err != nil {
			t.Fatalf("waves %s: %v", waves, err)
		}
		assertWaveLayout(t, document.Run.Waves, [][]string{{"a", "b", "c"}})
	}
}

// An index must be explicitly present, non-null, and inside the frontend's
// safe-integer range; anything else is an invented or unconsumable lane key
// and falls back. Sparse, non-contiguous indices remain valid.
func TestParseCompleteDagWaveIndexBoundaries(t *testing.T) {
	for _, waves := range []string{
		`[{"nodeIds":["b","a","c"]}]`,
		`[{"index":null,"nodeIds":["b","a","c"]}]`,
		`[{"index":9007199254740992,"nodeIds":["b","a","c"]}]`,
	} {
		document, err := parseCompleteDag(waveTestCheckpoint(t, waves))
		if err != nil {
			t.Fatalf("waves %s: %v", waves, err)
		}
		assertWaveLayout(t, document.Run.Waves, [][]string{{"a", "b", "c"}})
	}

	sparse, err := parseCompleteDag(waveTestCheckpoint(t,
		`[{"index":2,"nodeIds":["c"]},{"index":0,"nodeIds":["b","a"]}]`))
	if err != nil {
		t.Fatal(err)
	}
	if len(sparse.Run.Waves) != 2 || sparse.Run.Waves[0].Index != 0 ||
		!reflect.DeepEqual(sparse.Run.Waves[0].NodeIDs, []string{"b", "a"}) ||
		sparse.Run.Waves[1].Index != 2 || !reflect.DeepEqual(sparse.Run.Waves[1].NodeIDs, []string{"c"}) {
		t.Fatalf("sparse waves = %+v, want lanes 0:[b a] and 2:[c]", sparse.Run.Waves)
	}

	safeMax, err := parseCompleteDag(waveTestCheckpoint(t,
		`[{"index":9007199254740991,"nodeIds":["b","a","c"]}]`))
	if err != nil {
		t.Fatal(err)
	}
	if len(safeMax.Run.Waves) != 1 || safeMax.Run.Waves[0].Index != 9007199254740991 ||
		!reflect.DeepEqual(safeMax.Run.Waves[0].NodeIDs, []string{"b", "a", "c"}) {
		t.Fatalf("safe-max waves = %+v, want one lane 9007199254740991:[b a c]", safeMax.Run.Waves)
	}
}
