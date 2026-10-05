//go:build darwin || linux

package rpcwatch

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
)

func TestUnixSocketSameRoute(t *testing.T) {
	for _, stable := range []bool{false, true} {
		name := "default mints route"
		if stable {
			name = "same route attachments"
		}
		t.Run(name, func(t *testing.T) {
			dir, err := os.MkdirTemp("", "unified-rpcwatch-")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if err := os.RemoveAll(dir); err != nil {
					t.Error(err)
				}
				if _, err := os.Stat(dir); !os.IsNotExist(err) {
					t.Errorf("temp directory remains: %v", err)
				}
				t.Log("cleanup: clients closed, daemon stopped, removed", dir)
			})
			d := omorpctest.New(dir)
			d.SetSameRouteOpen(stable)
			if err := d.Start(); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(d.Stop)
			first, err := omorpc.Dial(t.Context(), d.SocketPath())
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { first.Close() })
			second, err := omorpc.Dial(t.Context(), d.SocketPath())
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { second.Close() })
			call := func(c *omorpc.Client, cmd omorpc.Command) *omorpc.Response {
				t.Helper()
				r, err := c.Call(t.Context(), cmd)
				if err != nil {
					t.Fatal(err)
				}
				if err := r.Err(); err != nil {
					t.Fatal(err)
				}
				return r
			}
			open := func(c *omorpc.Client, cmd omorpc.OpenSession) omorpc.OpenSessionData {
				t.Helper()
				var opened omorpc.OpenSessionData
				if err := json.Unmarshal(call(c, cmd).Data, &opened); err != nil {
					t.Fatal(err)
				}
				return opened
			}
			a := open(first, omorpc.OpenSession{CWD: "/unified-workspace"})
			b := open(second, omorpc.OpenSession{SessionPath: a.State.SessionFile})
			if (a.SessionID == b.SessionID) != stable {
				t.Fatalf("route behavior stable=%v: %s -> %s", stable, a.SessionID, b.SessionID)
			}
			if !stable {
				return
			}
			snapshot := d.SessionSnapshots()
			if len(snapshot) != 1 || snapshot[0].Attachments != 2 {
				t.Fatalf("attachments: %+v", snapshot)
			}
			w := New(second)
			w.Tick(t.Context())
			if rows := w.Sessions(); len(rows) != 1 || rows[0].SessionID != a.SessionID || rows[0].SessionPath != filepath.Clean(a.State.SessionFile) || rows[0].Cwd != "/unified-workspace" {
				t.Fatalf("socket observation: %+v", rows)
			}
			call(first, omorpc.CloseSession{SessionID: a.SessionID})
			w.Tick(t.Context())
			if rows := w.Sessions(); len(rows) != 1 || d.SessionSnapshots()[0].Attachments != 1 {
				t.Fatalf("first detach removed live route: %+v", rows)
			}
			call(second, omorpc.CloseSession{SessionID: b.SessionID})
			w.Tick(t.Context())
			if len(w.Sessions()) != 0 {
				t.Fatal("final detach retained closed route")
			}
			t.Logf("PASS: same route %s, attachments 2 -> 1 -> 0; watcher rows 1 -> 1 -> 0", a.SessionID)
		})
	}
}
