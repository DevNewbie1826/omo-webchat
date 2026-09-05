package main

import (
	"bytes"
	"context"
	"net/http"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func TestReadBarrierEvictsOnlyHeldReplacementQuery(t *testing.T) {
	for _, command := range []string{omorpc.CmdGetCommands, omorpc.CmdGetState} {
		t.Run(command, func(t *testing.T) {
			f := startFixture(t)
			f.seedHistory(f.pathA, 3)
			f.post("/silent", pathRequest{Path: f.pathA})
			rpc := f.resume(f.lead, f.pathA)
			// Complete replacement hydration and initialization before arming the
			// later read. Arming must not evict or open anything by itself.
			f.call(f.lead, omorpc.GetEntries{SessionID: rpc})
			f.call(f.lead, omorpc.GetState{SessionID: rpc})
			f.call(f.lead, omorpc.GetCommands{SessionID: rpc})
			before := f.daemon.OpenCount()
			token := f.post("/read-barrier/arm", map[string]any{"path": f.pathA, "command": command})["token"]
			var cmd omorpc.Command = omorpc.GetCommands{SessionID: rpc}
			if command == omorpc.CmdGetState {
				cmd = omorpc.GetState{SessionID: rpc}
			}
			result := make(chan *omorpc.Response, 1)
			failures := make(chan error, 1)
			ctx, cancel := context.WithTimeout(context.Background(), fixtureAwait)
			defer cancel()
			go func() {
				resp, err := f.lead.Call(ctx, cmd)
				if resp == nil {
					failures <- err
					return
				}
				result <- resp
			}()
			parked := f.post("/read-barrier/await", map[string]any{"token": token})
			if parked["parked"] != true {
				t.Fatalf("not parked: %v", parked)
			}
			// A real sibling roundtrip completes while A's admitted request is held.
			f.call(f.second, omorpc.GetState{SessionID: f.rpcB})
			select {
			case resp := <-result:
				t.Fatalf("held query completed early: %v", resp)
			case err := <-failures:
				t.Fatal(err)
			default:
			}
			f.post("/read-barrier/evict", map[string]any{"token": token})
			select {
			case resp := <-result:
				if resp.Success || resp.Error != omorpc.ErrCodeUnknownSession {
					t.Fatalf("held replacement query=%+v", resp)
				}
			case err := <-failures:
				t.Fatal(err)
			case <-ctx.Done():
				t.Fatal("evicted read did not complete")
			}
			if f.daemon.OpenCount() != before {
				t.Fatal("read control opened a new conversation")
			}
			f.call(f.second, omorpc.GetState{SessionID: f.rpcB})
			// The one-shot gate is gone: resuming the same stored path remains usable.
			next := f.resume(f.lead, f.pathA)
			f.call(f.lead, omorpc.GetCommands{SessionID: next})
		})
	}
}

func TestReadBarrierRejectsMutationCommand(t *testing.T) {
	f := startFixture(t)
	resp, err := http.Post(f.base+"/read-barrier/arm", "application/json", bytes.NewBufferString(`{"path":"ignored","command":"prompt"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("mutation command status=%d", resp.StatusCode)
	}
}
