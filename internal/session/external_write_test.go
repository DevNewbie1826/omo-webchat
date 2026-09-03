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

func TestInPlaceMutationFenceQuarantinesDirectFileDrift(t *testing.T) {
	for _, tc := range []struct {
		name       string
		mutate     func(*testing.T, string)
		wantCause  error
		wantReason string
	}{
		{name: "unlink", wantCause: os.ErrNotExist, mutate: func(t *testing.T, path string) {
			t.Helper()
			if err := os.Remove(path); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "rename", wantCause: os.ErrNotExist, mutate: func(t *testing.T, path string) {
			t.Helper()
			if err := os.Rename(path, path+".moved"); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "chmod-000", wantCause: os.ErrPermission, wantReason: "session file is not readable", mutate: func(t *testing.T, path string) {
			t.Helper()
			t.Cleanup(func() { _ = os.Chmod(path, 0o600) })
			if err := os.Chmod(path, 0); err != nil {
				t.Fatal(err)
			}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cwd := t.TempDir()
			path := filepath.Join(cwd, "durable-direct-drift.jsonl")
			body := fmt.Sprintf("{\"type\":\"session\",\"id\":\"durable-direct-drift\",\"version\":3,\"timestamp\":\"2026-09-03T00:00:00Z\",\"cwd\":%q}\n", cwd) +
				"{\"type\":\"message\",\"id\":\"root\",\"parentId\":null,\"message\":{\"role\":\"user\",\"content\":\"before\"}}\n"
			if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
				t.Fatal(err)
			}
			daemon := newDaemon(t)
			if err := daemon.LoadSessionFile(path); err != nil {
				t.Fatal(err)
			}
			store := newMemStore()
			store.cursors["chat-direct-drift"] = Cursor{SessionFile: path, DurableSessionID: "durable-direct-drift", InPlace: true}
			manager := testManager(t, dial(t, daemon), store, 32)
			sub := newRecorder(32)
			sess, _, detach := acquire(t, manager, testChat{id: "chat-direct-drift", cwd: cwd}, sub)
			defer detach()
			sub.await(t, FrameReady)
			sub.await(t, FrameEntries)

			tc.mutate(t, path)

			beforePrompts := daemon.RequestCount(omorpc.CmdPrompt)
			err := sess.SendPrompt(context.Background(), "must not reach stale route", nil)
			var drift *ExternalWriteError
			if !errors.As(err, &drift) || !errors.Is(err, tc.wantCause) {
				t.Fatalf("prompt error = %T %v, want typed external-write wrapping %v", err, err, tc.wantCause)
			}
			if tc.wantReason != "" && drift.Reason != tc.wantReason {
				t.Fatalf("drift reason = %q, want %q", drift.Reason, tc.wantReason)
			}
			if got := daemon.RequestCount(omorpc.CmdPrompt); got != beforePrompts {
				t.Fatalf("prompt reached provider: prompt count %d -> %d", beforePrompts, got)
			}
			sess.lifecycleMu.Lock()
			_, routeErr := sess.routeLocked()
			latched := sess.quarantineErr
			sess.lifecycleMu.Unlock()
			if latched == nil || !errors.As(routeErr, &drift) {
				t.Fatalf("route was not quarantined: latch=%v route error=%T %v", latched, routeErr, routeErr)
			}
			_, frame := sub.awaitError(t, "external-write-detected")
			if info, ok := frame.Data.(ErrorInfo); !ok || info.Code != "external-write-detected" {
				t.Fatalf("quarantine transition = %#v", frame.Data)
			}
		})
	}
}

func TestInPlaceQuarantinePublishesOnceToEveryAttachedSubscriber(t *testing.T) {
	cwd := t.TempDir()
	path := filepath.Join(cwd, "durable-broadcast.jsonl")
	body := fmt.Sprintf("{\"type\":\"session\",\"id\":\"durable-broadcast\",\"version\":3,\"timestamp\":\"2026-09-03T00:00:00Z\",\"cwd\":%q}\n", cwd) +
		"{\"type\":\"message\",\"id\":\"root\",\"parentId\":null,\"message\":{\"role\":\"user\",\"content\":\"before\"}}\n"
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	daemon := newDaemon(t)
	if err := daemon.LoadSessionFile(path); err != nil {
		t.Fatal(err)
	}
	store := newMemStore()
	store.cursors["chat-broadcast"] = Cursor{SessionFile: path, DurableSessionID: "durable-broadcast", InPlace: true}
	manager := testManager(t, dial(t, daemon), store, 32)
	chat := testChat{id: "chat-broadcast", cwd: cwd}

	a := newRecorder(32)
	sess, _, detachA := acquire(t, manager, chat, a)
	defer detachA()
	a.await(t, FrameReady)
	a.await(t, FrameEntries)
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString("{\"type\":\"message\",\"id\":\"external-leaf\",\"parentId\":\"root\",\"message\":{\"role\":\"user\",\"content\":\"external\"}}\n"); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	b := newRecorder(32)
	reused, started, detachB := acquire(t, manager, chat, b)
	defer detachB()
	if started || reused != sess {
		t.Fatal("drift detection replaced the attached route")
	}

	sess.lifecycleMu.Lock()
	sess.publishLocked(Frame{Kind: FrameState, SessionID: sess.ID()})
	sess.lifecycleMu.Unlock()
	priorA, _ := a.await(t, FrameState)
	priorB, _ := b.await(t, FrameState)
	for name, frames := range map[string][]Frame{"existing": priorA, "detecting": priorB} {
		count := 0
		for _, frame := range frames {
			if frame.Kind == FrameError && frame.Data.(ErrorInfo).Code == "external-write-detected" {
				count++
			}
		}
		if count != 1 {
			t.Fatalf("%s subscriber received %d quarantine transitions, want 1: %+v", name, count, frames)
		}
	}
	if entries, transition := frameIndex(priorB, FrameEntries), frameIndex(priorB, FrameError); entries < 0 || transition <= entries {
		t.Fatalf("detecting subscriber replay order = %+v", priorB)
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
