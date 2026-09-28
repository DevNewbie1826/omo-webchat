package coldhistory

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"slices"
)

// ErrEntryNotOnBranch reports a before cursor naming an entry the active
// branch does not retain. Unknown ids and ids on abandoned branches both
// match this sentinel.
var ErrEntryNotOnBranch = errors.New("session entry not on active branch")

// BeforePage is one bounded page of active-branch entries immediately
// preceding a cursor entry, oldest to newest. Start is the zero-based branch
// index of Entries. HistoryComplete is true only when the page reaches the
// branch root, so no older page exists.
type BeforePage struct {
	Entries         []json.RawMessage
	Start           int
	HistoryComplete bool
}

// StreamBefore reads sessionPath and returns up to limit entries immediately
// preceding beforeID on the active branch, in branch order. The page is also
// bounded by Options.PageBytes: entries are dropped from the oldest end until
// the page fits, always keeping at least one entry when any precede beforeID.
// A zero limit selects DefaultPageEntries; a negative limit is invalid.
// Missing files remain detectable with errors.Is(err, os.ErrNotExist), and a
// beforeID absent from the active branch matches ErrEntryNotOnBranch.
func StreamBefore(ctx context.Context, sessionPath string, options Options, beforeID string, limit int) (Metadata, BeforePage, error) {
	if ctx == nil {
		return Metadata{}, BeforePage{}, fmt.Errorf("coldhistory: nil context")
	}
	if limit < 0 {
		return Metadata{}, BeforePage{}, fmt.Errorf("%w: before limit %d is negative", ErrInvalidOptions, limit)
	}
	if limit == 0 {
		limit = DefaultPageEntries
	}
	opts, err := normalizeOptions(options)
	if err != nil {
		return Metadata{}, BeforePage{}, err
	}

	var page BeforePage
	metadata, err := withSessionFile(ctx, sessionPath, opts, func(indexed Metadata, branch []entryRef, source io.ReadSeeker) (Metadata, error) {
		collected, err := beforeFromIndex(ctx, source, opts, indexed, branch, beforeID, limit)
		if err != nil {
			return Metadata{}, err
		}
		page = collected
		return indexed, nil
	})
	if err != nil {
		return Metadata{}, BeforePage{}, err
	}
	return metadata, page, nil
}

// beforeFromIndex walks backwards from the cursor entry and keeps the newest
// preceding entries that fit the count and byte bounds.
func beforeFromIndex(ctx context.Context, source io.ReadSeeker, opts normalizedOptions, metadata Metadata, branch []entryRef, beforeID string, limit int) (BeforePage, error) {
	before := -1
	for i, ref := range branch {
		if ref.id == beforeID {
			before = i
			break
		}
	}
	if before < 0 {
		return BeforePage{}, fmt.Errorf("%w: %q", ErrEntryNotOnBranch, beforeID)
	}

	page := BeforePage{Entries: []json.RawMessage{}}
	pageBytes := 0
	for i := before - 1; i >= 0 && len(page.Entries) < limit; i-- {
		if err := ctx.Err(); err != nil {
			return BeforePage{}, err
		}
		raw, err := readRecord(source, branch[i], opts.chunkBytes)
		if err != nil {
			return BeforePage{}, lineError(ErrCorruptLine, branch[i].line, branch[i].offset, err)
		}
		if len(page.Entries) > 0 && pageBytes+len(raw) > opts.pageBytes {
			break // Dropping the oldest end keeps the newest preceding entries.
		}
		page.Entries = append(page.Entries, raw)
		pageBytes += len(raw)
	}
	slices.Reverse(page.Entries)
	page.Start = before - len(page.Entries)
	page.HistoryComplete = page.Start == 0
	return page, nil
}
