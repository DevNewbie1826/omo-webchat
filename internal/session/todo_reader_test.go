package session

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
)

type todoReadResult struct {
	projection TodoProjection
	err        error
}

// Hold at the actual RPC wire boundary, then send the chosen response before
// releasing the daemon handler. Every negative assertion follows completion.
func heldTodoRead(t *testing.T, s *Session, d *omorpctest.Daemon, data map[string]any, change func()) todoReadResult {
	t.Helper()
	release := d.BlockHandler(omorpc.CmdGetEntries)
	defer release()
	ctx, cancel := context.WithTimeout(t.Context(), testTimeout)
	defer cancel()
	count := d.RequestCount(omorpc.CmdGetEntries)
	done := make(chan todoReadResult, 1)
	go func() { p, err := s.ReadTodoProjection(ctx); done <- todoReadResult{p, err} }()
	if !d.AwaitRequestCount(omorpc.CmdGetEntries, count+1, testTimeout) {
		t.Fatal("no suffix request")
	}
	req := d.LastRequest(omorpc.CmdGetEntries)
	route := s.RoutingID()
	if change != nil {
		change()
	}
	raw, err := json.Marshal(map[string]any{"id": req["id"], "type": "response", "command": "get_entries", "sessionId": route, "success": true, "data": data})
	if err != nil {
		t.Fatal(err)
	}
	d.WriteRaw(append(raw, '\n'))
	select {
	case result := <-done:
		return result
	case <-ctx.Done():
		t.Fatal("read did not complete")
		return todoReadResult{}
	}
}

func TestTodoAuthorityResidentTailSelection(t *testing.T) {
	for _, leaf := range []string{"new", "old", "root"} {
		t.Run(leaf, func(t *testing.T) {
			s, d := queueHistorySession(t, todoCustom("root", "", todoData("root", "pending"))+todoCustom("old", "root", todoData("old", "completed"))+queueEntry("disk-end", "root", "assistant", "branch"), false)
			got := heldTodoRead(t, s, d, map[string]any{"entries": []json.RawMessage{json.RawMessage(todoCustom("new", "old", todoData("new", "in_progress")))}, "leafId": leaf}, nil)
			if got.err != nil {
				t.Fatal(got.err)
			}
			if got.projection.Source.LeafID == nil || *got.projection.Source.LeafID != leaf || got.projection.Source.EntryID == nil || *got.projection.Source.EntryID != leaf {
				t.Fatalf("selection=%+v", got.projection)
			}
			want := map[string]int{"new": 2, "old": 1, "root": 0}[leaf]
			if got.projection.Source.EntryIndex == nil || *got.projection.Source.EntryIndex != want {
				t.Fatalf("branch index=%+v", got.projection.Source)
			}
			if d.LastRequest(omorpc.CmdGetEntries)["since"] != "disk-end" {
				t.Fatal("queried selected leaf instead of file-order end")
			}
		})
	}
}

func TestTodoAuthorityUnloadedPersistenceLag(t *testing.T) {
	s, d := queueHistorySession(t, todoCustom("a", "", todoData("old", "completed")), false)
	tail := todoCustom("clear", "a", `{"schema":"v2","phases":[]}`)
	end := queueEntry("end", "clear", "assistant", "after clear")
	live := heldTodoRead(t, s, d, map[string]any{"entries": []json.RawMessage{json.RawMessage(tail), json.RawMessage(end)}, "leafId": "clear"}, nil)
	if live.err != nil || live.projection.Phases == nil || len(live.projection.Phases) != 0 {
		t.Fatalf("live clear=%+v", live)
	}
	s.lifecycleMu.Lock()
	s.markProviderUnloadedLocked()
	s.lifecycleMu.Unlock()
	opens, reads := d.RequestCount(omorpc.CmdOpenSession), d.RequestCount(omorpc.CmdGetEntries)
	if _, err := s.ReadTodoProjection(t.Context()); err == nil {
		t.Fatal("older disk replaced resident clear")
	}
	appendTodoFixture(t, s.SessionFile(), tail)
	if _, err := s.ReadTodoProjection(t.Context()); err == nil {
		t.Fatal("selected leaf substituted for last file-order boundary")
	}
	appendTodoFixture(t, s.SessionFile(), end)
	disk, err := s.ReadTodoProjection(t.Context())
	if err != nil || disk.Phases == nil || len(disk.Phases) != 0 {
		t.Fatalf("persisted clear=%+v %v", disk, err)
	}
	if d.RequestCount(omorpc.CmdOpenSession) != opens || d.RequestCount(omorpc.CmdGetEntries) != reads {
		t.Fatal("persistence-lag read woke provider")
	}
}
func appendTodoFixture(t *testing.T, path, body string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString(body); err != nil {
		f.Close()
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestTodoAuthorityFinalFences(t *testing.T) {
	for _, kind := range []string{"epoch", "route", "path", "durable-id", "unloaded", "closed", "identity", "append"} {
		t.Run(kind, func(t *testing.T) {
			s, d := queueHistorySession(t, todoCustom("a", "", todoData("old", "pending")), false)
			result := heldTodoRead(t, s, d, map[string]any{"entries": []any{}, "leafId": "a"}, func() {
				s.lifecycleMu.Lock()
				defer s.lifecycleMu.Unlock()
				switch kind {
				case "epoch":
					s.epoch = omorpc.EpochToken{}
				case "route":
					s.routingID = "replacement"
				case "path":
					s.sessionFile += ".moved"
				case "durable-id":
					s.durableID = "replacement"
				case "unloaded":
					s.markProviderUnloadedLocked()
				case "closed":
					s.closed = true
				case "identity":
					body, err := os.ReadFile(s.sessionFile)
					if err != nil {
						t.Fatal(err)
					}
					if err := os.Rename(s.sessionFile, s.sessionFile+".old"); err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(s.sessionFile, body, 0600); err != nil {
						t.Fatal(err)
					}
				case "append":
					appendTodoFixture(t, s.sessionFile, queueEntry("b", "a", "assistant", "new"))
				}
			})
			if result.err == nil || result.projection.Source.Kind != "" {
				t.Fatalf("changed authority accepted=%+v", result)
			}
			if s.todoRead.boundary != "" {
				t.Fatal("failed read consumed durability boundary")
			}
		})
	}
}

func TestTodoAuthorityMalformedTail(t *testing.T) {
	for _, data := range []map[string]any{
		{"leafId": "a"}, {"entries": nil, "leafId": "a"}, {"entries": []any{}}, {"entries": []any{}, "leafId": false}, {"entries": []any{}, "leafId": "missing"},
		{"entries": []json.RawMessage{json.RawMessage(todoCustom("a", "", todoData("duplicate", "pending")))}, "leafId": "a"},
		{"entries": []json.RawMessage{json.RawMessage(todoCustom("b", "missing", todoData("broken", "pending")))}, "leafId": "b"},
	} {
		s, d := queueHistorySession(t, todoCustom("a", "", todoData("old", "pending")), false)
		result := heldTodoRead(t, s, d, data, nil)
		if result.err == nil {
			t.Fatalf("invalid tail accepted: %v", data)
		}
	}
}

func TestTodoProjectionBudgets(t *testing.T) {
	for _, body := range []string{
		todoCustom("a", "", todoData(strings.Repeat("x", maxActivitySnapshotBytes), "pending")),
		todoCustom("a", "", todoData("small", "pending")) + todoCustom("big", "a", todoData(strings.Repeat("x", maxActivitySnapshotBytes), "pending")),
		todoCustom("a", "", todoData(strings.Repeat("<", maxActivitySnapshotBytes/2), "pending")),
	} {
		s, _ := queueHistorySession(t, queueEntry("seed", "", "user", "seed"), false)
		appendTodoFixture(t, s.SessionFile(), body)
		s.lifecycleMu.Lock()
		s.markProviderUnloadedLocked()
		s.lifecycleMu.Unlock()
		_, err := s.ReadTodoProjection(t.Context())
		if TodoProjectionErrorCode(err) != "oversized" {
			t.Fatalf("oversized projection error=%v", err)
		}
	}
	if TodoProjectionErrorCode(omorpc.ErrFrameTooLarge) != "oversized" {
		t.Fatal("RPC body budget not classified")
	}
}

func TestTodoProjectionInvalidFieldsAndOptionalMetadata(t *testing.T) {
	for _, raw := range []string{`{"schema":"v2","phases":[{"name":null,"tasks":[]}]}`, `{"schema":"v2","phases":[{"name":"a","tasks":null}]}`, `{"schema":"v2","phases":[{"name":"a","tasks":[null]}]}`, `{"schema":"v2","phases":[{"name":"a","tasks":[{"content":null,"status":"pending"}]}]}`} {
		s, _ := queueHistorySession(t, todoCustom("a", "", raw), false)
		if _, err := s.ReadTodoProjection(t.Context()); !errors.Is(err, ErrInvalidTodoState) {
			t.Fatalf("invalid fields=%v", err)
		}
	}
	s, _ := queueHistorySession(t, todoLegacy("a", "", `{"phases":[],"completedTasks":false,"op":{},"storage":false}`), false)
	got, err := s.ReadTodoProjection(t.Context())
	if err != nil || got.Phases == nil || len(got.Phases) != 0 {
		t.Fatalf("optional metadata affected authority=%+v %v", got, err)
	}
}
