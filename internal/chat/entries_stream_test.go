package chat

import (
	"encoding/json"
	"path/filepath"
	"testing"
	"time"
)

// TestSessionOmoHistoryStreamsThroughPump verifies omo's single full
// get_entries response is token-streamed by the pump into paged entries frames
// (one terminal), rather than buffered whole — the fix for sessions exceeding
// the former 16 MiB line cap.
func TestSessionOmoHistoryStreamsThroughPump(t *testing.T) {
	logFile := filepath.Join(t.TempDir(), "rpc.log")
	s, w := startMockSession(t, "chat-omo-stream",
		"MOCK_PI_HISTORY_SIZE=500", // 1000 messages in one get_entries response
		"MOCK_PI_LOG="+logFile,
	)
	t.Cleanup(func() {
		if err := s.Close(); err != nil {
			t.Errorf("close session: %v", err)
		}
	})

	if err := s.Resume(""); err != nil {
		t.Fatalf("load history: %v", err)
	}

	finalFrames := w.waitFor(t, 5*time.Second, "terminal entries frame", func(frames [][]byte) bool {
		return countFinalEntries(frames) >= 1
	})
	if got := countFinalEntries(finalFrames); got != 1 {
		t.Fatalf("terminal entries frames = %d, want 1; frames: %s", got, w.typesString())
	}
	if got := messagesInLastDelivery(finalFrames); got != 1000 {
		t.Fatalf("streamed message count = %d, want 1000", got)
	}

	sawEntries := false
	for _, command := range readRPCLogLines(t, logFile) {
		if command == "get_entries" {
			sawEntries = true
		}
	}
	if !sawEntries {
		t.Fatalf("omo must use get_entries; rpc log: %v", readRPCLogLines(t, logFile))
	}
}

func countFinalEntries(frames [][]byte) int {
	count := 0
	for _, f := range frames {
		var env struct {
			Type  string `json:"type"`
			Final bool   `json:"final"`
		}
		if json.Unmarshal(f, &env) == nil && env.Type == "entries" && env.Final {
			count++
		}
	}
	return count
}

// messagesInLastDelivery sums the entries across the frames of the final
// delivery — the run of entries frames after the previous terminal (or start)
// up to the last terminal frame.
func messagesInLastDelivery(frames [][]byte) int {
	lastTerminal, prevTerminal := -1, -1
	for i, f := range frames {
		var env struct {
			Type  string `json:"type"`
			Final bool   `json:"final"`
		}
		if json.Unmarshal(f, &env) == nil && env.Type == "entries" && env.Final {
			prevTerminal = lastTerminal
			lastTerminal = i
		}
	}
	if lastTerminal == -1 {
		return -1
	}
	total := 0
	for _, f := range frames[prevTerminal+1 : lastTerminal+1] {
		var env struct {
			Type    string          `json:"type"`
			Entries json.RawMessage `json:"entries"`
		}
		if json.Unmarshal(f, &env) != nil || env.Type != "entries" {
			continue
		}
		var arr []json.RawMessage
		_ = json.Unmarshal(env.Entries, &arr)
		total += len(arr)
	}
	return total
}
