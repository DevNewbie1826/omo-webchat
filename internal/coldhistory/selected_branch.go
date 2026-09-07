package coldhistory

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"slices"
)

// SelectedTail is a file-order suffix plus the authoritative selected leaf.
// LeafID may name any retained entry, including an ancestor or another branch.
type SelectedTail struct {
	Entries []json.RawMessage
	LeafID  string
}

// SelectedOptions keeps descriptor ownership and freshness fencing with the
// caller. Source must be a finite snapshot starting at byte zero. ResolveTail
// is called only after the complete disk graph and identity have been checked.
type SelectedOptions struct {
	Options
	ExpectedSessionID string
	RequiredEntryID   string
	ResolveTail       func(context.Context, string) (SelectedTail, error)
}

// Selection separates the selected branch from the final file-order boundary.
// EndID is a durability fence, never a todo state revision.
type Selection struct {
	Metadata
	EndID string
}

// ReadSelectedBranch indexes coordinates, validates a bounded optional resident
// suffix, and emits selected ancestry root-to-leaf. Callbacks are provisional:
// callers must discard their fold if this function or their final fences fail.
// Disk bodies are read one at a time; only the bounded resident suffix is kept.
func ReadSelectedBranch(ctx context.Context, source io.ReadSeeker, options SelectedOptions, emit func(Metadata, Page) error) (Selection, error) {
	opts, err := normalizeOptions(options.Options)
	if err != nil {
		return Selection{}, err
	}
	order, err := InspectFileOrder(ctx, source, options.Options, nil)
	if err != nil {
		return Selection{}, err
	}
	if options.ExpectedSessionID != "" && order.Header.ID != options.ExpectedSessionID {
		return Selection{}, fmt.Errorf("%w: session identity mismatch", ErrInvalidHeader)
	}
	if options.RequiredEntryID != "" {
		if _, ok := order.byID[options.RequiredEntryID]; !ok {
			return Selection{}, fmt.Errorf("%w: accepted file-order boundary not persisted", ErrBrokenBranch)
		}
	}
	diskCount, leaf := len(order.refs), order.EndID
	var tail SelectedTail
	if options.ResolveTail != nil {
		tail, err = options.ResolveTail(ctx, order.EndID)
		if err != nil {
			return Selection{}, err
		}
		size := 0
		for _, raw := range tail.Entries {
			if len(raw) > opts.maxLineBytes || len(raw) > opts.pageBytes-size {
				return Selection{}, ErrLineTooLong
			}
			size += len(raw)
		}
		if err := order.AddTail(ctx, tail.Entries, tail.LeafID, nil); err != nil {
			return Selection{}, err
		}
		leaf = tail.LeafID
	}
	branch := make([]int, 0, len(order.refs))
	for id := leaf; id != ""; {
		i, ok := order.byID[id]
		if !ok {
			return Selection{}, ErrBrokenBranch
		}
		branch = append(branch, i)
		id = order.refs[i].parentID
	}
	metadata := Metadata{Header: order.Header, LeafID: leaf, Total: len(branch)}
	if len(branch) == 0 {
		if err := emit(metadata, Page{Entries: []json.RawMessage{}, Final: true}); err != nil {
			return Selection{}, err
		}
	}
	for n, i := range slices.Backward(branch) {
		if err := ctx.Err(); err != nil {
			return Selection{}, err
		}
		var raw json.RawMessage
		if i < diskCount {
			raw, err = readRecord(source, order.refs[i], opts.chunkBytes)
			if err != nil {
				return Selection{}, err
			}
		} else {
			raw = tail.Entries[i-diskCount]
		}
		if err := emit(metadata, Page{Entries: []json.RawMessage{raw}, Start: len(branch) - 1 - n, Final: n == 0}); err != nil {
			return Selection{}, err
		}
	}
	if err := ctx.Err(); err != nil {
		return Selection{}, err
	}
	return Selection{Metadata: metadata, EndID: order.EndID}, nil
}
