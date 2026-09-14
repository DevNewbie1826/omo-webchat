package session

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
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
// The sequence is stored even when entries were evicted, so nids stamped
// after a restart can never collide with evicted ones.
type persistedNoticeJournal struct {
	Seq     uint64            `json:"seq"`
	Entries []persistedNotice `json:"entries"`
}

func noticeJournalPath(dir, chatID string) string {
	return filepath.Join(dir, chatID+".json")
}

// loadNoticeJournal reads the persisted journal for chatID. A missing file
// is the normal empty journal. Every other failure degrades to an empty
// journal with one warn line: notices are best-effort durable, so an
// unreadable file must never block startup or panic. A corrupt file is moved
// aside as "<chatID>.json.corrupt-<unixts>" for inspection instead of being
// destroyed.
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
		aside := fmt.Sprintf("%s.corrupt-%d", path, time.Now().Unix())
		if renameErr := os.Rename(path, aside); renameErr != nil {
			slog.Warn("failed to move corrupt notice journal aside; starting empty", "chat_id", chatID, "error", renameErr)
			return persistedNoticeJournal{}
		}
		slog.Warn("notice journal corrupt; moved aside and starting empty", "chat_id", chatID, "path", aside, "error", err)
		return persistedNoticeJournal{}
	}
	return state
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
