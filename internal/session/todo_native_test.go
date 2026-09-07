package session

import (
	"context"
	"encoding/json"
	"os"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func TestTodoAuthorityNativeEmpty(t *testing.T) {
	for _, kind := range []string{"header-only", "native-absent", "established-missing", "zero-byte", "closed-disk-only"} {
		t.Run(kind, func(t *testing.T) {
			d := newDaemon(t)
			client := dial(t, d)
			mgr := testManager(t, client, newMemStore(), 32)
			ctx, cancel := context.WithTimeout(t.Context(), testTimeout)
			defer cancel()
			resp, epoch, err := client.CallInEpoch(ctx, omorpc.OpenSession{CWD: t.TempDir()})
			if err != nil {
				t.Fatal(err)
			}
			var opened omorpc.OpenSessionData
			if err := json.Unmarshal(resp.Data, &opened); err != nil {
				t.Fatal(err)
			}
			if kind == "native-absent" {
				if err := os.Remove(opened.State.SessionFile); err != nil {
					t.Fatal(err)
				}
			}
			s := newSession(mgr, "native-todo", t.TempDir(), opened, false, epoch)
			switch kind {
			case "established-missing":
				if err := os.Remove(s.SessionFile()); err != nil {
					t.Fatal(err)
				}
			case "zero-byte":
				if err := os.Truncate(s.SessionFile(), 0); err != nil {
					t.Fatal(err)
				}
			case "closed-disk-only":
				s.lifecycleMu.Lock()
				s.closed = true
				s.lifecycleMu.Unlock()
			}
			reads, opens := d.RequestCount(omorpc.CmdGetEntries), d.RequestCount(omorpc.CmdOpenSession)
			got, err := s.ReadTodoProjection(ctx)
			invalid := kind == "established-missing" || kind == "zero-byte"
			if invalid {
				if err == nil {
					t.Fatalf("invalid empty became absent: %+v", got)
				}
				return
			}
			if err != nil || got.Source.Kind != "absent" || got.Phases != nil || got.Source.LeafID != nil {
				t.Fatalf("native absence=%+v %v", got, err)
			}
			if kind == "closed-disk-only" && d.RequestCount(omorpc.CmdGetEntries) != reads {
				t.Fatal("closed read queried daemon")
			}
			if d.RequestCount(omorpc.CmdOpenSession) != opens {
				t.Fatal("todo read opened a session")
			}
		})
	}
}

func TestTodoAuthorityUnavailableReadLeavesRouteUsable(t *testing.T) {
	s, d := queueHistorySession(t, todoCustom("a", "", `{"schema":"v2","phases":[{}]}`), true)
	before := d.RequestCount(omorpc.CmdOpenSession)
	if _, err := s.ReadTodoProjection(t.Context()); err == nil {
		t.Fatal("invalid carrier accepted")
	}
	if err := s.acquisitionError(); err != nil {
		t.Fatalf("read mutated route state: %v", err)
	}
	if d.RequestCount(omorpc.CmdOpenSession) != before {
		t.Fatal("invalid carrier reopened route")
	}
}
