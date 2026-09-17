package wsbridge

import (
	"encoding/json"
	"fmt"
	"os"
	"testing"
	"time"
)

// Wait on the collector's frame-generation signal, not a polling interval.
func resumeHistory(t *testing.T, h *historyBridgeHarness, chat string, cursor map[string]any) []map[string]any {
	t.Helper()
	conn, frames := connectHistoryVersion(t, h, 3, 0)
	create := map[string]any{"type": "chat.create", "wsId": h.workspace.ID, "chatId": chat}
	if cursor != nil {
		create["resume"] = cursor
	}
	writeClient(t, conn, create)
	deadline := time.Now().Add(historyE2ETestBudget)
	scanned := 0
	var pages []map[string]any
	for {
		batch, closed, generation := frames.takeDecoded(scanned)
		scanned += len(batch)
		for _, f := range batch {
			var frame map[string]any
			if err := json.Unmarshal(f.raw, &frame); err != nil {
				t.Fatal(err)
			}
			if f.typ == "error" {
				t.Fatalf("history error: %v", frame)
			}
			if f.typ != "entries" {
				continue
			}
			pages = append(pages, frame)
			if frame["historyComplete"] == true {
				return pages
			}
		}
		if closed {
			t.Fatal("closed before completion")
		}
		if err := frames.waitAfter(generation, time.Until(deadline)); err != nil {
			t.Fatal(err)
		}
	}
}

func TestReconnectResumeDoesNotReplayDeliveredIDs(t *testing.T) {
	h := newHistoryBridgeHarness(t, historyE2ETestBudget)
	path, leaf := writeBridgeHistory(t, 300)
	h.saveChat(t, "resume-chat", path)
	if err := h.daemon.LoadSessionFile(path); err != nil {
		t.Fatal(err)
	}
	first := resumeHistory(t, h, "resume-chat", nil)
	delivered := map[string]bool{}
	for _, page := range first {
		for _, id := range wirePageIDs(t, page) {
			delivered[id] = true
		}
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var header struct {
		ID string `json:"id"`
	}
	for i, b := range raw {
		if b == '\n' {
			if err := json.Unmarshal(raw[:i], &header); err != nil {
				t.Fatal(err)
			}
			break
		}
	}
	cursor := map[string]any{"sessionId": header.ID, "firstEntryId": "entry-0000", "lastEntryId": leaf, "historyComplete": true}
	second := resumeHistory(t, h, "resume-chat", cursor)
	for _, page := range second {
		for _, id := range wirePageIDs(t, page) {
			if delivered[id] {
				t.Fatalf("resume re-emitted delivered entry %s", id)
			}
		}
	}
	if len(second) != 1 || second[0]["final"] != true {
		t.Fatalf("want one empty terminal: %v", second)
	}
}

func TestReconnectResumeGrowthAndFallback(t *testing.T) {
	for _, tc := range []struct {
		name, first, last string
		complete, invalid bool
		want              int
	}{
		{"partial with gap exceeding tail", "entry-0140", "entry-0299", false, false, 270},
		{"complete with growth", "entry-0000", "entry-0299", true, false, 130},
		{"unknown anchor", "missing", "entry-0299", false, true, 430},
		{"invalid root claim", "entry-0140", "entry-0299", true, true, 430},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHistoryBridgeHarness(t, historyE2ETestBudget)
			path, _ := writeBridgeHistory(t, 430)
			h.saveChat(t, "resume-growth", path)
			if err := h.daemon.LoadSessionFile(path); err != nil {
				t.Fatal(err)
			}
			initial := resumeHistory(t, h, "resume-growth", nil)
			cursor := map[string]any{"sessionId": initial[0]["historySessionId"], "firstEntryId": tc.first, "lastEntryId": tc.last, "historyComplete": tc.complete}
			pages := resumeHistory(t, h, "resume-growth", cursor)
			ids := map[string]bool{}
			for _, page := range pages {
				if (page["resume"] == nil) != tc.invalid {
					t.Fatalf("unexpected continuity: %v", page["resume"])
				}
				for _, id := range wirePageIDs(t, page) {
					if ids[id] {
						t.Fatalf("duplicate %s", id)
					}
					ids[id] = true
					if !tc.invalid && id >= tc.first && id <= tc.last {
						t.Fatalf("covered id %s", id)
					}
				}
			}
			if len(ids) != tc.want {
				t.Fatalf("got %d ids, want %d", len(ids), tc.want)
			}
			for i := 300; i < 430; i++ {
				if !ids[fmt.Sprintf("entry-%04d", i)] {
					t.Fatalf("missing append %d", i)
				}
			}
		})
	}
}

func TestReconnectResumeEngineOnlyTip(t *testing.T) {
	h := newHistoryBridgeHarness(t, historyE2ETestBudget)
	path, _, _ := seedLargeHybridHistory(t, h)
	h.saveChat(t, "resume-engine-tip", path)
	first := resumeHistory(t, h, "resume-engine-tip", nil)
	cursor := map[string]any{"sessionId": first[0]["historySessionId"], "firstEntryId": "entry-1", "lastEntryId": "entry-83", "historyComplete": true}
	pages := resumeHistory(t, h, "resume-engine-tip", cursor)
	for _, page := range pages {
		if page["resume"] == nil {
			t.Fatal("engine-only tip not honored")
		}
		if ids := wirePageIDs(t, page); len(ids) > 0 {
			t.Fatalf("replayed ids: %v", ids)
		}
	}
}
