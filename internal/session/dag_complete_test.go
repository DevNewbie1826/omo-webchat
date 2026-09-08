package session

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestDagCompleteParserPreservesOptionalMetadata(t *testing.T) {
	// Given: source contract permits roots without dependsOn, empty prompts,
	// absent clocks/attempts, and definition order independent of runtime order.
	data := []byte(`{"runId":"r","status":"running","definition":{"nodes":[{"id":"b","prompt":"b","dependsOn":["a"]},{"id":"a","prompt":""}]},"nodes":[{"id":"a","state":"pending"},{"id":"b","state":"running","attempt":0}]}`)
	doc, err := parseCompleteDag(data)
	if err != nil {
		t.Fatal(err)
	}
	if len(doc.Run.Nodes) != 2 || doc.Run.Nodes[0].Prompt != "" || doc.Run.Nodes[0].DependsOn == nil || doc.Run.Nodes[0].Attempt != nil || doc.Run.Nodes[1].Attempt == nil || *doc.Run.Nodes[1].Attempt != 0 {
		t.Fatalf("optional fields changed: %+v", doc.Run.Nodes)
	}
	if doc.Run.CreatedAt != "" || doc.Run.UpdatedAt != "" || !reflect.DeepEqual(doc.Run.Nodes[1].DependsOn, []string{"a"}) {
		t.Fatal("metadata/topology changed")
	}
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	var wire struct {
		Run struct {
			Nodes []map[string]json.RawMessage `json:"nodes"`
		} `json:"run"`
	}
	if err := json.Unmarshal(raw, &wire); err != nil {
		t.Fatal(err)
	}
	if _, present := wire.Run.Nodes[0]["attempt"]; present {
		t.Fatal("missing attempt invented")
	}
	if string(wire.Run.Nodes[1]["attempt"]) != "0" {
		t.Fatal("zero attempt omitted")
	}
}

func TestDagCompleteCancelledEmptyCatalog(t *testing.T) {
	cwd := t.TempDir()
	if err := os.MkdirAll(filepath.Join(cwd, ".omo", "senpi-task", "dag", "runs"), 0700); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	_, err := ReadDagCatalog(ctx, cwd, "parent")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled read error=%v want context.Canceled", err)
	}
}
