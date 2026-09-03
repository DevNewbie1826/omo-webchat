package cursorstore

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"

	"github.com/DevNewbie1826/omo-webchat/internal/adoptcopy"
)

// MigrateLegacySession copies an unknown-provenance session into the store's
// owned directory and atomically records verified provenance. Callers must use
// this hook before GetChatForOpen; a failed migration leaves the original
// identity unchanged and therefore unopenable.
func (s *Store) MigrateLegacySession(ctx context.Context, id string) (Chat, error) {
	chat, err := s.GetChat(id)
	if err != nil {
		return Chat{}, err
	}
	if chat.SessionFile == "" || IsOwnedSession(chat, s.OwnedSessionDir()) || IsInPlaceSession(chat) {
		return chat, nil
	}

	expectedID := chat.DurableSessionID
	if expectedID == "" {
		expectedID, err = legacySessionID(chat.SessionFile)
		if err != nil {
			return Chat{}, fmt.Errorf("%w: %w", ErrAdoptionRequired, err)
		}
	}
	result, err := adoptcopy.Adopt(ctx, chat.SessionFile, s.OwnedSessionDir(), expectedID)
	if err != nil {
		return Chat{}, fmt.Errorf("%w: %w", ErrAdoptionRequired, err)
	}
	if chat.DurableSessionID != "" && chat.DurableSessionID != result.SessionID {
		return Chat{}, fmt.Errorf("%w: durable session identity mismatch", ErrAdoptionRequired)
	}

	// Compare and swap after the copy so a concurrent provider/store update
	// cannot be overwritten by a migration based on stale identity metadata.
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.data.Chats[id]
	if !ok {
		return Chat{}, ErrNotFound
	}
	if IsOwnedSession(current, s.OwnedSessionDir()) {
		return current, nil
	}
	if current.SessionFile != chat.SessionFile || current.DurableSessionID != chat.DurableSessionID {
		return Chat{}, fmt.Errorf("%w: session identity changed during migration", ErrAdoptionRequired)
	}
	owned := Chat{SessionFile: result.Path, SessionProvenance: SessionProvenanceAdopted}
	if !IsOwnedSession(owned, s.OwnedSessionDir()) {
		return Chat{}, fmt.Errorf("%w: invalid owned session destination", ErrAdoptionRequired)
	}
	candidate := cloneState(s.data)
	current.SessionFile = result.Path
	current.DurableSessionID = result.SessionID
	current.SessionProvenance = SessionProvenanceAdopted
	candidate.Chats[id] = current
	if err := s.flushLocked(candidate); err != nil {
		return Chat{}, err
	}
	return current, nil
}

func legacySessionID(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 1<<20)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var header struct {
			Type string `json:"type"`
			ID   string `json:"id"`
		}
		if err := json.Unmarshal(line, &header); err != nil || header.Type != "session" || header.ID == "" {
			return "", errors.New("invalid legacy session header")
		}
		return header.ID, nil
	}
	if err := scanner.Err(); err != nil {
		return "", err
	}
	return "", errors.New("missing legacy session header")
}
