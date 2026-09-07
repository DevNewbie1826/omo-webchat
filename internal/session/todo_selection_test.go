package session

import (
	"reflect"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func TestTodoAuthoritySelectionSurvivesUnload(t *testing.T) {
	for _, kind := range []string{"ancestor", "other-branch", "absent", "clear"} {
		t.Run(kind, func(t *testing.T) {
			root := queueEntry("root", "", "user", "root")
			selected := todoCustom("a", "root", todoData("selected", "pending"))
			parent := "a"
			switch kind {
			case "other-branch":
				parent = "root"
			case "absent":
				selected = queueEntry("a", "root", "assistant", "no todo on selected branch")
			case "clear":
				selected = todoCustom("a", "root", `{"schema":"v2","phases":[]}`)
			}
			s, d := queueHistorySession(t, root+selected+todoCustom("b", parent, todoData("not selected", "completed")), false)
			live := heldTodoRead(t, s, d, map[string]any{"entries": []any{}, "leafId": "a"}, nil)
			if live.err != nil {
				t.Fatal(live.err)
			}
			if live.projection.Source.LeafID == nil || *live.projection.Source.LeafID != "a" {
				t.Fatalf("resident selection=%+v", live.projection)
			}
			s.lifecycleMu.Lock()
			s.markProviderUnloadedLocked()
			s.lifecycleMu.Unlock()
			reads, opens := d.RequestCount(omorpc.CmdGetEntries), d.RequestCount(omorpc.CmdOpenSession)
			disk, err := s.ReadTodoProjection(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(disk, live.projection) {
				t.Fatalf("eviction changed selection with unchanged disk: resident=%+v disk=%+v", live.projection, disk)
			}
			if d.RequestCount(omorpc.CmdGetEntries) != reads || d.RequestCount(omorpc.CmdOpenSession) != opens {
				t.Fatal("unloaded selection read touched provider")
			}
		})
	}
}

func TestTodoAuthorityAdvancedDiskReplacesSavedSelection(t *testing.T) {
	s, d := queueHistorySession(t, todoCustom("a", "", todoData("selected", "completed"))+todoCustom("b", "a", todoData("disk end", "pending")), false)
	live := heldTodoRead(t, s, d, map[string]any{"entries": []any{}, "leafId": "a"}, nil)
	if live.err != nil {
		t.Fatal(live.err)
	}
	s.lifecycleMu.Lock()
	s.markProviderUnloadedLocked()
	s.lifecycleMu.Unlock()
	reads, opens := d.RequestCount(omorpc.CmdGetEntries), d.RequestCount(omorpc.CmdOpenSession)
	appendTodoFixture(t, s.SessionFile(), todoCustom("c", "b", todoData("advanced", "in_progress")))
	disk, err := s.ReadTodoProjection(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if disk.Source.LeafID == nil || *disk.Source.LeafID != "c" || disk.Source.EntryID == nil || *disk.Source.EntryID != "c" || disk.Phases[0].Tasks[0].Status != "in_progress" {
		t.Fatalf("advanced disk selection=%+v", disk)
	}
	if d.RequestCount(omorpc.CmdGetEntries) != reads || d.RequestCount(omorpc.CmdOpenSession) != opens {
		t.Fatal("advanced disk read touched provider")
	}
}

func TestTodoAuthorityNewResidentSelectionReplacesSavedSelection(t *testing.T) {
	s, d := queueHistorySession(t, todoCustom("root", "", todoData("root", "in_progress"))+todoCustom("a", "root", todoData("first selection", "completed"))+todoCustom("b", "root", todoData("disk end", "pending")), false)
	first := heldTodoRead(t, s, d, map[string]any{"entries": []any{}, "leafId": "a"}, nil)
	if first.err != nil {
		t.Fatal(first.err)
	}
	latest := heldTodoRead(t, s, d, map[string]any{"entries": []any{}, "leafId": "root"}, nil)
	if latest.err != nil {
		t.Fatal(latest.err)
	}
	if latest.projection.Source.LeafID == nil || *latest.projection.Source.LeafID != "root" {
		t.Fatalf("new resident selection=%+v", latest.projection)
	}
	s.lifecycleMu.Lock()
	s.markProviderUnloadedLocked()
	s.lifecycleMu.Unlock()
	reads, opens := d.RequestCount(omorpc.CmdGetEntries), d.RequestCount(omorpc.CmdOpenSession)
	disk, err := s.ReadTodoProjection(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(disk, latest.projection) {
		t.Fatalf("new resident selection lost: latest=%+v disk=%+v", latest.projection, disk)
	}
	if d.RequestCount(omorpc.CmdGetEntries) != reads || d.RequestCount(omorpc.CmdOpenSession) != opens {
		t.Fatal("saved selection read touched provider")
	}
}
