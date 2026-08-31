package chat

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"
)

// commands_changed carries the authoritative command inventory and forwards
// it directly without issuing a second get_commands RPC.
func TestCommandsChangedForwardsProviderInventory(t *testing.T) {
	logFile := t.TempDir() + "/rpc.log"
	s, w := startMockSession(t, "chat-commands-changed", "MOCK_PI_LOG="+logFile)
	t.Cleanup(func() {
		if err := s.Close(); err != nil {
			t.Errorf("close session: %v", err)
		}
	})

	if err := s.QueryCommands(); err != nil {
		t.Fatalf("query commands: %v", err)
	}
	frames := w.waitForType(t, "commands", 5*time.Second)
	var initial CommandsFrame
	for _, f := range frames {
		_ = json.Unmarshal(f, &initial)
	}
	if len(initial.Commands) != 2 {
		t.Fatalf("initial commands = %d, want the 2-entry default inventory; frames: %s", len(initial.Commands), w.typesString())
	}

	if err := s.proc.Send(map[string]any{"type": "mock_commands_changed", "count": 3, "id": "chg-1"}); err != nil {
		t.Fatalf("invalidate commands: %v", err)
	}
	changed := w.waitFor(t, 5*time.Second, "refreshed commands frame", func(frames [][]byte) bool {
		for _, f := range frames {
			var frame CommandsFrame
			if json.Unmarshal(f, &frame) == nil && len(frame.Commands) == 3 {
				return true
			}
		}
		return false
	})
	var refreshed CommandsFrame
	sawRefreshed := false
	for _, f := range changed {
		var frame CommandsFrame
		if json.Unmarshal(f, &frame) == nil && len(frame.Commands) == 3 {
			refreshed = frame
			sawRefreshed = true
		}
	}
	if !sawRefreshed {
		t.Fatalf("no refreshed commands frame; frames: %s", w.typesString())
	}
	wantNames := []string{"command-01", "command-02", "command-03"}
	gotNames := make([]string, 0, len(refreshed.Commands))
	for _, command := range refreshed.Commands {
		gotNames = append(gotNames, command.Name)
	}
	if !reflect.DeepEqual(gotNames, wantNames) {
		t.Fatalf("refreshed command names = %v, want %v", gotNames, wantNames)
	}

	wantLog := []string{"get_commands", "mock_commands_changed"}
	if got := readRPCLogLines(t, logFile); !reflect.DeepEqual(got, wantLog) {
		t.Fatalf("rpc log = %v, want commands_changed without a get_commands re-query (%v)", got, wantLog)
	}
}

// The get_commands response is forwarded with Omo's real schema —
// {name, description, source, syntax, sourceInfo{path,source,scope,origin}} —
// and the legacy fake location field is gone.
func TestCommandsFrameCarriesRealOmoSchema(t *testing.T) {
	writer := newCollectWriter()
	s := newTestSession("chat-commands-schema", writer)

	s.forwardResponse([]byte(`{
		"type": "response",
		"command": "get_commands",
		"success": true,
		"data": {"commands": [
			{"name":"hooks","description":"Inspect loaded builtin hook sources and diagnostics.","sourceInfo":{"path":"<builtin:hooks>","baseDir":"/tmp/omo","source":"builtin","scope":"temporary","origin":"top-level"},"source":"extension","syntax":"slash"},
			{"name":"skill:demo","description":"Demo skill","sourceInfo":{"path":"<skill:demo>","source":"cli","scope":"temporary","origin":"top-level"},"source":"skill","syntax":"dollar"}
		]}
	}`))

	frames := writer.snapshot()
	if len(frames) != 1 {
		t.Fatalf("frames = %d, want 1; frames: %s", len(frames), writer.typesString())
	}
	if strings.Contains(string(frames[0]), "location") {
		t.Fatalf("commands frame still carries the fake location field: %s", frames[0])
	}
	var frame CommandsFrame
	if err := json.Unmarshal(frames[0], &frame); err != nil {
		t.Fatalf("unmarshal commands frame: %v", err)
	}
	if len(frame.Commands) != 2 {
		t.Fatalf("commands = %d, want 2", len(frame.Commands))
	}
	want := []CommandEntry{
		{
			Name:        "hooks",
			Description: "Inspect loaded builtin hook sources and diagnostics.",
			Source:      "extension",
			Syntax:      "slash",
			SourceInfo:  &CommandSourceInfo{Path: "<builtin:hooks>", BaseDir: "/tmp/omo", Source: "builtin", Scope: "temporary", Origin: "top-level"},
		},
		{
			Name:        "skill:demo",
			Description: "Demo skill",
			Source:      "skill",
			Syntax:      "dollar",
			SourceInfo:  &CommandSourceInfo{Path: "<skill:demo>", Source: "cli", Scope: "temporary", Origin: "top-level"},
		},
	}
	if !reflect.DeepEqual(frame.Commands, want) {
		t.Fatalf("commands = %+v, want %+v", frame.Commands, want)
	}
}

// The mock's get_commands already speaks the real schema; the backend must
// pass it through losslessly end to end.
func TestMockCommandsPassThroughRealSchema(t *testing.T) {
	s, w := startMockSession(t, "chat-commands-mock")
	t.Cleanup(func() {
		if err := s.Close(); err != nil {
			t.Errorf("close session: %v", err)
		}
	})
	if err := s.QueryCommands(); err != nil {
		t.Fatalf("query commands: %v", err)
	}
	frames := w.waitForType(t, "commands", 5*time.Second)
	if strings.Contains(string(frames[len(frames)-1]), "location") {
		t.Fatalf("commands frame carries the fake location field: %s", frames[len(frames)-1])
	}
	var frame CommandsFrame
	for _, f := range frames {
		_ = json.Unmarshal(f, &frame)
	}
	if len(frame.Commands) == 0 {
		t.Fatalf("no commands forwarded; frames: %s", w.typesString())
	}
	var fix CommandEntry
	for _, command := range frame.Commands {
		if command.Name == "fix-tests" {
			fix = command
		}
	}
	if fix.Name != "fix-tests" {
		t.Fatalf("fix-tests command missing: %+v", frame.Commands)
	}
	if fix.Source != "extension" || fix.Syntax != "slash" {
		t.Fatalf("fix-tests source/syntax = %q/%q, want extension/slash", fix.Source, fix.Syntax)
	}
	if fix.SourceInfo == nil || fix.SourceInfo.Path != "<builtin:mock>" || fix.SourceInfo.Source != "cli" {
		t.Fatalf("fix-tests sourceInfo = %+v, want path <builtin:mock> source cli", fix.SourceInfo)
	}
}
