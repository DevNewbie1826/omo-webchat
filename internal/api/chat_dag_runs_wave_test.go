package api

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// A malformed optional wave hint must degrade to the computed layout on both
// real surfaces — the run detail and the owned catalog — instead of failing
// the checkpoint (which would hide every other owned run too).
func TestChatDagRunMalformedWaveHintsKeepSurfaces(t *testing.T) {
	malformed := []string{
		`{"index":0,"nodeIds":["b","a","c"]}`,
		`[{"index":"0","nodeIds":["b","a","c"]}]`,
		`[{"index":0.5,"nodeIds":["b","a","c"]}]`,
		`[{"index":0,"nodeIds":["b",2,"c"]}]`,
	}
	for _, waves := range malformed {
		f := newDagHTTPFixture(t)
		writeDagFixture(t, filepath.Join(f.dir, "checkpoint-wave-bad.json"), waveOrderFixtureRun("wave-bad", waves))
		doc := decodeDagDocument(t, f.get(t, "/wave-bad"))
		if len(doc.Run.Waves) != 1 || doc.Run.Waves[0].Index != 0 ||
			!reflect.DeepEqual(doc.Run.Waves[0].NodeIDs, []string{"a", "b", "c"}) {
			t.Fatalf("waves %s: detail waves = %+v, want computed [{0 [a b c]}]", waves, doc.Run.Waves)
		}
		rec := f.get(t, "")
		if rec.Code != http.StatusOK {
			t.Fatalf("waves %s: catalog status = %d, want 200; body=%s", waves, rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), "wave-bad") {
			t.Fatalf("waves %s: catalog omits the run; body=%s", waves, rec.Body.String())
		}
	}
}

func waveOrderFixtureRun(id, waves string) map[string]any {
	defs := []map[string]any{
		{"id": "b", "label": "label-b", "prompt": "prompt-b", "dependsOn": []string{}},
		{"id": "a", "label": "label-a", "prompt": "prompt-a", "dependsOn": []string{}},
		{"id": "c", "label": "label-c", "prompt": "prompt-c", "dependsOn": []string{}},
	}
	nodes := []map[string]any{
		{"id": "b", "state": "running"},
		{"id": "a", "state": "pending"},
		{"id": "c", "state": "pending"},
	}
	return map[string]any{
		"runId": id, "runKey": "key-" + id, "name": "name-" + id, "status": "running",
		"parentSessionId": "parent",
		"createdAt":       "2026-09-10T10:00:00.123456789+09:00", "updatedAt": "2026-09-10T11:00:00.987654321+09:00",
		"definition": map[string]any{"nodes": defs}, "nodes": nodes,
		"waves": json.RawMessage(waves),
	}
}

func TestChatDagRunServesStoredWaveOrder(t *testing.T) {
	f := newDagHTTPFixture(t)
	writeDagFixture(t, filepath.Join(f.dir, "checkpoint-wave-order.json"),
		waveOrderFixtureRun("wave-order", `[{"index":0,"nodeIds":["b","a"]},{"index":1,"nodeIds":["c"]}]`))
	want := [][]string{{"b", "a"}, {"c"}}
	for attempt := 0; attempt < 2; attempt++ {
		doc := decodeDagDocument(t, f.get(t, "/wave-order"))
		if len(doc.Run.Waves) != len(want) {
			t.Fatalf("attempt %d: waves = %+v, want %v lanes", attempt, doc.Run.Waves, want)
		}
		for index, wave := range doc.Run.Waves {
			if wave.Index != index || !reflect.DeepEqual(wave.NodeIDs, want[index]) {
				t.Fatalf("attempt %d: wave %d = %+v, want index %d ids %v", attempt, index, wave, index, want[index])
			}
		}
	}
}
