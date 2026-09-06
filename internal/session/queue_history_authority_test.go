package session

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func TestDurableHistoryNativeEmpty(t *testing.T) {
	for _, kind := range []string{"header-only", "absent", "established-disappearance", "zero-byte"} {
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
			// Remove before constructing the fresh native lifecycle, not after
			// it observed an established file. No session authority is stubbed.
			if kind == "absent" {
				if err := os.Remove(opened.State.SessionFile); err != nil {
					t.Fatal(err)
				}
			}
			s := newSession(mgr, "native", t.TempDir(), opened, false, epoch)
			if kind == "established-disappearance" {
				if err := os.Remove(opened.State.SessionFile); err != nil {
					t.Fatal(err)
				}
			}
			if kind == "zero-byte" {
				if err := os.Truncate(opened.State.SessionFile, 0); err != nil {
					t.Fatal(err)
				}
			}
			leaf, err := s.DurableHistoryLeaf(ctx)
			if kind == "established-disappearance" || kind == "zero-byte" {
				if err == nil {
					t.Fatal("invalid empty native authority succeeded")
				}
				return
			}
			if err != nil || leaf != "" {
				t.Fatalf("native empty checkpoint=%q %v", leaf, err)
			}
			if got, err := s.DurableUserMessageAfter(ctx, "", "missing"); err != nil || got {
				t.Fatalf("native empty recovery=%v %v", got, err)
			}
			if kind == "header-only" {
				if err := s.SendPrompt(ctx, "native still usable", nil); err != nil {
					t.Fatal(err)
				}
				if leaf, err := s.DurableHistoryLeaf(ctx); err != nil || leaf == "" {
					t.Fatalf("native first delivery boundary=%q %v", leaf, err)
				}
			}
		})
	}
}

func TestDurableHistoryUnknownDiskCursorPreservesProviderFailure(t *testing.T) {
	s, d := queueHistorySession(t, queueEntry("root", "", "user", "initial"), true)
	f, err := os.OpenFile(s.SessionFile(), os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString(queueEntry("disk-only", "root", "assistant", "external")); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), testTimeout)
	defer cancel()
	_, err = s.DurableHistoryLeaf(ctx)
	if err == nil || !strings.Contains(err.Error(), "Entry not found: disk-only") {
		t.Fatalf("provider unknown cursor error was lost: %v", err)
	}
	if d.LastRequest(omorpc.CmdGetEntries)["since"] != "disk-only" {
		t.Fatal("used full RPC fallback")
	}
	var drift *ExternalWriteError
	if !errors.As(s.acquisitionError(), &drift) {
		t.Fatal("in-place daemon/disk disagreement did not quarantine the route")
	}
}

func TestDurableHistoryRejectsOldEpochBeforeRequest(t *testing.T) {
	s, d := queueHistorySession(t, queueEntry("root", "", "user", "initial"), false)
	s.lifecycleMu.Lock()
	s.epoch = omorpc.EpochToken{}
	s.lifecycleMu.Unlock()
	before := d.RequestCount(omorpc.CmdGetEntries)
	ctx, cancel := context.WithTimeout(t.Context(), testTimeout)
	defer cancel()
	_, err := s.DurableHistoryLeaf(ctx)
	if !errors.Is(err, omorpc.ErrEpochMismatch) {
		t.Fatalf("old epoch=%v", err)
	}
	if d.RequestCount(omorpc.CmdGetEntries) != before {
		t.Fatal("old epoch wrote request")
	}
}

func TestDurableHistoryDaemonResponseAuthority(t *testing.T) {
	for _, kind := range []string{"moved-back", "missing-leaf", "wrong-route", "broken-tail", "duplicate-tail", "branch-tail"} {
		t.Run(kind, func(t *testing.T) {
			s, d := queueHistorySession(t, queueEntry("root", "", "user", "initial")+queueEntry("old", "root", "assistant", "old")+queueEntry("end", "root", "assistant", "current"), false)
			release := d.BlockHandler(omorpc.CmdGetEntries)
			defer release()
			ctx, cancel := context.WithTimeout(t.Context(), testTimeout)
			defer cancel()
			done := make(chan error, 1)
			go func() { _, err := s.DurableHistoryLeaf(ctx); done <- err }()
			if !d.AwaitRequestCount(omorpc.CmdGetEntries, 1, testTimeout) {
				t.Fatal("no validation query")
			}
			req := d.LastRequest(omorpc.CmdGetEntries)
			leaf, route := "end", s.RoutingID()
			entries := []json.RawMessage{}
			switch kind {
			case "moved-back":
				leaf = "root"
			case "missing-leaf":
				leaf = "missing"
			case "wrong-route":
				route = "unrelated"
			case "broken-tail":
				leaf = "tail"
				entries = append(entries, json.RawMessage(queueEntry("tail", "gone", "user", "new")))
			case "duplicate-tail":
				leaf = "end"
				entries = append(entries, json.RawMessage(queueEntry("end", "root", "user", "new")))
			case "branch-tail":
				leaf = "tail"
				entries = append(entries, json.RawMessage(queueEntry("tail", "old", "user", "new")))
			}
			raw, err := json.Marshal(map[string]any{"id": req["id"], "type": "response", "command": "get_entries", "sessionId": route, "success": true, "data": map[string]any{"entries": entries, "leafId": leaf}})
			if err != nil {
				t.Fatal(err)
			}
			d.WriteRaw(append(raw, '\n'))
			select {
			case err := <-done:
				if (err != nil) != (kind != "branch-tail") {
					t.Fatalf("response authority=%v", err)
				}
			case <-time.After(testTimeout):
				t.Fatal("response did not settle")
			}
			release()
		})
	}
}

func TestDurableHistoryCanceledLateResponseCannotPublishResult(t *testing.T) {
	for _, recovery := range []bool{false, true} {
		name := "checkpoint"
		if recovery {
			name = "recovery"
		}
		t.Run(name, func(t *testing.T) {
			s, d := queueHistorySession(t, queueEntry("root", "", "user", "initial"), false)
			sub := newRecorder(16)
			detach := s.Attach(sub)
			defer detach()
			release := d.BlockHandler(omorpc.CmdGetEntries)
			defer release()
			ctx, cancel := context.WithTimeout(t.Context(), testTimeout)
			defer cancel()
			done := make(chan error, 1)
			go func() {
				if recovery {
					found, err := s.DurableUserMessageAfter(ctx, "root", "accepted")
					if found {
						done <- errors.New("canceled recovery accepted")
						return
					}
					done <- err
				} else {
					leaf, err := s.DurableHistoryLeaf(ctx)
					if leaf != "" {
						done <- errors.New("canceled checkpoint returned leaf")
						return
					}
					done <- err
				}
			}()
			if !d.AwaitRequestCount(omorpc.CmdGetEntries, 1, testTimeout) {
				t.Fatal("no held validation")
			}
			req := d.LastRequest(omorpc.CmdGetEntries)
			cancel()
			select {
			case err := <-done:
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("cancellation=%v", err)
				}
			case <-time.After(testTimeout):
				t.Fatal("cancellation did not settle")
			}
			late, err := json.Marshal(map[string]any{"type": "response", "id": req["id"], "command": "get_entries", "sessionId": s.RoutingID(), "success": true, "data": map[string]any{"entries": []json.RawMessage{json.RawMessage(queueEntry("accepted", "root", "user", "accepted"))}, "leafId": "accepted"}})
			if err != nil {
				t.Fatal(err)
			}
			marker, err := json.Marshal(map[string]any{"type": "state_changed", "sessionId": s.RoutingID(), "lateHistoryFence": true})
			if err != nil {
				t.Fatal(err)
			}
			// One wire write orders the late response before a subscribed marker.
			d.WriteRaw(append(append(append(late, '\n'), marker...), '\n'))
			_, frame := sub.await(t, FrameState)
			if data, ok := frame.Data.(map[string]any); !ok || data["lateHistoryFence"] != true {
				t.Fatalf("late response fence=%+v", frame)
			}
			if err := s.acquisitionError(); err != nil {
				t.Fatalf("late response damaged route: %v", err)
			}
			liveCtx, cancelLive := context.WithTimeout(t.Context(), testTimeout)
			defer cancelLive()
			if _, err := s.client.Call(liveCtx, omorpc.ListSessions{}); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestDurableHistoryNativeResponseRequiresLeaf(t *testing.T) {
	for _, kind := range []string{"missing", "null", "string", "invalid"} {
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
			s := newSession(mgr, "native", t.TempDir(), opened, false, epoch)
			release := d.BlockHandler(omorpc.CmdGetEntries)
			defer release()
			done := make(chan error, 1)
			go func() { _, err := s.DurableHistoryLeaf(ctx); done <- err }()
			if !d.AwaitRequestCount(omorpc.CmdGetEntries, 1, testTimeout) {
				t.Fatal("no native query")
			}
			req := d.LastRequest(omorpc.CmdGetEntries)
			data := map[string]any{"entries": []any{}}
			switch kind {
			case "null":
				data["leafId"] = nil
			case "string":
				data["leafId"] = ""
			case "invalid":
				data["leafId"] = true
			}
			raw, err := json.Marshal(map[string]any{"type": "response", "id": req["id"], "command": "get_entries", "sessionId": s.RoutingID(), "success": true, "data": data})
			if err != nil {
				t.Fatal(err)
			}
			d.WriteRaw(append(raw, '\n'))
			select {
			case err := <-done:
				if (err != nil) != (kind == "missing" || kind == "invalid") {
					t.Fatalf("native leaf validation=%v", err)
				}
			case <-time.After(testTimeout):
				t.Fatal("native response did not settle")
			}
		})
	}
}
