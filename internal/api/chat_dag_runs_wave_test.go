package api

import (
	"path/filepath"
	"reflect"
	"testing"
)

func waveOrderFixtureRun(id string) map[string]any {
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
		"waves": []map[string]any{
			{"index": 0, "nodeIds": []string{"b", "a"}},
			{"index": 1, "nodeIds": []string{"c"}},
		},
	}
}

func TestChatDagRunServesStoredWaveOrder(t *testing.T) {
	f := newDagHTTPFixture(t)
	writeDagFixture(t, filepath.Join(f.dir, "checkpoint-wave-order.json"), waveOrderFixtureRun("wave-order"))
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
