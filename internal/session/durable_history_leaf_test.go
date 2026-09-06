package session

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/coldhistory"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func TestDurableHistoryLeaf(t *testing.T) {
	const header = "{\"type\":\"session\",\"version\":3,\"id\":\"checkpoint-session\"}\n"
	const rpcEntry = "{\"type\":\"message\",\"id\":\"rpc-leaf\",\"parentId\":null,\"message\":{\"role\":\"user\",\"content\":\"before\"}}\n"
	const diskEntry = "{\"type\":\"message\",\"id\":\"disk-leaf\",\"parentId\":null,\"message\":{\"role\":\"assistant\",\"content\":\"after\"}}\n"
	for _, test := range []struct {
		name     string
		body     string
		noFile   bool
		missing  bool
		budget   bool
		wantLeaf string
		wantRPC  int
		wantErr  error
	}{
		{name: "GivenFileBackedSession/WhenCheckpointed/ThenDiskLeafWithoutRPC", body: header + rpcEntry + diskEntry, wantLeaf: "disk-leaf"},
		{name: "GivenHeaderOnlySession/WhenCheckpointed/ThenEmptyDiskLeafWithoutRPC", body: header},
		{name: "GivenSessionWithoutFile/WhenCheckpointed/ThenRootRPC", noFile: true, wantLeaf: "rpc-leaf", wantRPC: 1},
		{name: "GivenMissingFile/WhenCheckpointed/ThenRootRPC", missing: true, wantLeaf: "rpc-leaf", wantRPC: 1},
		{name: "GivenIndexBudgetExceeded/WhenCheckpointed/ThenRootRPC", body: header + diskEntry, budget: true, wantLeaf: "rpc-leaf", wantRPC: 1},
		{name: "GivenBadHeader/WhenCheckpointed/ThenErrorWithoutRPC", body: "{\"type\":\"message\",\"id\":\"not-a-session\"}\n", wantErr: coldhistory.ErrInvalidHeader},
		{name: "GivenCorruptLine/WhenCheckpointed/ThenErrorWithoutRPC", body: header + "{broken}\n", wantErr: coldhistory.ErrCorruptLine},
		{name: "GivenBrokenBranch/WhenCheckpointed/ThenErrorWithoutRPC", body: header + "{\"type\":\"message\",\"id\":\"leaf\",\"parentId\":\"missing\"}\n", wantErr: coldhistory.ErrBrokenBranch},
		{name: "GivenDuplicateID/WhenCheckpointed/ThenErrorWithoutRPC", body: header + diskEntry + diskEntry, wantErr: coldhistory.ErrDuplicateID},
		{name: "GivenOversizedLine/WhenCheckpointed/ThenErrorWithoutRPC", body: header + fmt.Sprintf("{\"type\":\"message\",\"id\":\"long\",\"parentId\":null,\"content\":%q}\n", strings.Repeat("x", coldhistory.DefaultMaxLineBytes)), wantErr: coldhistory.ErrLineTooLong},
		{name: "GivenMismatchedIdentity/WhenCheckpointed/ThenErrorWithoutRPC", body: strings.Replace(header, "checkpoint-session", "other-session", 1) + diskEntry, wantErr: errIncompleteHistory},
	} {
		t.Run(test.name, func(t *testing.T) {
			// Given a real daemon with a distinct, known RPC leaf and no hydration requests.
			d := newDaemon(t)
			path := filepath.Join(t.TempDir(), "session.jsonl")
			mustOK(t, os.WriteFile(path, []byte(header+rpcEntry), 0o600))
			mustOK(t, d.LoadSessionFile(path))
			store := newMemStore()
			mustOK(t, store.SaveCursor(t.Context(), "checkpoint-chat", Cursor{SessionFile: path, DurableSessionID: "checkpoint-session"}))
			mgr := testManager(t, dial(t, d), store, 16)
			sess, _, detach := acquire(t, mgr, testChat{id: "checkpoint-chat", cwd: filepath.Dir(path)}, nil)
			defer detach()
			switch {
			case test.noFile:
				sess.sessionFile = ""
			case test.missing:
				mustOK(t, os.Remove(path))
			default:
				mustOK(t, os.WriteFile(path, []byte(test.body), 0o600))
			}
			if test.budget {
				// Exercise the real stream's budget error without a 64 MiB index fixture.
				original := streamSessionHistory
				streamSessionHistory = func(ctx context.Context, path string, options coldhistory.Options, emit func(coldhistory.Metadata, coldhistory.Page) error) (coldhistory.Metadata, error) {
					options.IndexBytes = 1
					return original(ctx, path, options, emit)
				}
				t.Cleanup(func() { streamSessionHistory = original })
			}
			if got := d.RequestCount(omorpc.CmdGetEntries); got != 0 {
				t.Fatalf("setup get_entries requests = %d, want 0", got)
			}

			// When the queue checkpoint asks for its authoritative boundary.
			ctx, cancel := context.WithTimeout(t.Context(), testTimeout)
			defer cancel()
			leaf, err := sess.DurableHistoryLeaf(ctx)

			// Then disk validation controls the result and only supported fallbacks use RPC.
			if !errors.Is(err, test.wantErr) {
				t.Errorf("checkpoint error = %v, want %v", err, test.wantErr)
			}
			if leaf != test.wantLeaf {
				t.Errorf("checkpoint leaf = %q, want %q", leaf, test.wantLeaf)
			}
			if got := d.RequestCount(omorpc.CmdGetEntries); got != test.wantRPC {
				t.Errorf("get_entries requests = %d, want %d", got, test.wantRPC)
			}
			if test.wantRPC != 0 {
				if request := d.LastRequest(omorpc.CmdGetEntries); request["since"] != nil {
					t.Errorf("fallback included since: %#v", request)
				}
			}
		})
	}
}
