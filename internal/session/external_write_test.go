package session

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func TestInPlaceHydrationQuarantinesMissingOriginal(t *testing.T) {
	for _, tc := range []struct {
		name   string
		remove func(*testing.T, string)
	}{
		{name: "unlink", remove: func(t *testing.T, path string) {
			t.Helper()
			if err := os.Remove(path); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "rename", remove: func(t *testing.T, path string) {
			t.Helper()
			if err := os.Rename(path, path+".moved"); err != nil {
				t.Fatal(err)
			}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cwd := t.TempDir()
			path := filepath.Join(cwd, "durable-missing.jsonl")
			body := fmt.Sprintf("{\"type\":\"session\",\"id\":\"durable-missing\",\"version\":3,\"timestamp\":\"2026-09-03T00:00:00Z\",\"cwd\":%q}\n", cwd) +
				"{\"type\":\"message\",\"id\":\"root\",\"parentId\":null,\"message\":{\"role\":\"user\",\"content\":\"before\"}}\n"
			if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
				t.Fatal(err)
			}
			daemon := newDaemon(t)
			if err := daemon.LoadSessionFile(path); err != nil {
				t.Fatal(err)
			}
			store := newMemStore()
			store.cursors["chat-missing"] = Cursor{SessionFile: path, DurableSessionID: "durable-missing", InPlace: true}
			manager := testManager(t, dial(t, daemon), store, 32)
			chat := testChat{id: "chat-missing", cwd: cwd}

			first := newRecorder(32)
			stale, _, detach := acquire(t, manager, chat, first)
			first.await(t, FrameReady)
			first.await(t, FrameEntries)
			detach()

			tc.remove(t, path)

			second := newRecorder(32)
			reattached, started, detachSecond := acquire(t, manager, chat, second)
			defer detachSecond()
			if started || reattached != stale {
				t.Fatal("missing original opened a replacement provider route")
			}
			_, frame := second.awaitError(t, "external-write-detected")
			if info, ok := frame.Data.(ErrorInfo); !ok || info.Code != "external-write-detected" {
				t.Fatalf("missing-original state = %#v", frame.Data)
			}

			beforePrompts := daemon.RequestCount(omorpc.CmdPrompt)
			err := stale.SendPrompt(context.Background(), "must not reach missing route", nil)
			var drift *ExternalWriteError
			if !errors.As(err, &drift) || !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("post-removal prompt error = %T %v, want typed external-write ENOENT", err, err)
			}
			if got := daemon.RequestCount(omorpc.CmdPrompt); got != beforePrompts {
				t.Fatalf("post-removal prompt reached provider: prompt count %d -> %d", beforePrompts, got)
			}
		})
	}
}

func TestInPlaceReattachRehydratesDiskAndReportsExternalLeaf(t *testing.T) {
	cwd := t.TempDir()
	path := filepath.Join(cwd, "durable-external.jsonl")
	body := fmt.Sprintf("{\"type\":\"session\",\"id\":\"durable-external\",\"version\":3,\"timestamp\":\"2026-09-03T00:00:00Z\",\"cwd\":%q}\n", cwd) +
		"{\"type\":\"message\",\"id\":\"root\",\"parentId\":null,\"message\":{\"role\":\"user\",\"content\":\"before\"}}\n"
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	daemon := newDaemon(t)
	if err := daemon.LoadSessionFile(path); err != nil {
		t.Fatal(err)
	}
	store := newMemStore()
	store.cursors["chat-external"] = Cursor{SessionFile: path, DurableSessionID: "durable-external", InPlace: true}
	manager := testManager(t, dial(t, daemon), store, 32)
	chat := testChat{id: "chat-external", cwd: cwd}

	first := newRecorder(32)
	stale, _, detach := acquire(t, manager, chat, first)
	first.await(t, FrameReady)
	first.await(t, FrameEntries)
	detach()

	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	_, writeErr := file.WriteString("{\"type\":\"message\",\"id\":\"external-leaf\",\"parentId\":\"root\",\"message\":{\"role\":\"user\",\"content\":\"external\"}}\n")
	if writeErr != nil {
		_ = file.Close()
		t.Fatal(writeErr)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	second := newRecorder(32)
	_, started, detachSecond := acquire(t, manager, chat, second)
	defer detachSecond()
	if started {
		t.Fatal("reattach unexpectedly opened a replacement provider route")
	}
	prior, frame := second.awaitError(t, "external-write-detected")
	info, ok := frame.Data.(ErrorInfo)
	if !ok || info.KnownLeaf != "root" || info.ObservedLeaf != "external-leaf" {
		t.Fatalf("external-write state = %#v", frame.Data)
	}
	foundExternal := false
	for _, candidate := range prior {
		if candidate.Kind != FrameEntries {
			continue
		}
		entries := candidate.Data.(EntriesFrame).Entries
		for _, entry := range entries {
			if bytes.Contains(entry, []byte("external-leaf")) {
				foundExternal = true
			}
		}
	}
	if !foundExternal {
		t.Fatalf("cold re-hydration did not emit external disk entry before state: %+v", prior)
	}

	beforePrompts := daemon.RequestCount(omorpc.CmdPrompt)
	err = stale.SendPrompt(context.Background(), "must not reach stale route", nil)
	var drift *ExternalWriteError
	if !errors.As(err, &drift) {
		t.Fatalf("post-drift prompt error = %T %v, want typed external-write error", err, err)
	}
	if got := daemon.RequestCount(omorpc.CmdPrompt); got != beforePrompts {
		t.Fatalf("post-drift prompt reached provider: prompt count %d -> %d", beforePrompts, got)
	}

	beforeOpens := daemon.RequestCount(omorpc.CmdOpenSession)
	beforeCloses := daemon.RequestCount(omorpc.CmdCloseSession)
	_, _, ordinaryDetach, err := manager.Acquire(context.Background(), chat, newRecorder(32))
	if ordinaryDetach != nil {
		ordinaryDetach()
	}
	if !errors.As(err, &drift) {
		t.Fatalf("ordinary reattach error = %T %v, want typed external-write error", err, err)
	}
	if got := daemon.RequestCount(omorpc.CmdCloseSession); got != beforeCloses {
		t.Fatalf("ordinary reattach closed quarantined route: %d -> %d", beforeCloses, got)
	}
	if got := daemon.RequestCount(omorpc.CmdOpenSession); got != beforeOpens {
		t.Fatalf("ordinary reattach reopened quarantined route: %d -> %d", beforeOpens, got)
	}

	recoveredSub := newRecorder(32)
	recovered, started, recoveredDetach, err := manager.AcquireInitializedWithRecovery(context.Background(), chat, recoveredSub, nil)
	if err != nil {
		t.Fatalf("explicit recovery: %v", err)
	}
	defer recoveredDetach()
	if !started {
		t.Fatal("external-write recovery reused the quarantined route")
	}
	if recovered.RoutingID() == stale.RoutingID() {
		t.Fatalf("external-write recovery retained stale route %q", stale.RoutingID())
	}
	if got := daemon.RequestCount(omorpc.CmdCloseSession); got != beforeCloses+1 {
		t.Fatalf("external-write recovery close count = %d, want %d", got, beforeCloses+1)
	}
	if got := daemon.RequestCount(omorpc.CmdOpenSession); got != beforeOpens+1 {
		t.Fatalf("external-write recovery open count = %d, want %d", got, beforeOpens+1)
	}
	open := daemon.LastRequest(omorpc.CmdOpenSession)
	if got, _ := open["sessionPath"].(string); got != path {
		t.Fatalf("external-write recovery opened %q, want original %q", got, path)
	}
}
