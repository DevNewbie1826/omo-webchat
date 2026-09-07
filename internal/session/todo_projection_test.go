package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func readTodoReceipt(t *testing.T, s *Session) (TodoProjection, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), testTimeout)
	defer cancel()
	return s.ReadTodoProjection(ctx)
}

func todoCustom(id, parent, data string) string {
	var p any
	if parent != "" {
		p = parent
	}
	return fmt.Sprintf("{\"type\":\"custom\",\"id\":%q,\"parentId\":%s,\"customType\":\"senpi.todo-state\",\"data\":%s}\n", id, mustTodoJSON(p), data)
}
func mustTodoJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return string(b)
}
func todoData(name, status string) string {
	return fmt.Sprintf(`{"schema":"v2","phases":[{"name":%q,"tasks":[{"content":"검증","status":%q}]}]}`, name, status)
}
func todoLegacy(id, parent, data string) string {
	return fmt.Sprintf("{\"type\":\"message\",\"id\":%q,\"parentId\":%q,\"message\":{\"role\":\"toolResult\",\"toolName\":\"todo\",\"details\":%s}}\n", id, parent, data)
}

func TestTodoProjectionAuthority(t *testing.T) {
	a, b := todoData("old", "pending"), todoData("new", "completed")
	for _, tc := range []struct {
		name, body, kind, entry, phase, status string
		empty, absent, invalid, diagnostic     bool
	}{
		{name: "custom-only", body: todoCustom("a", "", a), kind: "custom", entry: "a", phase: "old", status: "pending"},
		{name: "delayed-tool-result", body: todoCustom("a", "", a) + todoCustom("b", "a", b) + todoLegacy("late", "b", a), kind: "custom", entry: "b", phase: "new", status: "completed"},
		{name: "branch-fork", body: todoCustom("a", "", a) + todoCustom("b", "a", b) + queueEntry("selected", "a", "assistant", "fork"), kind: "custom", entry: "a", phase: "old", status: "pending"},
		{name: "explicit-clear", body: todoCustom("a", "", a) + todoCustom("clear", "a", `{"schema":"v2","phases":[]}`), kind: "custom", entry: "clear", empty: true},
		{name: "named-empty", body: todoCustom("a", "", `{"schema":"v2","phases":[{"name":"empty","tasks":[]}]}`), kind: "custom", entry: "a", phase: "empty"},
		{name: "absent", body: queueEntry("root", "", "user", "hello"), kind: "absent", absent: true},
		{name: "legacy-completion-array", body: todoLegacy("a", "", `{"phases":[{"name":"legacy","tasks":[]}],"completedTasks":[{"phase":"legacy","content":"done"}]}`), kind: "legacy-tool", entry: "a", phase: "legacy"},
		{name: "legacy-tool-result", body: todoLegacy("a", "", todoData("legacy", "in_progress")), kind: "legacy-tool", entry: "a", phase: "legacy", status: "in_progress"},
		{name: "legacy-bare-tool", body: fmt.Sprintf("{\"type\":\"tool\",\"id\":\"a\",\"parentId\":null,\"toolName\":\"todo\",\"result\":{\"details\":%s}}\n", b), kind: "legacy-tool", entry: "a", phase: "new", status: "completed"},
		{name: "invalid-custom-blocks-legacy", body: todoCustom("a", "", `{"schema":"v2","phases":[{}]}`) + todoLegacy("b", "a", b), invalid: true},
		{name: "unsupported-custom", body: todoCustom("a", "", `{"schema":"v3","phases":[]}`), invalid: true},
		{name: "later-invalid-retains-valid", body: todoCustom("a", "", a) + todoCustom("bad", "a", `{"schema":"v2","phases":[{}]}`), kind: "custom", entry: "a", phase: "old", status: "pending", diagnostic: true},
		{name: "malformed-task-atomic", body: todoCustom("bad", "", `{"schema":"v2","phases":[{"name":"valid","tasks":[]},{"name":"bad","tasks":[{}]}]}`), invalid: true},
		{name: "null-phases", body: todoCustom("bad", "", `{"schema":"v2","phases":null}`), invalid: true},
		{name: "invalid-legacy-not-absent", body: todoLegacy("bad", "", `{"phases":[{}]}`), invalid: true},
		{name: "compaction-cannot-revive-clear", body: todoCustom("a", "", a) + todoCustom("clear", "a", `{"schema":"v2","phases":[]}`) + `{"type":"compaction","id":"backup","parentId":"clear","details":{"capturedAt":"2099-01-01T00:00:00Z","todo":{"phases":[{"name":"old","tasks":[]}]}}}` + "\n", kind: "custom", entry: "clear", empty: true},
		{name: "intentional-reopen", body: todoCustom("a", "", b) + todoCustom("b", "a", todoData("reopened", "in_progress")), kind: "custom", entry: "b", phase: "reopened", status: "in_progress"},
		{name: "whole-list-replacement", body: todoCustom("a", "", a) + todoCustom("b", "a", todoData("renamed", "abandoned")), kind: "custom", entry: "b", phase: "renamed", status: "abandoned"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, _ := queueHistorySession(t, tc.body, false)
			got, err := readTodoReceipt(t, s)
			if tc.invalid {
				if err == nil {
					t.Fatalf("invalid state accepted: %+v", got)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got.Source.Kind != tc.kind {
				t.Fatalf("source=%+v", got.Source)
			}
			if tc.absent {
				if got.Phases != nil || got.Source.EntryID != nil || got.Source.EntryIndex != nil {
					t.Fatalf("absent=%+v", got)
				}
				return
			}
			if got.Source.EntryID == nil || *got.Source.EntryID != tc.entry {
				t.Fatalf("source=%+v", got.Source)
			}
			if tc.empty {
				if got.Phases == nil || len(got.Phases) != 0 {
					t.Fatalf("clear=%+v", got)
				}
				return
			}
			if len(got.Phases) != 1 || got.Phases[0].Name != tc.phase {
				t.Fatalf("phases=%+v", got.Phases)
			}
			if tc.status != "" && (len(got.Phases[0].Tasks) != 1 || got.Phases[0].Tasks[0].Status != tc.status || got.Phases[0].Tasks[0].Content != "검증") {
				t.Fatalf("tasks=%+v", got.Phases[0].Tasks)
			}
			if tc.diagnostic && len(got.Diagnostics) == 0 {
				t.Fatal("invalid carrier diagnostic lost")
			}
		})
	}
}

func TestTodoAuthorityUnloadedDiskOnly(t *testing.T) {
	s, d := queueHistorySession(t, todoCustom("a", "", todoData("disk", "pending")), false)
	s.lifecycleMu.Lock()
	s.markProviderUnloadedLocked()
	s.lifecycleMu.Unlock()
	opens, reads := d.RequestCount(omorpc.CmdOpenSession), d.RequestCount(omorpc.CmdGetEntries)
	got, err := readTodoReceipt(t, s)
	if err != nil || got.Source.EntryID == nil || *got.Source.EntryID != "a" {
		t.Fatalf("disk-only=%+v %v", got, err)
	}
	if d.RequestCount(omorpc.CmdOpenSession) != opens || d.RequestCount(omorpc.CmdGetEntries) != reads {
		t.Fatal("unloaded read touched provider")
	}
}

func TestTodoAuthorityDiskFailures(t *testing.T) {
	for _, kind := range []string{"missing", "identity", "torn", "oversized", "duplicate", "broken"} {
		t.Run(kind, func(t *testing.T) {
			s, d := queueHistorySession(t, todoCustom("a", "", todoData("disk", "pending")), false)
			body, err := os.ReadFile(s.SessionFile())
			if err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "missing":
				err = os.Remove(s.SessionFile())
			case "identity":
				body = []byte(strings.Replace(string(body), "queue-durable", "wrong-durable", 1))
			case "torn":
				body = append(body, []byte(`{"type":`)...)
			case "oversized":
				body = append(body, []byte(queueEntry("giant", "a", "assistant", strings.Repeat("x", 4<<20)))...)
			case "duplicate":
				body = append(body, []byte(todoCustom("a", "", todoData("duplicate", "completed")))...)
			case "broken":
				body = append(body, []byte(todoCustom("b", "missing", todoData("broken", "completed")))...)
			}
			if err != nil {
				t.Fatal(err)
			}
			if kind != "missing" {
				if err := os.WriteFile(s.SessionFile(), body, 0600); err != nil {
					t.Fatal(err)
				}
			}
			before := d.RequestCount(omorpc.CmdGetEntries)
			_, err = readTodoReceipt(t, s)
			if err == nil {
				t.Fatal("failed history supplied a projection")
			}
			if d.RequestCount(omorpc.CmdGetEntries) != before {
				t.Fatal("invalid disk fell back to provider")
			}
		})
	}
}

func TestTodoAuthorityOldEpoch(t *testing.T) {
	s, d := queueHistorySession(t, todoCustom("a", "", todoData("a", "pending")), false)
	s.lifecycleMu.Lock()
	s.epoch = omorpc.EpochToken{}
	s.lifecycleMu.Unlock()
	before := d.RequestCount(omorpc.CmdGetEntries)
	_, err := readTodoReceipt(t, s)
	if !errors.Is(err, omorpc.ErrEpochMismatch) {
		t.Fatalf("old epoch=%v", err)
	}
	if d.RequestCount(omorpc.CmdGetEntries) != before {
		t.Fatal("old epoch sent request")
	}
}
