package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
	"github.com/DevNewbie1826/omo-webchat/internal/testfs"
)

func queueEntry(id, parent, role, text string) string {
	var p any
	if parent != "" {
		p = parent
	}
	raw, _ := json.Marshal(map[string]any{"type": "message", "id": id, "parentId": p, "message": map[string]any{"role": role, "content": text}})
	return string(raw) + "\n"
}

func queueHistorySession(t *testing.T, body string, inPlace bool) (*Session, *omorpctest.Daemon) {
	t.Helper()
	d := newDaemon(t)
	path := filepath.Join(t.TempDir(), "queue-history.jsonl")
	if err := os.WriteFile(path, []byte("{\"type\":\"session\",\"id\":\"queue-durable\",\"version\":3}\n"+body), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := d.LoadSessionFile(path); err != nil {
		t.Fatal(err)
	}
	store := newMemStore()
	store.cursors["queue"] = Cursor{SessionFile: path, DurableSessionID: "queue-durable", InPlace: inPlace}
	mgr := testManager(t, dial(t, d), store, 64)
	s, _, detach := acquire(t, mgr, testChat{id: "queue", cwd: filepath.Dir(path)}, nil)
	t.Cleanup(detach)
	return s, d
}

func TestDurableHistoryFileOrderBranches(t *testing.T) {
	body := queueEntry("root", "", "user", "initial") + queueEntry("old", "root", "assistant", "old") + queueEntry("accepted", "old", "user", "delivered") + queueEntry("current", "root", "assistant", "new branch")
	for _, tc := range []struct {
		name, cursor, text string
		want, wantErr      bool
	}{
		{"abandoned-positive", "old", "delivered", true, false},
		{"diverged-no-match", "old", "missing", false, true},
		{"missing-cursor", "gone", "delivered", false, true},
		{"current-no-match", "root", "missing", false, false},
		{"initial-positive", "", "delivered", true, false},
		{"initial-no-match", "", "missing", false, false},
		{"at-cursor-excluded", "accepted", "delivered", false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, d := queueHistorySession(t, body, false)
			ctx, cancel := context.WithTimeout(t.Context(), testTimeout)
			defer cancel()
			got, err := s.DurableUserMessageAfter(ctx, tc.cursor, tc.text)
			if got != tc.want || (err != nil) != tc.wantErr {
				t.Fatalf("match=%v err=%v want=%v error=%v", got, err, tc.want, tc.wantErr)
			}
			if !tc.wantErr && d.LastRequest(omorpc.CmdGetEntries)["since"] != "current" {
				t.Fatalf("queried old/root cursor: %v", d.LastRequest(omorpc.CmdGetEntries))
			}
		})
	}
	s, d := queueHistorySession(t, body, false)
	ctx, cancel := context.WithTimeout(t.Context(), testTimeout)
	defer cancel()
	leaf, err := s.DurableHistoryLeaf(ctx)
	if err != nil || leaf != "current" {
		t.Fatalf("checkpoint=%q %v", leaf, err)
	}
	if d.LastRequest(omorpc.CmdGetEntries)["since"] != "current" {
		t.Fatal("checkpoint fetched root")
	}
}

func TestDurableHistoryRejectsDiskDrift(t *testing.T) {
	for _, inPlace := range []bool{false, true} {
		for _, recovery := range []bool{false, true} {
			for _, kind := range []string{"unlink", "rename", "replace", "permission", "header-id", "malformed", "torn", "duplicate", "broken", "zero-byte"} {
				t.Run(fmt.Sprintf("inplace=%v/recovery=%v/%s", inPlace, recovery, kind), func(t *testing.T) {
					s, d := queueHistorySession(t, queueEntry("root", "", "user", "initial"), inPlace)
					path := s.SessionFile()
					original, err := os.ReadFile(path)
					if err != nil {
						t.Fatal(err)
					}
					body := string(original)
					switch kind {
					case "unlink":
						err = os.Remove(path)
					case "rename":
						err = os.Rename(path, path+".moved")
					case "replace":
						err = os.Rename(path, path+".old")
						if err == nil {
							err = os.WriteFile(path, original, 0o600)
						}
					case "permission":
						testfs.MakeUnreadable(t, path)
					case "header-id":
						body = strings.Replace(body, "queue-durable", "wrong-durable", 1)
					case "malformed":
						body += "{bad}\n"
					case "torn":
						body += "{\"type\":\"message\""
					case "duplicate":
						body += queueEntry("root", "", "user", "duplicate")
					case "broken":
						body += queueEntry("orphan", "missing", "user", "orphan")
					case "zero-byte":
						body = ""
					}
					if err != nil {
						t.Fatal(err)
					}
					if body != string(original) {
						if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
							t.Fatal(err)
						}
					}
					before := d.RequestCount(omorpc.CmdGetEntries)
					ctx, cancel := context.WithTimeout(t.Context(), testTimeout)
					defer cancel()
					if recovery {
						_, err = s.DurableUserMessageAfter(ctx, "root", "missing")
					} else {
						_, err = s.DurableHistoryLeaf(ctx)
					}
					if err == nil {
						t.Fatal("invalid disk authority returned success")
					}
					if got := d.RequestCount(omorpc.CmdGetEntries); got != before {
						t.Fatalf("invalid disk fell back to RPC: %d -> %d", before, got)
					}
					if inPlace {
						var drift *ExternalWriteError
						if !errors.As(err, &drift) || s.acquisitionError() == nil {
							t.Fatalf("not quarantined: %v", err)
						}
					}
				})
			}
		}
	}
}

func TestDurableHistoryChangeDuringValidation(t *testing.T) {
	for _, kind := range []string{"rewrite", "replace", "append", "cancel", "route", "epoch"} {
		for _, recovery := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/recovery=%v", kind, recovery), func(t *testing.T) {
				s, d := queueHistorySession(t, queueEntry("root", "", "user", "initial"), true)
				release := d.BlockHandler(omorpc.CmdGetEntries)
				defer release()
				before := d.RequestCount(omorpc.CmdGetEntries)
				ctx, cancel := context.WithTimeout(t.Context(), testTimeout)
				defer cancel()
				done := make(chan error, 1)
				go func() {
					var err error
					if recovery {
						_, err = s.DurableUserMessageAfter(ctx, "root", "missing")
					} else {
						_, err = s.DurableHistoryLeaf(ctx)
					}
					done <- err
				}()
				if !d.AwaitRequestCount(omorpc.CmdGetEntries, before+1, testTimeout) {
					t.Fatal("validation request not observed")
				}
				switch kind {
				case "append":
					// A bounded tail does not authorize a concurrently changed disk
					// snapshot. Reject locally rather than silently retrying a scan.
					if !d.AppendHistory(s.SessionFile(), "assistant", "fresh tail") {
						t.Fatal("synthetic tail append failed")
					}
				case "rewrite":
					b, err := os.ReadFile(s.SessionFile())
					if err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(s.SessionFile(), []byte(strings.Replace(string(b), "initial", "changed", 1)), 0o600); err != nil {
						t.Fatal(err)
					}
				case "replace":
					b, err := os.ReadFile(s.SessionFile())
					if err != nil {
						t.Fatal(err)
					}
					if err := os.Rename(s.SessionFile(), s.SessionFile()+".old"); err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(s.SessionFile(), b, 0o600); err != nil {
						t.Fatal(err)
					}
				case "cancel":
					cancel()
				case "route":
					s.lifecycleMu.Lock()
					s.routingID = "changed-route"
					s.lifecycleMu.Unlock()
				case "epoch":
					s.lifecycleMu.Lock()
					s.epoch = omorpc.EpochToken{}
					s.lifecycleMu.Unlock()
				}
				release()
				select {
				case err := <-done:
					if err == nil {
						t.Fatal("provisional result survived concurrent change")
					}
				case <-time.After(testTimeout):
					t.Fatal("inspection did not finish")
				}
				// An independent request must remain usable after local rejection.
				liveCtx, cancelLive := context.WithTimeout(t.Context(), testTimeout)
				defer cancelLive()
				if _, err := s.client.Call(liveCtx, omorpc.ListSessions{}); err != nil {
					t.Fatal(err)
				}
			})
		}
	}
}
