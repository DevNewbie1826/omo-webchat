package chat

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func readRPCLogLines(t *testing.T, path string) []string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read rpc log: %v", err)
	}
	text := strings.TrimSpace(string(b))
	if text == "" {
		return nil
	}
	return strings.Split(text, "\n")
}

func TestSessionProviderRPCNames(t *testing.T) {
	logFile := filepath.Join(t.TempDir(), "rpc.log")
	s, w := startMockSession(t, "chat-omo",
		"MOCK_PI_LOG="+logFile,
	)
	t.Cleanup(func() {
		if err := s.Close(); err != nil {
			t.Errorf("close session: %v", err)
		}
	})

	if err := s.QueryCommands(); err != nil {
		t.Fatalf("query commands: %v", err)
	}
	if err := s.Resume("since-1"); err != nil {
		t.Fatalf("resume: %v", err)
	}

	w.waitForType(t, "commands", 5*time.Second)
	w.waitForType(t, "entries", 5*time.Second)

	got := readRPCLogLines(t, logFile)
	want := []string{"get_commands", "get_entries"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("rpc log = %v, want %v", got, want)
	}
}

func TestSessionResponseCommandsNormalizeCommandsFrame(t *testing.T) {
	w := newCollectWriter()
	s := newTestSession("chat-1", w)
	raw := []byte(`{"type":"response","command":"get_commands","success":true,"data":{"commands":[{"name":"/model","description":"change model","source":"prompt"}]}}`)
	s.forwardResponse(raw)

	frames := w.waitForType(t, "commands", 2*time.Second)
	var got CommandsFrame
	for _, f := range frames {
		if json.Unmarshal(f, &got) == nil && got.Type == "commands" {
			break
		}
	}
	if len(got.Commands) != 1 || got.Commands[0].Name != "/model" || got.Commands[0].Description != "change model" || got.Commands[0].Source != "prompt" {
		t.Fatalf("commands frame = %+v", got)
	}
}

func TestSessionResponseHistoryNormalizeEntriesFrame(t *testing.T) {
	w := newCollectWriter()
	s := newTestSession("chat-1", w)
	raw := []byte(`{"type":"response","command":"get_entries","success":true,"data":{"entries":[{"role":"user","content":"hi"}],"leafId":"leaf-1"}}`)
	s.forwardResponse(raw)

	frames := w.waitForType(t, "entries", 2*time.Second)
	var got EntriesFrame
	for _, f := range frames {
		if json.Unmarshal(f, &got) == nil && got.Type == "entries" {
			break
		}
	}
	if string(got.Entries) != `[{"role":"user","content":"hi"}]` {
		t.Fatalf("entries frame = %s, want %s", string(got.Entries), `[{"role":"user","content":"hi"}]`)
	}
	if got.LeafID != "leaf-1" {
		t.Fatalf("leaf id = %q, want leaf-1", got.LeafID)
	}
}
