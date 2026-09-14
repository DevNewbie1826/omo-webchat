package session

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/dirsync"
)

// persistedNotice is one journal entry on disk. Only the fields a notice
// frame carries are stored; a replay reconstructs the frame verbatim from
// them.
type persistedNotice struct {
	Kind      FrameKind      `json:"kind"`
	SessionID string         `json:"session_id"`
	Data      map[string]any `json:"data"`
}

// persistedNoticeJournal is the on-disk state of one chat's notice journal:
// the monotonic stamping sequence plus the retained entries in replay order.
// The sequence is stored even when entries were evicted, so a restarted
// manager continues past every persisted nid; the nids themselves carry a
// per-instance generation qualifier, so identities issued before a restart
// are never re-issued by the restarted one.
type persistedNoticeJournal struct {
	Seq         uint64                                    `json:"seq"`
	Entries     []persistedNotice                         `json:"entries"`
	Derivations map[string]bool                           `json:"derivations,omitempty"`
	Transcripts map[string]persistedTranscriptNoticeState `json:"transcripts,omitempty"`
}

func noticeJournalPath(dir, chatID string) string {
	return filepath.Join(dir, chatID+".json")
}

// loadNoticeJournal reads the persisted journal for chatID. A missing file
// is the normal empty journal. A file that fails to decode, or that decodes
// but violates journal invariants, is moved aside as
// "<chatID>.json.corrupt-<unixts>" for inspection instead of being destroyed,
// and the journal starts empty: notices are best-effort durable, so an
// unusable file must never block startup or panic.
func loadNoticeJournal(dir, chatID string) persistedNoticeJournal {
	path := noticeJournalPath(dir, chatID)
	raw, err := os.ReadFile(path)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			slog.Warn("failed to read notice journal; starting empty", "chat_id", chatID, "error", err)
		}
		return persistedNoticeJournal{}
	}
	var state persistedNoticeJournal
	if err := json.Unmarshal(raw, &state); err != nil {
		return quarantineNoticeJournal(path, chatID, err)
	}
	if err := validateNoticeJournalState(chatID, state); err != nil {
		return quarantineNoticeJournal(path, chatID, err)
	}
	return state
}

// quarantineNoticeJournal moves an unusable journal aside and starts empty.
func quarantineNoticeJournal(path, chatID string, cause error) persistedNoticeJournal {
	aside := fmt.Sprintf("%s.corrupt-%d", path, time.Now().Unix())
	if renameErr := os.Rename(path, aside); renameErr != nil {
		slog.Warn("failed to move corrupt notice journal aside; starting empty", "chat_id", chatID, "error", renameErr)
		return persistedNoticeJournal{}
	}
	slog.Warn("notice journal corrupt; moved aside and starting empty", "chat_id", chatID, "path", aside, "error", cause)
	return persistedNoticeJournal{}
}

// validateNoticeJournalState rejects a decodable file whose contents violate
// journal invariants. The persisted file is a system boundary: successful
// unmarshalling does not establish journal validity, and an admitted
// inconsistent state would replay notices or re-issue their nids. seq cannot
// be negative (uint64); a negative JSON value fails decoding instead. The
// retained identities must be unique (the client dedupes retained notices by
// nid string, so an admitted duplicate silently drops one retained record)
// and their sequence tails must strictly increase in replay order; every
// stamped nid carries a numeric tail after its last ':' (legacy
// "<chatID>:<seq>" and generation "<chatID>:g<gen>:<seq>" alike), so a nid
// without one is corruption too.
func validateNoticeJournalState(chatID string, state persistedNoticeJournal) error {
	if len(state.Entries) > NoticeJournalCapacity {
		return fmt.Errorf("journal holds %d entries, over cap %d", len(state.Entries), NoticeJournalCapacity)
	}
	prefix := chatID + ":"
	seen := make(map[string]struct{}, len(state.Entries))
	var prevTail uint64
	for i, e := range state.Entries {
		nid, _ := e.Data["nid"].(string)
		at, _ := e.Data["at"].(string)
		if nid == "" {
			return fmt.Errorf("entry %d has empty nid", i)
		}
		if !strings.HasPrefix(nid, prefix) {
			return fmt.Errorf("entry %d nid %q is not %q-prefixed", i, nid, prefix)
		}
		tail, ok := noticeNIDTail(nid)
		if !ok {
			return fmt.Errorf("entry %d nid %q has no numeric sequence tail", i, nid)
		}
		if _, duplicate := seen[nid]; duplicate {
			return fmt.Errorf("entry %d repeats retained nid %q", i, nid)
		}
		seen[nid] = struct{}{}
		if i > 0 && tail <= prevTail {
			return fmt.Errorf("entry %d nid tail %d does not follow retained tail %d", i, tail, prevTail)
		}
		prevTail = tail
		if at == "" {
			return fmt.Errorf("entry %d has empty receipt time", i)
		}
		if _, err := time.Parse(time.RFC3339Nano, at); err != nil {
			return fmt.Errorf("entry %d receipt time %q is not RFC3339: %w", i, at, err)
		}
	}
	if state.Seq < prevTail {
		return fmt.Errorf("seq %d is below the highest persisted nid tail %d", state.Seq, prevTail)
	}
	return nil
}

// noticeNIDTail extracts the numeric sequence suffix of a stamped nid
// ("<chatID>:g<generation>:<seq>" or the legacy "<chatID>:<seq>").
func noticeNIDTail(nid string) (uint64, bool) {
	idx := strings.LastIndexByte(nid, ':')
	if idx < 0 {
		return 0, false
	}
	tail, err := strconv.ParseUint(nid[idx+1:], 10, 64)
	if err != nil {
		return 0, false
	}
	return tail, true
}

// saveNoticeJournal atomically replaces the persisted journal: temp file in
// the target directory, write, chmod 0600, fsync, close, rename over the
// target, then fsync the directory - the same install sequence the cursor
// store uses for its state file.
func saveNoticeJournal(dir, chatID string, state persistedNoticeJournal) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("creating notice directory: %w", err)
	}
	path := noticeJournalPath(dir, chatID)
	raw, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return fmt.Errorf("encoding notice journal: %w", err)
	}
	tmp, err := os.CreateTemp(dir, ".notice-*")
	if err != nil {
		return fmt.Errorf("creating temp file: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op after successful rename
	closeOnFailure := func(op string, opErr error) error {
		if closeErr := tmp.Close(); closeErr != nil {
			return fmt.Errorf("%s: %w", op, errors.Join(opErr, fmt.Errorf("closing temp file: %w", closeErr)))
		}
		return fmt.Errorf("%s: %w", op, opErr)
	}
	if _, err := tmp.Write(raw); err != nil {
		return closeOnFailure("writing temp file", err)
	}
	if err := tmp.Chmod(0o600); err != nil {
		return closeOnFailure("setting temp file mode", err)
	}
	if err := tmp.Sync(); err != nil {
		return closeOnFailure("syncing temp file", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("closing temp file: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("replacing notice journal: %w", err)
	}
	d, err := os.Open(dir)
	if err != nil {
		return fmt.Errorf("opening notice directory: %w", err)
	}
	if err := dirsync.Handle(d); err != nil {
		if closeErr := d.Close(); closeErr != nil {
			err = errors.Join(err, fmt.Errorf("closing notice directory: %w", closeErr))
		}
		return fmt.Errorf("syncing notice directory: %w", err)
	}
	if err := d.Close(); err != nil {
		return fmt.Errorf("closing notice directory: %w", err)
	}
	return nil
}

// removeNoticeJournal drops the persisted journal for chatID. A missing file
// is the normal never-persisted case.
func removeNoticeJournal(dir, chatID string) error {
	if err := os.Remove(noticeJournalPath(dir, chatID)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}
