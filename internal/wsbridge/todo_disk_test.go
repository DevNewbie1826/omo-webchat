package wsbridge

import (
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
)

func appendTodoLine(t *testing.T, path, line string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(line + "\n"); err != nil {
		t.Fatal(err)
	}
}

func todoCustomLine(t *testing.T, id, parent, phases string) string {
	t.Helper()
	return string(mustJSON(t, map[string]any{"type": "custom", "id": id, "parentId": parent, "customType": "senpi.todo-state", "data": map[string]any{"schema": "v2", "phases": json.RawMessage(phases)}}))
}

func TestTodoWatchCustomOnlyDiskUpdatesAndFailuresAfterEviction(t *testing.T) {
	w := newTodoTestWatch(t, "todo-disk", nil)
	w.h.daemon.EvictSessionWithEvent(w.h.path, "session_closed")
	w.h.markSessionResumable(t)
	opens := w.h.daemon.OpenCount()
	reads := w.h.daemon.RequestCount(omorpc.CmdGetEntries)
	parent := "root"
	for _, tc := range []struct{ id, phases string }{
		{"completed", `[{"name":"plan","tasks":[{"content":"one","status":"completed"}]}]`},
		{"reopened", `[{"name":"renamed","tasks":[{"content":"two","status":"in_progress"}]}]`},
		{"clear", `[]`},
		{"named-empty", `[{"name":"remaining","tasks":[]}]`},
	} {
		t.Run(tc.id, func(t *testing.T) {
			// No live tool event: only a metadata change in canonical disk history.
			appendTodoLine(t, w.h.path, todoCustomLine(t, tc.id, parent, tc.phases))
			w.tick(t)
			frame := w.frames.next(t, "chat.todo")
			if frame["status"] != "ready" || frame["source"].(map[string]any)["entryId"] != tc.id {
				t.Fatalf("custom-only frame=%v", frame)
			}
			if string(mustJSON(t, frame["phases"])) != string(mustJSON(t, json.RawMessage(tc.phases))) {
				t.Fatalf("phases=%v, want %s", frame["phases"], tc.phases)
			}
			parent = tc.id
		})
	}
	// A malformed later carrier cannot erase the last valid whole list.
	appendTodoLine(t, w.h.path, todoCustomLine(t, "malformed", parent, `[{}]`))
	w.tick(t)
	retained := w.frames.next(t, "chat.todo")
	if retained["source"].(map[string]any)["entryId"] != "named-empty" {
		t.Fatalf("malformed carrier replaced last good: %v", retained)
	}
	// Disappearance is unavailable, not absence; repeated failure is deduped.
	if err := os.Rename(w.h.path, w.h.path+".held"); err != nil {
		t.Fatal(err)
	}
	w.tick(t)
	failed := w.frames.next(t, "chat.todo")
	if failed["status"] != "unavailable" || failed["error"] != "history-unavailable" {
		t.Fatalf("missing file=%v", failed)
	}
	if _, exists := failed["phases"]; exists {
		t.Fatalf("failure carried replacement state: %v", failed)
	}
	w.tick(t)
	w.assertNoTodo(t)
	if err := os.Rename(w.h.path+".held", w.h.path); err != nil {
		t.Fatal(err)
	}
	w.tick(t)
	restored := w.frames.next(t, "chat.todo")
	if restored["status"] != "ready" || restored["source"].(map[string]any)["entryId"] != "named-empty" {
		t.Fatalf("availability recovery=%v", restored)
	}
	w.tick(t)
	w.assertNoTodo(t)
	if w.h.daemon.OpenCount() != opens || w.h.daemon.RequestCount(omorpc.CmdGetEntries) != reads {
		t.Fatal("disk observation woke an unloaded provider")
	}
}

func TestTodoAuthorityEvictionLagRetainsResidentClear(t *testing.T) {
	w := newTodoTestWatch(t, "todo-lag", nil)
	// Supply a canonical resident-only clear plus a later file-order entry.
	// The selected leaf alone cannot satisfy the reader's eviction boundary.
	clear := todoCustomLine(t, "clear", "root", `[]`)
	end := `{"type":"message","id":"end","parentId":"clear","message":{"role":"assistant","content":"done"}}`
	release := w.h.daemon.BlockHandler(omorpc.CmdGetEntries)
	defer release()
	count := w.h.daemon.RequestCount(omorpc.CmdGetEntries)
	w.hint(t, session.Frame{Kind: session.FrameTool, Data: map[string]any{"phase": "end", "toolName": "eval"}})
	select {
	case w.ticks <- time.Now():
	case <-time.After(5 * time.Second):
		t.Fatal("tick blocked")
	}
	if !w.h.daemon.AwaitRequestCount(omorpc.CmdGetEntries, count+1, 5*time.Second) {
		t.Fatal("no canonical suffix request")
	}
	request := w.h.daemon.LastRequest(omorpc.CmdGetEntries)
	response := mustJSON(t, map[string]any{"type": "response", "id": request["id"], "command": "get_entries", "sessionId": request["sessionId"], "success": true, "data": map[string]any{"entries": []json.RawMessage{json.RawMessage(clear), json.RawMessage(end)}, "leafId": "clear"}})
	w.h.daemon.WriteRaw(append(response, '\n'))
	awaitTodoSignal(t, w.passes)
	live := w.frames.next(t, "chat.todo")
	if live["status"] != "ready" || live["source"].(map[string]any)["entryId"] != "clear" || len(live["phases"].([]any)) != 0 {
		t.Fatalf("resident clear=%v", live)
	}
	release()
	w.h.daemon.EvictSessionWithEvent(w.h.path, "session_closed")
	w.h.markSessionResumable(t)
	opens, reads := w.h.daemon.OpenCount(), w.h.daemon.RequestCount(omorpc.CmdGetEntries)
	writeClient(t, w.sock, map[string]any{"type": "activity.refresh", "sessionId": "todo-lag"})
	awaitCommandFence(t, w.sock, w.frames)
	w.tick(t)
	unavailable := w.frames.next(t, "chat.todo")
	if unavailable["status"] != "unavailable" {
		t.Fatalf("lag rolled back clear: %v", unavailable)
	}
	if _, exists := unavailable["phases"]; exists {
		t.Fatalf("lag replaced state: %v", unavailable)
	}
	appendTodoLine(t, w.h.path, clear)
	w.tick(t)
	w.assertNoTodo(t)
	appendTodoLine(t, w.h.path, end)
	w.tick(t)
	durable := w.frames.next(t, "chat.todo")
	if durable["status"] != "ready" || durable["source"].(map[string]any)["entryId"] != "clear" || len(durable["phases"].([]any)) != 0 {
		t.Fatalf("durable clear=%v", durable)
	}
	if w.h.daemon.OpenCount() != opens || w.h.daemon.RequestCount(omorpc.CmdGetEntries) != reads {
		t.Fatal("lag retry reopened or queried unloaded provider")
	}
}
