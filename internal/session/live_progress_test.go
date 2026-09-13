package session

import (
	"encoding/json"
	"testing"
)

func TestLiveProgressSelection_whenUpdatedClockIsEmptyOrMalformed(t *testing.T) {
	for _, tc := range []struct {
		name, clock, want string
	}{
		{"empty clock remains present", `""`, "other"},
		{"invalid clock falls back to creation", `12`, "candidate"},
		{"null clock falls back to creation", `null`, "candidate"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// Given a candidate with a later creation time but an unusual updated clock.
			rows := []json.RawMessage{
				json.RawMessage(`{"task_id":"a","status":"running","updated_at":` + tc.clock + `,"created_at":"2026-09-13","live_progress":{"last_assistant_line":"candidate"}}`),
				json.RawMessage(`{"task_id":"b","status":"running","updated_at":"2026-09-12","live_progress":{"last_assistant_line":"other"}}`),
			}
			// When the shared digest projection selects its progress line.
			got := lastTaskLine(rows)
			// Then optional-clock fallback matches lastLineOf exactly.
			if got == nil || *got != tc.want {
				t.Fatalf("line = %v, want %s", got, tc.want)
			}
		})
	}
}
