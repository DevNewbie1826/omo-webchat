package session

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

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
	_, _, detach := acquire(t, manager, chat, first)
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
}
