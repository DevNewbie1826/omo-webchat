package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestGeneratorsFailClosed(t *testing.T) {
	tests := []struct {
		name, definition, want string
	}{
		{"oneOf misuse", `{"oneOf":[{"type":"string"},{"type":"integer"}]}`, "oneOf"},
		{"dangling unused ref", `{"$ref":"#/$defs/DoesNotExist"}`, "ref"},
		{"ref with semantic sibling", `{"$ref":"#/$defs/JsonValue","type":"string"}`, "$ref sibling"},
		{"properties on scalar", `{"type":"string","properties":{"x":{"type":"string"}}}`, "properties require object"},
		{"array without items", `{"type":"array"}`, "array type requires items"},
		{"conflicting enum type", `{"type":"integer","enum":["one"]}`, "enum"},
	}
	generators := []struct {
		name string
		args []string
		out  string
	}{
		{"go", []string{"go", "run", "gen_go.go"}, "OMO_CONTRACT_GO_OUT"},
		{"typescript", []string{"node", "gen_ts.mjs"}, "OMO_CONTRACT_TS_OUT"},
	}
	for _, tc := range tests {
		for _, generator := range generators {
			t.Run(tc.name+"/"+generator.name, func(t *testing.T) {
				if _, err := exec.LookPath(generator.args[0]); err != nil {
					if errors.Is(err, exec.ErrNotFound) {
						t.Skipf("generator %q not found in PATH; cannot exercise %s fail-closed checks: %v", generator.args[0], generator.name, err)
					}
					t.Fatalf("generator %q lookup failed: %v", generator.args[0], err)
				}
				dir := copySchemas(t)
				path := filepath.Join(dir, "shared-types.json")
				raw, err := os.ReadFile(path)
				if err != nil {
					t.Fatal(err)
				}
				replacement := `"$defs": {` + "\n    \"UnusedMalformed\": " + tc.definition + ","
				raw = bytes.Replace(raw, []byte(`"$defs": {`), []byte(replacement), 1)
				if err := os.WriteFile(path, raw, 0o600); err != nil {
					t.Fatal(err)
				}
				cmd := exec.Command(generator.args[0], generator.args[1:]...)
				cmd.Env = append(os.Environ(), "OMO_CONTRACT_SCHEMAS="+dir, generator.out+"="+filepath.Join(t.TempDir(), "generated"))
				output, err := cmd.CombinedOutput()
				if err == nil {
					t.Fatalf("generator accepted unsupported schema:\n%s", output)
				}
				if !strings.Contains(string(output), tc.want) {
					t.Fatalf("failure did not name %q:\n%s", tc.want, output)
				}
			})
		}
	}
}

func TestLiveSchemaContainsOnlyRenderedActivity(t *testing.T) {
	// Given the machine-consumed source of both generated contracts.
	data, err := os.ReadFile("schemas/server-frames.json")
	if err != nil {
		t.Fatal(err)
	}
	var schema struct {
		Defs map[string]struct {
			Properties map[string]json.RawMessage `json:"properties"`
		} `json:"$defs"`
	}
	// When its live-frame definition is parsed.
	if err := json.Unmarshal(data, &schema); err != nil {
		t.Fatal(err)
	}
	properties := schema.Defs["SessionsActivityFrame"].Properties
	// Then raw payloads cannot re-enter the generated live DTO.
	for _, key := range []string{"snapshots", "taskDigest", "dagDigest", "task", "dag", "task_digest", "dag_digest"} {
		if _, exists := properties[key]; exists {
			t.Errorf("live schema retains %s", key)
		}
	}
	for _, key := range []string{"id", "title", "active", "last_activity_ms", "running", "done", "dag_done", "dag_total", "truncated", "last_line"} {
		if _, exists := properties[key]; !exists {
			t.Errorf("live schema lacks %s", key)
		}
	}
}

func copySchemas(t *testing.T) string {
	t.Helper()
	dst := t.TempDir()
	entries, err := os.ReadDir("schemas")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		raw, err := os.ReadFile(filepath.Join("schemas", entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dst, entry.Name()), raw, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return dst
}
