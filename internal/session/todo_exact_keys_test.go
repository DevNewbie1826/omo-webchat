package session

import (
	"errors"
	"fmt"
	"reflect"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func todoExactKeyCarriers() []struct {
	name   string
	custom bool
	encode func(string, string, string) string
} {
	return []struct {
		name   string
		custom bool
		encode func(string, string, string) string
	}{
		{"custom", true, todoCustom},
		{"legacy-message", false, todoLegacy},
		{"legacy-bare", false, func(id, parent, data string) string {
			return fmt.Sprintf("{\"type\":\"tool\",\"id\":%q,\"parentId\":%q,\"toolName\":\"todo\",\"result\":{\"details\":%s}}\n", id, parent, data)
		}},
	}
}

func TestTodoProjectionExactKeysRejectMalformed(t *testing.T) {
	for _, carrier := range todoExactKeyCarriers() {
		for _, tc := range []struct {
			name, data string
			schema     bool
		}{
			{"missing-phases", `{"schema":"v2","Phases":[]}`, false},
			{"missing-tasks", `{"schema":"v2","phases":[{"name":"bad","Tasks":[]}]}`, false},
			{"missing-name", `{"schema":"v2","phases":[{"Name":"bad","tasks":[]}]}`, false},
			{"missing-content", `{"schema":"v2","phases":[{"name":"bad","tasks":[{"Content":"replacement","status":"pending"}]}]}`, false},
			{"missing-status", `{"schema":"v2","phases":[{"name":"bad","tasks":[{"content":"replacement","Status":"pending"}]}]}`, false},
			{"absent-phases", `{"schema":"v2"}`, false},
			{"absent-tasks", `{"schema":"v2","phases":[{"name":"bad"}]}`, false},
			{"absent-name", `{"schema":"v2","phases":[{"tasks":[]}]}`, false},
			{"absent-content", `{"schema":"v2","phases":[{"name":"bad","tasks":[{"status":"pending"}]}]}`, false},
			{"absent-status", `{"schema":"v2","phases":[{"name":"bad","tasks":[{"content":"replacement"}]}]}`, false},
			{"atomic-phase", `{"schema":"v2","phases":[{"name":"valid","tasks":[]},{"Name":"bad","tasks":[]}]}`, false},
			{"atomic-task", `{"schema":"v2","phases":[{"name":"valid","tasks":[{"content":"valid","status":"completed"},{"content":"bad","Status":"pending"}]}]}`, false},
			{"schema-titlecase", `{"Schema":"v2","phases":[]}`, true},
			{"schema-uppercase", `{"SCHEMA":"v2","phases":[]}`, true},
			{"schema-absent", `{"phases":[]}`, true},
			{"schema-null", `{"schema":null,"phases":[]}`, true},
			{"schema-number", `{"schema":2,"phases":[]}`, true},
			{"schema-version", `{"schema":"v3","phases":[]}`, true},
			{"schema-value-case", `{"schema":"V2","phases":[]}`, true},
			{"schema-exact-invalid-lookalike-valid", `{"schema":"v3","Schema":"v2","phases":[]}`, true},
		} {
			if tc.schema && !carrier.custom {
				continue // Legacy results have no required schema.
			}
			for _, history := range []string{"retain", "only", "legacy-before", "legacy-after"} {
				if !carrier.custom && (history == "legacy-before" || history == "legacy-after") {
					continue
				}
				t.Run(carrier.name+"/"+tc.name+"/"+history, func(t *testing.T) {
					// Given a complete selected branch with a malformed carrier.
					body := queueEntry("root", "", "user", "synthetic root")
					parent := "root"
					if history == "retain" {
						body += carrier.encode("incumbent", parent, todoData("keep", "completed"))
						parent = "incumbent"
					} else if history == "legacy-before" {
						body += todoLegacy("fallback", parent, todoData("fallback", "pending"))
						parent = "fallback"
					}
					body += carrier.encode("malformed", parent, tc.data)
					if history == "legacy-after" {
						body += todoLegacy("fallback", "malformed", todoData("fallback", "pending"))
					}
					s, d := queueHistorySession(t, body, false)
					s.lifecycleMu.Lock()
					s.markProviderUnloadedLocked()
					s.lifecycleMu.Unlock()
					reads, opens := d.RequestCount(omorpc.CmdGetEntries), d.RequestCount(omorpc.CmdOpenSession)
					// When the active canonical reader folds the disk branch.
					got, err := readTodoReceipt(t, s)
					// Then invalid input never gains replacement or absence authority.
					if history == "retain" {
						kind := "legacy-tool"
						if carrier.custom {
							kind = "custom"
						}
						want := []TodoPhase{{Name: "keep", Tasks: []TodoTask{{Content: "검증", Status: "completed"}}}}
						if err != nil || got.Source.Kind != kind || got.Source.EntryID == nil || *got.Source.EntryID != "incumbent" || !reflect.DeepEqual(got.Phases, want) {
							t.Errorf("malformed required keys replaced incumbent: payload=%s projection=%+v err=%v", tc.data, got, err)
						}
						if !reflect.DeepEqual(got.Diagnostics, []string{"invalid-carrier"}) {
							t.Errorf("missing invalid-carrier diagnostic: %+v", got.Diagnostics)
						}
					} else if !errors.Is(err, ErrInvalidTodoState) || TodoProjectionErrorCode(err) != "invalid-state" || !reflect.DeepEqual(got, TodoProjection{}) {
						t.Errorf("malformed-only carrier gained authority: projection=%+v err=%v", got, err)
					}
					if d.RequestCount(omorpc.CmdGetEntries) != reads || d.RequestCount(omorpc.CmdOpenSession) != opens {
						t.Error("disk-only reader touched provider")
					}
				})
			}
		}
	}
}

func TestTodoProjectionExactKeysIgnoreLookalikes(t *testing.T) {
	for _, carrier := range todoExactKeyCarriers() {
		for _, tc := range []struct{ name, data string }{
			{"schema-extra", `{"schema":"v2","Schema":"v3","phases":[{"name":"exact","tasks":[{"content":"exact","status":"in_progress"}]}]}`},
			{"phases-extra", `{"schema":"v2","phases":[{"name":"exact","tasks":[{"content":"exact","status":"in_progress"}]}],"Phases":[]}`},
			{"name-extra", `{"schema":"v2","phases":[{"name":"exact","Name":"wrong","tasks":[{"content":"exact","status":"in_progress"}]}]}`},
			{"tasks-extra", `{"schema":"v2","phases":[{"name":"exact","tasks":[{"content":"exact","status":"in_progress"}],"Tasks":[]}]}`},
			{"content-extra", `{"schema":"v2","phases":[{"name":"exact","tasks":[{"content":"exact","Content":"wrong","status":"in_progress"}]}]}`},
			{"status-extra", `{"schema":"v2","phases":[{"name":"exact","tasks":[{"content":"exact","status":"in_progress","Status":"completed"}]}]}`},
			{"extras-after", `{"schema":"v2","Schema":"v3","phases":[{"name":"exact","Name":"wrong","tasks":[{"content":"exact","Content":"wrong","status":"in_progress","Status":"completed"}],"Tasks":[]}],"Phases":[]}`},
			{"extras-before", `{"Schema":"v3","schema":"v2","Phases":[],"phases":[{"Name":"wrong","name":"exact","Tasks":[],"tasks":[{"Content":"wrong","content":"exact","Status":"completed","status":"in_progress"}]}]}`},
			{"invalid-extras", `{"schema":"v2","SCHEMA":false,"phases":[{"name":"exact","NAME":null,"tasks":[{"content":"exact","CONTENT":{},"status":"in_progress","STATUS":42}],"TASKS":false}],"PHASES":null}`},
		} {
			t.Run(carrier.name+"/"+tc.name, func(t *testing.T) {
				// Given valid exact fields alongside conflicting optional lookalikes.
				s, _ := queueHistorySession(t, queueEntry("root", "", "user", "root")+carrier.encode("exact", "root", tc.data), false)
				// When the resident canonical reader projects the list.
				got, err := readTodoReceipt(t, s)
				// Then only the exact fields contribute to authority.
				want := []TodoPhase{{Name: "exact", Tasks: []TodoTask{{Content: "exact", Status: "in_progress"}}}}
				if err != nil || got.Source.EntryID == nil || *got.Source.EntryID != "exact" || !reflect.DeepEqual(got.Phases, want) || len(got.Diagnostics) != 0 {
					t.Fatalf("lookalikes changed valid authority: %+v err=%v", got, err)
				}
			})
		}
	}
}

func TestTodoProjectionExactKeysPreserveValidStates(t *testing.T) {
	for _, carrier := range todoExactKeyCarriers() {
		for _, tc := range []struct {
			name, before, data string
			want               []TodoPhase
		}{
			{"clear", todoData("prior", "completed"), `{"schema":"v2","phases":[]}`, []TodoPhase{}},
			{"named-empty", todoData("prior", "completed"), `{"schema":"v2","phases":[{"name":"empty","tasks":[]}]}`, []TodoPhase{{Name: "empty", Tasks: []TodoTask{}}}},
			{"completion-array", todoData("prior", "pending"), `{"schema":"v2","phases":[{"name":"done","tasks":[{"content":"검증","status":"completed"}]}],"completedTasks":[{"phase":"done","content":"검증"}]}`, []TodoPhase{{Name: "done", Tasks: []TodoTask{{Content: "검증", Status: "completed"}}}}},
			{"invalid-optional-metadata", todoData("prior", "pending"), `{"schema":"v2","phases":[{"name":"done","tasks":[{"content":"검증","status":"completed"}]}],"completedTasks":false,"op":{},"storage":42,"other":[null]}`, []TodoPhase{{Name: "done", Tasks: []TodoTask{{Content: "검증", Status: "completed"}}}}},
			{"reopen", todoData("reopened", "completed"), todoData("reopened", "in_progress"), []TodoPhase{{Name: "reopened", Tasks: []TodoTask{{Content: "검증", Status: "in_progress"}}}}},
			{"init-after-clear", `{"schema":"v2","phases":[]}`, todoData("initialized", "pending"), []TodoPhase{{Name: "initialized", Tasks: []TodoTask{{Content: "검증", Status: "pending"}}}}},
			{"empty-strings", todoData("prior", "pending"), `{"schema":"v2","phases":[{"name":"","tasks":[{"content":"","status":"abandoned"}]}]}`, []TodoPhase{{Name: "", Tasks: []TodoTask{{Content: "", Status: "abandoned"}}}}},
		} {
			t.Run(carrier.name+"/"+tc.name, func(t *testing.T) {
				// Given a genuine newer whole-list mutation.
				s, _ := queueHistorySession(t, queueEntry("root", "", "user", "root")+carrier.encode("before", "root", tc.before)+carrier.encode("after", "before", tc.data), false)
				// When the canonical reader folds the selected branch.
				got, err := readTodoReceipt(t, s)
				// Then exact valid fields still replace, including explicit clears.
				if err != nil || got.Source.EntryID == nil || *got.Source.EntryID != "after" || !reflect.DeepEqual(got.Phases, tc.want) || len(got.Diagnostics) != 0 {
					t.Fatalf("valid mutation rejected: %+v err=%v want=%+v", got, err, tc.want)
				}
			})
		}
	}
}
