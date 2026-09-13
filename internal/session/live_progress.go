package session

import "encoding/json"

// Match the former lastLineOf projection: lexicographic task timestamp order,
// updated_at before created_at, and the later-listed task wins an equal clock.
func lastTaskLine(rows []json.RawMessage) *string {
	var bestLine *string
	bestAt := ""
	for _, raw := range rows {
		var row struct {
			UpdatedAt json.RawMessage `json:"updated_at"`
			CreatedAt string          `json:"created_at"`
			Progress  struct {
				LastLine *string `json:"last_assistant_line"`
				Activity *string `json:"activity"`
			} `json:"live_progress"`
		}
		if json.Unmarshal(raw, &row) != nil {
			continue
		}
		line := row.Progress.LastLine
		if line == nil {
			line = row.Progress.Activity
		}
		if line == nil {
			continue
		}
		at := row.CreatedAt
		var updated *string
		if json.Unmarshal(row.UpdatedAt, &updated) == nil && updated != nil {
			at = *updated
		}
		if bestLine == nil || at >= bestAt {
			bestAt, bestLine = at, line
		}
	}
	return bestLine
}
