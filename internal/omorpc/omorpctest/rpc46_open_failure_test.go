package omorpctest

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest/transport"
)

func TestRPC46FailOpenPath(t *testing.T) {
	for _, tc := range []struct {
		name, supplied, wire, code string
		times                      int
	}{
		{"exact-one-shot", "open_failed: QA_CONTEXT_LIMIT 311799 > 272000", "open_failed: QA_CONTEXT_LIMIT 311799 > 272000", omorpc.ErrCodeOpenFailed, 1},
		{"multiline-count", "open_failed:  <img src=x>\nline two\t  ", "open_failed:  <img src=x>\nline two\t  ", omorpc.ErrCodeOpenFailed, 2},
		{"empty-detail", "open_failed:", "open_failed:", omorpc.ErrCodeOpenFailed, 1},
		{"blank-detail", "open_failed: \n\t  ", "open_failed: \n\t  ", omorpc.ErrCodeOpenFailed, 1},
		{"arbitrary", "QA_PRIVATE_INTERNAL_ERROR /private/path", "QA_PRIVATE_INTERNAL_ERROR /private/path", "", 1},
		{"path-in-use", omorpc.ErrCodeSessionPathInUse, omorpc.ErrCodeSessionPathInUse, omorpc.ErrCodeSessionPathInUse, 3},
		{"empty-code-default", "", omorpc.ErrCodeSessionPathInUse, omorpc.ErrCodeSessionPathInUse, 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// Keep the socket path below Darwin's Unix-socket pathname limit.
			root, err := os.MkdirTemp("", "rpc46-open-")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if err := os.RemoveAll(root); err != nil {
					t.Error(err)
				}
			})
			d := New(root)
			if err := d.Start(); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(d.Stop)
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			conn, err := transport.Dial(ctx, d.SocketPath())
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { conn.Close() })
			if err := conn.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
				t.Fatal(err)
			}
			enc, dec := json.NewEncoder(conn), json.NewDecoder(conn)
			requests := 0
			open := func(path, want string) {
				t.Helper()
				requests++
				id := fmt.Sprintf("open-%d", requests)
				if err := enc.Encode(map[string]any{"id": id, "type": omorpc.CmdOpenSession, "sessionPath": path, "cwd": root}); err != nil {
					t.Fatal(err)
				}
				var resp struct {
					omorpc.Response
					Type string `json:"type"`
				}
				if err := dec.Decode(&resp); err != nil {
					t.Fatal(err)
				}
				if resp.ID != id || resp.Type != "response" || resp.Command != omorpc.CmdOpenSession || resp.Success != (want == "") || resp.Error != want {
					t.Errorf("path %q: response = %+v; want id=%q success=%v exact error=%q", path, resp, id, want == "", want)
				}
				if want == "" {
					var data omorpc.OpenSessionData
					if err := json.Unmarshal(resp.Data, &data); err != nil {
						t.Fatal(err)
					}
					if data.SessionID == "" || data.State.SessionFile == "" || (path != "" && data.State.SessionFile != path) {
						t.Errorf("successful open lost routing/path: %+v", data)
					}
				} else if path == filepath.Join(root, "a.jsonl") {
					stable, ok := omorpc.ParseStableError(resp.Error)
					if tc.code == "" {
						if ok {
							t.Errorf("arbitrary wire classified as stable: %+v", stable)
						}
					} else if !ok || stable.Code != tc.code || stable.Error() != tc.wire {
						t.Errorf("classification = %+v, %v; want code=%q wire=%q", stable, ok, tc.code, tc.wire)
					}
				}
			}
			a, b := filepath.Join(root, "a.jsonl"), filepath.Join(root, "b.jsonl")
			d.FailOpenPath(a, tc.supplied, tc.times)
			d.FailOpenPath(b, omorpc.ErrCodeInvalidPath, 1)
			open("", "") // Fresh opens must neither fail nor consume a path's count.
			for i := 0; i < tc.times; i++ {
				open(a, tc.wire)
				if i == 0 {
					open(b, omorpc.ErrCodeInvalidPath)
				}
				open(b, "") // A's remaining failures must not affect B.
			}
			open(a, "")
			open(a, "") // Exhaustion stays successful, not merely a single retry.
			if d.OpenCount() != requests || len(d.Requests()) != requests {
				t.Errorf("counts: opens=%d requests=%d want=%d", d.OpenCount(), len(d.Requests()), requests)
			}
		})
	}
}
