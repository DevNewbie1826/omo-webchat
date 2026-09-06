package coldhistory

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

// FileOrder retains only graph coordinates and match flags for queue inspection.
// Unlike Stream, it includes abandoned branches and rejects incomplete records
// and broken parents anywhere in the retained file, not just active ancestry.
// Callers own the descriptor, finite snapshot and identity/freshness fences.
type FileOrder struct {
	Header  Header
	EndID   string
	refs    []entryRef
	byID    map[string]int
	matches []bool
	budget  indexBudget
}

// InspectFileOrder reuses the cold-history record parser and index budget. The
// matcher must not retain raw records; transcript bodies are discarded per line.
func InspectFileOrder(ctx context.Context, source io.Reader, options Options, match func(json.RawMessage) bool) (*FileOrder, error) {
	opts, err := normalizeOptions(options)
	if err != nil {
		return nil, err
	}
	order := &FileOrder{byID: make(map[string]int), budget: indexBudget{limit: opts.indexBytes}}
	r := bufio.NewReaderSize(source, opts.chunkBytes)
	var offset int64
	for lineNumber := 1; ; lineNumber++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		line, terminated, n, err := readLine(r, opts.maxLineBytes)
		if n == 0 && errors.Is(err, io.EOF) {
			break
		}
		if err != nil && !errors.Is(err, io.EOF) {
			return nil, err
		}
		if !terminated {
			return nil, lineError(ErrCorruptLine, lineNumber, offset, errors.New("incomplete final record"))
		}
		raw := bytes.TrimSpace(line)
		if len(raw) > 0 {
			if order.Header.ID == "" {
				order.Header, err = parseHeader(raw)
				if err != nil {
					return nil, lineError(ErrInvalidHeader, lineNumber, offset, err)
				}
			} else {
				ref, err := parseEntry(raw, offset, n, lineNumber)
				if err != nil {
					return nil, lineError(ErrCorruptLine, lineNumber, offset, err)
				}
				if err := order.add(ref, raw, match); err != nil {
					return nil, err
				}
			}
		}
		offset += n
	}
	if order.Header.ID == "" {
		return nil, ErrEmpty
	}
	return order, ctx.Err()
}

func (o *FileOrder) add(ref entryRef, raw json.RawMessage, match func(json.RawMessage) bool) error {
	if _, exists := o.byID[ref.id]; exists {
		return fmt.Errorf("%w: %q", ErrDuplicateID, ref.id)
	}
	if ref.parentID != "" {
		if _, exists := o.byID[ref.parentID]; !exists {
			return fmt.Errorf("%w: %q references %q", ErrBrokenBranch, ref.id, ref.parentID)
		}
	}
	// reserveEntry's active-branch copy allowance also covers the match flag.
	if err := o.budget.reserveEntry(ref); err != nil {
		return err
	}
	o.byID[ref.id] = len(o.refs)
	o.refs = append(o.refs, ref)
	o.matches = append(o.matches, match != nil && match(raw))
	o.EndID = ref.id
	return nil
}

// AddTail validates the daemon's file-order suffix, allowing parents in any
// retained branch or earlier tail entry. A failed order must be discarded.
func (o *FileOrder) AddTail(ctx context.Context, entries []json.RawMessage, leaf string, match func(json.RawMessage) bool) error {
	for i, raw := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		ref, err := parseEntry(raw, 0, int64(len(raw)), i)
		if err != nil {
			return fmt.Errorf("%w: tail entry %d: %v", ErrCorruptLine, i, err)
		}
		if err := o.add(ref, raw, match); err != nil {
			return err
		}
	}
	if leaf == "" && len(o.refs) == 0 {
		return nil
	}
	if _, ok := o.byID[leaf]; !ok {
		return fmt.Errorf("%w: daemon leaf %q not retained", ErrBrokenBranch, leaf)
	}
	return ctx.Err()
}

// Checkpoint never converts a daemon leaf moved backward into a new dispatch
// boundary: queue cursors are file-order boundaries, not active-branch tips.
func (o *FileOrder) Checkpoint(leaf string) (string, error) {
	if leaf != o.EndID {
		return "", fmt.Errorf("%w: daemon leaf %q differs from file-order end %q", ErrBrokenBranch, leaf, o.EndID)
	}
	return leaf, nil
}

// MatchAfter accepts retained positives even off the active branch. A negative
// grants permission to resend only with a retained cursor on current ancestry
// and a current file-order leaf. Empty cursor is the proven start boundary of
// the complete, parent-validated retained graph (or a verified native empty file).
func (o *FileOrder) MatchAfter(cursor, leaf string) (bool, error) {
	position := -1
	if cursor != "" {
		var exists bool
		position, exists = o.byID[cursor]
		if !exists {
			return false, fmt.Errorf("%w: queue cursor %q not retained", ErrBrokenBranch, cursor)
		}
	}
	for i := position + 1; i < len(o.matches); i++ {
		if o.matches[i] {
			return true, nil
		}
	}
	if _, err := o.Checkpoint(leaf); err != nil {
		return false, err
	}
	if cursor == "" {
		return false, nil
	}
	for id := leaf; id != ""; {
		if id == cursor {
			return false, nil
		}
		index, exists := o.byID[id]
		if !exists {
			return false, ErrBrokenBranch
		}
		id = o.refs[index].parentID
	}
	return false, fmt.Errorf("%w: queue cursor %q is not on current ancestry", ErrBrokenBranch, cursor)
}
