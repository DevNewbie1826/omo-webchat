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

func scanNoticeHistory(ctx context.Context, path, leaf string, replay *transcriptNoticeReplay) (int, error) {
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
			Type    string         `json:"type"`
			ID      string         `json:"id"`
			Message map[string]any `json:"message"`
		}
		if err := json.Unmarshal(raw, &entry); err != nil {
			return 0, err
		}
		if replay != nil && replay.checkpointSource != "" {
			source := "entry:" + entry.ID
			if entry.Type == "message" && entry.Message["role"] == "assistant" {
				source = transcriptMessageSource(entry.Message)
			}
			if source == replay.checkpointSource {
				replay.checkpointOnDisk = true
				replay.newerBoundaries = make(map[string]bool)
			} else if replay.checkpointOnDisk && (entry.Type == "compaction" || entry.Type == "branch_summary") {
				replay.newerBoundaries[entry.ID] = true
			}
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

func (s *Session) countPersistedCompactions(ctx context.Context, path, leaf string, replay *transcriptNoticeReplay) int {
	count, err := scanNoticeHistory(ctx, path, leaf, replay)
	if err != nil {
		// Notice derivation is best effort like journal persistence. Never invent
		// a partial count, or fail an otherwise validated transcript hydration.
		replay.checkpointOnDisk = false
		replay.newerBoundaries = nil
		slog.Warn("failed to count persisted compactions", "chat_id", s.chatID, "error", err)
		return -1
	}
	return count
}
