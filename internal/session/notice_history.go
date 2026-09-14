package session

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"

	"github.com/DevNewbie1826/omo-webchat/internal/coldhistory"
)

// Hydration streams only active ancestry. The observed engine contract counts
// compactions on every branch, through the same validated disk boundary.
func persistedCompactionCount(ctx context.Context, path, leaf string) (int, error) {
	if leaf == "" {
		return 0, nil
	}
	file, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, coldhistory.DefaultChunkBytes), coldhistory.DefaultMaxLineBytes+1)
	count := 0
	for scanner.Scan() {
		if err := ctx.Err(); err != nil {
			return 0, err
		}
		raw := bytes.TrimSpace(scanner.Bytes())
		if len(raw) == 0 {
			continue
		}
		var entry struct {
			Type string `json:"type"`
			ID   string `json:"id"`
		}
		if err := json.Unmarshal(raw, &entry); err != nil {
			return 0, err
		}
		if entry.Type == "compaction" {
			count++
		}
		if entry.ID == leaf {
			return count, nil
		}
	}
	if err := scanner.Err(); err != nil {
		return 0, err
	}
	return 0, fmt.Errorf("%w: compaction history boundary %q not found", errIncompleteHistory, leaf)
}

func (s *Session) countPersistedCompactions(ctx context.Context, path, leaf string) int {
	count, err := persistedCompactionCount(ctx, path, leaf)
	if err != nil {
		// Notice derivation is best effort like journal persistence. Never invent
		// a partial count, or fail an otherwise validated transcript hydration.
		slog.Warn("failed to count persisted compactions", "chat_id", s.chatID, "error", err)
		return -1
	}
	return count
}
