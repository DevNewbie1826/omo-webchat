// Package coldhistory streams the active branch of an omo engine session file.
//
// Live session-file probing established that these files are UTF-8 JSONL: a
// session header is followed by entries linked through id and parentId. The
// final entry in file order is the active leaf. Stream indexes only graph
// coordinates on its first bounded pass, then seeks through the active branch
// and emits the opaque entry JSON on a second bounded pass.
package coldhistory

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"unsafe"

	"github.com/DevNewbie1826/omo-webchat/internal/fileio"
)

const (
	DefaultChunkBytes   = 64 << 10
	DefaultMaxLineBytes = 4 << 20
	DefaultPageBytes    = 4 << 20
	DefaultPageEntries  = 100
	DefaultIndexBytes   = 64 << 20
	DefaultTailEntries  = 60
	DefaultWarmChunk    = 100
)

var (
	ErrEmpty               = errors.New("empty session file")
	ErrInvalidHeader       = errors.New("invalid session header")
	ErrCorruptLine         = errors.New("corrupt session line")
	ErrLineTooLong         = errors.New("session line exceeds limit")
	ErrDuplicateID         = errors.New("duplicate session entry id")
	ErrBrokenBranch        = errors.New("active branch has missing parent")
	ErrBranchCycle         = errors.New("active branch contains a cycle")
	ErrIndexBudgetExceeded = errors.New("session index exceeds memory budget")
	ErrInvalidOptions      = errors.New("invalid cold history options")
)

// IndexBudgetError reports the configured bound and the index bytes required
// by the entry that crossed it. It supports errors.Is with
// ErrIndexBudgetExceeded.
type IndexBudgetError struct {
	Limit    int64
	Used     int64
	Required int64
}

func (e *IndexBudgetError) Error() string {
	return fmt.Sprintf("%v: limit %d bytes, used %d bytes, required %d bytes", ErrIndexBudgetExceeded, e.Limit, e.Used, e.Required)
}

func (e *IndexBudgetError) Unwrap() error { return ErrIndexBudgetExceeded }

// ResumeCursor identifies a contiguous delivered range on one active branch.
type ResumeCursor struct {
	SessionID       string `json:"sessionId"`
	FirstEntryID    string `json:"firstEntryId"`
	LastEntryID     string `json:"lastEntryId"`
	HistoryComplete bool   `json:"historyComplete"`
}

// Options bounds disk reads, individual JSONL records, the aggregate retained
// index, and emitted pages. Zero fields select the defaults. MaxLineBytes may
// not exceed PageBytes, so a successful stream never emits a page larger than
// PageBytes.
type Options struct {
	// ResolveResume can map an engine-only tip onto the validated disk leaf.
	ResolveResume func(Metadata) (*ResumeCursor, error)
	Resume        *ResumeCursor
	ChunkBytes    int
	MaxLineBytes  int
	PageBytes     int
	PageEntries   int
	IndexBytes    int64
}

// Header contains the known session-header fields and its original JSON. The
// raw form preserves fields added by newer engines.
type Header struct {
	Raw           json.RawMessage
	Type          string
	ID            string
	Version       int
	Timestamp     string
	CWD           string
	ParentSession string
}

// Metadata describes the complete active branch. It is available on every
// callback, including the empty final page of a header-only file.
type Metadata struct {
	Resume *ResumeCursor
	Header Header
	LeafID string
	Total  int
}

// Page is one ordered segment of the active branch. Start is the zero-based
// branch index of Entries. Final is true only for the last callback, which is
// also the page that reaches the branch root. Head is true for backward warm
// chunks emitted after a tail; Stream always leaves it false.
type Page struct {
	Entries []json.RawMessage
	Start   int
	Final   bool
	Head    bool
}

// Stream reads sessionPath without loading the complete file into memory and
// emits root-to-leaf active-branch entries. The callback is invoked
// synchronously; it may retain Entries. Missing files remain detectable with
// errors.Is(err, os.ErrNotExist).
func Stream(ctx context.Context, sessionPath string, options Options, emit func(Metadata, Page) error) (Metadata, error) {
	if ctx == nil {
		return Metadata{}, fmt.Errorf("coldhistory: nil context")
	}
	if emit == nil {
		return Metadata{}, fmt.Errorf("coldhistory: nil page callback")
	}
	opts, err := normalizeOptions(options)
	if err != nil {
		return Metadata{}, err
	}

	f, err := fileio.Open(sessionPath)
	if err != nil {
		return Metadata{}, fmt.Errorf("coldhistory: open %q: %w", sessionPath, err)
	}
	defer f.Close()

	metadata, err := stream(ctx, f, opts, emit)
	if err != nil {
		return Metadata{}, fmt.Errorf("coldhistory: read %q: %w", sessionPath, err)
	}
	return metadata, nil
}

// StreamTailFirst reads sessionPath once, indexes the active branch, then emits
// pages covering the last tailEntries entries in ascending order, followed by
// earlier ranges newest-first in chunks of at most warmChunk entries. A warm
// range whose entries exceed the page byte or count bound is itself split
// into several pages; those pages also arrive newest-first, so a consumer
// that prepends each page rebuilds the branch in arrival order. Page.Start
// is the absolute branch index of Entries. Page.Final is true on the page that
// reaches the root. Page.Head is true on backward warm chunks. Zero tailEntries
// or warmChunk select DefaultTailEntries and DefaultWarmChunk.
func StreamTailFirst(ctx context.Context, sessionPath string, options Options, tailEntries, warmChunk int, emit func(Metadata, Page) error) (Metadata, error) {
	if ctx == nil {
		return Metadata{}, fmt.Errorf("coldhistory: nil context")
	}
	if emit == nil {
		return Metadata{}, fmt.Errorf("coldhistory: nil page callback")
	}
	opts, err := normalizeOptions(options)
	if err != nil {
		return Metadata{}, err
	}
	tailEntries, warmChunk, err = normalizeTailFirst(tailEntries, warmChunk)
	if err != nil {
		return Metadata{}, err
	}

	f, err := fileio.Open(sessionPath)
	if err != nil {
		return Metadata{}, fmt.Errorf("coldhistory: open %q: %w", sessionPath, err)
	}
	defer f.Close()

	metadata, err := streamTailFirst(ctx, f, opts, tailEntries, warmChunk, emit)
	if err != nil {
		return Metadata{}, fmt.Errorf("coldhistory: read %q: %w", sessionPath, err)
	}
	return metadata, nil
}

func stream(ctx context.Context, source io.ReadSeeker, opts normalizedOptions, emit func(Metadata, Page) error) (Metadata, error) {
	metadata, branch, err := index(ctx, source, opts)
	if err != nil {
		return Metadata{}, err
	}
	if err := emitBranch(ctx, source, opts, metadata, branch, emit); err != nil {
		return Metadata{}, err
	}
	return metadata, nil
}

func streamTailFirst(ctx context.Context, source io.ReadSeeker, opts normalizedOptions, tailEntries, warmChunk int, emit func(Metadata, Page) error) (Metadata, error) {
	metadata, branch, err := index(ctx, source, opts)
	if err != nil {
		return Metadata{}, err
	}
	cursor := opts.resume
	if opts.resolveResume != nil {
		cursor, err = opts.resolveResume(metadata)
		if err != nil {
			return Metadata{}, err
		}
	}
	if cursor != nil && cursor.SessionID == metadata.Header.ID {
		first, last := -1, -1
		for i, ref := range branch {
			if ref.id == cursor.FirstEntryID {
				first = i
			}
			if ref.id == cursor.LastEntryID {
				last = i
			}
		}
		if first >= 0 && last >= first && (!cursor.HistoryComplete || first == 0) {
			metadata.Resume = cursor
			// An empty callback still validates the session and fetches the engine tail.
			if last+1 == len(branch) {
				err = emit(metadata, Page{Entries: []json.RawMessage{}, Start: last + 1, Final: first == 0})
			} else {
				err = emitRange(ctx, source, opts, metadata, branch, last+1, len(branch), false, first == 0, emit)
			}
			if err != nil {
				return Metadata{}, err
			}
			for pos := first; pos > 0; {
				start := max(0, pos-warmChunk)
				if err := emitRange(ctx, source, opts, metadata, branch, start, pos, true, start == 0, emit); err != nil {
					return Metadata{}, err
				}
				pos = start
			}
			return metadata, nil
		}
	}
	if err := emitTailFirst(ctx, source, opts, metadata, branch, tailEntries, warmChunk, emit); err != nil {
		return Metadata{}, err
	}
	return metadata, nil
}

type normalizedOptions struct {
	resolveResume func(Metadata) (*ResumeCursor, error)
	resume        *ResumeCursor
	chunkBytes    int
	maxLineBytes  int
	pageBytes     int
	pageEntries   int
	indexBytes    int64
}

func normalizeOptions(options Options) (normalizedOptions, error) {
	opts := normalizedOptions{
		resolveResume: options.ResolveResume,
		resume:        options.Resume,
		chunkBytes:    options.ChunkBytes,
		maxLineBytes:  options.MaxLineBytes,
		pageBytes:     options.PageBytes,
		pageEntries:   options.PageEntries,
		indexBytes:    options.IndexBytes,
	}
	if opts.chunkBytes == 0 {
		opts.chunkBytes = DefaultChunkBytes
	}
	if opts.maxLineBytes == 0 {
		opts.maxLineBytes = DefaultMaxLineBytes
	}
	if opts.pageBytes == 0 {
		opts.pageBytes = DefaultPageBytes
	}
	if opts.pageEntries == 0 {
		opts.pageEntries = DefaultPageEntries
	}
	if opts.indexBytes == 0 {
		opts.indexBytes = DefaultIndexBytes
	}
	if opts.chunkBytes < 1 || opts.maxLineBytes < 1 || opts.pageBytes < 1 || opts.pageEntries < 1 || opts.indexBytes < 1 {
		return normalizedOptions{}, fmt.Errorf("%w: all bounds must be positive", ErrInvalidOptions)
	}
	if opts.maxLineBytes > opts.pageBytes {
		return normalizedOptions{}, fmt.Errorf("%w: MaxLineBytes (%d) exceeds PageBytes (%d)", ErrInvalidOptions, opts.maxLineBytes, opts.pageBytes)
	}
	return opts, nil
}

func normalizeTailFirst(tailEntries, warmChunk int) (int, int, error) {
	if tailEntries == 0 {
		tailEntries = DefaultTailEntries
	}
	if warmChunk == 0 {
		warmChunk = DefaultWarmChunk
	}
	if tailEntries < 1 || warmChunk < 1 {
		return 0, 0, fmt.Errorf("%w: tail and warm bounds must be positive", ErrInvalidOptions)
	}
	return tailEntries, warmChunk, nil
}

type entryRef struct {
	id       string
	parentID string
	offset   int64
	length   int64
	line     int
}

type entryEnvelope struct {
	Type     string          `json:"type"`
	ID       string          `json:"id"`
	ParentID json.RawMessage `json:"parentId"`
}

type indexBudget struct {
	limit int64
	used  int64
}

// reserveEntry includes the retained ID bytes, map coordinate, the refs slice
// at its worst-case 2x growth, and one full active-branch reference. The map
// allowance covers a key/value slot plus bucket load and growth overhead.
func (b *indexBudget) reserveEntry(ref entryRef) error {
	const mapEntryBytes = int64(3 * (unsafe.Sizeof("") + unsafe.Sizeof(int(0))))
	fixed := 3*int64(unsafe.Sizeof(entryRef{})) + mapEntryBytes
	required := fixed + int64(len(ref.id)) + int64(len(ref.parentID))
	if required > b.limit-b.used {
		total := b.used + required
		if total < b.used {
			total = int64(^uint64(0) >> 1)
		}
		return &IndexBudgetError{Limit: b.limit, Used: b.used, Required: total}
	}
	b.used += required
	return nil
}

func index(ctx context.Context, r io.Reader, opts normalizedOptions) (Metadata, []entryRef, error) {
	reader := bufio.NewReaderSize(r, opts.chunkBytes)
	var refs []entryRef
	byID := make(map[string]int)
	budget := indexBudget{limit: opts.indexBytes}
	var metadata Metadata
	var offset int64
	lineNumber := 0
	headerSeen := false

	for {
		if err := ctx.Err(); err != nil {
			return Metadata{}, nil, err
		}
		start := offset
		line, terminated, consumed, readErr := readLine(reader, opts.maxLineBytes)
		offset += consumed
		if consumed == 0 && errors.Is(readErr, io.EOF) {
			break
		}
		lineNumber++
		meaningful := bytes.TrimSpace(line)
		if len(meaningful) != 0 {
			if !headerSeen {
				header, err := parseHeader(meaningful)
				if err != nil {
					return Metadata{}, nil, lineError(ErrInvalidHeader, lineNumber, start, err)
				}
				metadata.Header = header
				headerSeen = true
			} else {
				ref, err := parseEntry(meaningful, start, consumed, lineNumber)
				if err != nil {
					if !terminated && errors.Is(readErr, io.EOF) {
						break // A malformed unterminated final line is a torn append.
					}
					return Metadata{}, nil, lineError(ErrCorruptLine, lineNumber, start, err)
				}
				if _, exists := byID[ref.id]; exists {
					return Metadata{}, nil, lineError(ErrDuplicateID, lineNumber, start, fmt.Errorf("id %q", ref.id))
				}
				if err := budget.reserveEntry(ref); err != nil {
					return Metadata{}, nil, fmt.Errorf("index entry at line %d (byte %d): %w", lineNumber, start, err)
				}
				byID[ref.id] = len(refs)
				refs = append(refs, ref)
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				break
			}
			return Metadata{}, nil, readErr
		}
	}

	if !headerSeen {
		return Metadata{}, nil, ErrEmpty
	}
	if len(refs) == 0 {
		return metadata, nil, nil
	}

	leaf := refs[len(refs)-1]
	metadata.LeafID = leaf.id
	branch := make([]entryRef, 0, len(refs))
	current := leaf
	for {
		if len(branch) >= len(refs) {
			return Metadata{}, nil, fmt.Errorf("%w at entry %q", ErrBranchCycle, current.id)
		}
		branch = append(branch, current)
		if current.parentID == "" {
			break
		}
		parentIndex, ok := byID[current.parentID]
		if !ok {
			return Metadata{}, nil, fmt.Errorf("%w: entry %q references %q", ErrBrokenBranch, current.id, current.parentID)
		}
		current = refs[parentIndex]
	}
	for left, right := 0, len(branch)-1; left < right; left, right = left+1, right-1 {
		branch[left], branch[right] = branch[right], branch[left]
	}
	metadata.Total = len(branch)
	return metadata, branch, nil
}

func parseHeader(raw []byte) (Header, error) {
	var wire struct {
		Type          string `json:"type"`
		ID            string `json:"id"`
		Version       int    `json:"version"`
		Timestamp     string `json:"timestamp"`
		CWD           string `json:"cwd"`
		ParentSession string `json:"parentSession"`
	}
	if err := json.Unmarshal(raw, &wire); err != nil {
		return Header{}, err
	}
	if wire.Type != "session" || wire.ID == "" {
		return Header{}, fmt.Errorf("expected type session with a non-empty id")
	}
	return Header{
		Raw: append(json.RawMessage(nil), raw...), Type: wire.Type, ID: wire.ID,
		Version: wire.Version, Timestamp: wire.Timestamp, CWD: wire.CWD,
		ParentSession: wire.ParentSession,
	}, nil
}

func parseEntry(raw []byte, offset, length int64, line int) (entryRef, error) {
	var wire entryEnvelope
	if err := json.Unmarshal(raw, &wire); err != nil {
		return entryRef{}, err
	}
	if wire.Type == "" || wire.Type == "session" || wire.ID == "" || len(wire.ParentID) == 0 {
		return entryRef{}, fmt.Errorf("entry requires type, id, and parentId")
	}
	var parentID string
	if !bytes.Equal(bytes.TrimSpace(wire.ParentID), []byte("null")) {
		if err := json.Unmarshal(wire.ParentID, &parentID); err != nil {
			return entryRef{}, fmt.Errorf("parentId must be a string or null: %w", err)
		}
	}
	return entryRef{id: wire.ID, parentID: parentID, offset: offset, length: length, line: line}, nil
}

func lineError(kind error, line int, offset int64, cause error) error {
	return fmt.Errorf("%w at line %d (byte %d): %v", kind, line, offset, cause)
}

func readLine(reader *bufio.Reader, maxBytes int) ([]byte, bool, int64, error) {
	line := make([]byte, 0, min(reader.Size(), maxBytes))
	var consumed int64
	for {
		fragment, err := reader.ReadSlice('\n')
		consumed += int64(len(fragment))
		content := fragment
		terminated := len(fragment) > 0 && fragment[len(fragment)-1] == '\n'
		if terminated {
			content = fragment[:len(fragment)-1]
		}
		if len(content) > maxBytes-len(line) {
			return nil, terminated, consumed, ErrLineTooLong
		}
		line = append(line, content...)
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		return line, terminated, consumed, err
	}
}

func emitBranch(ctx context.Context, file io.ReadSeeker, opts normalizedOptions, metadata Metadata, branch []entryRef, emit func(Metadata, Page) error) error {
	return emitRange(ctx, file, opts, metadata, branch, 0, len(branch), false, true, emit)
}

func emitTailFirst(ctx context.Context, file io.ReadSeeker, opts normalizedOptions, metadata Metadata, branch []entryRef, tailEntries, warmChunk int, emit func(Metadata, Page) error) error {
	n := len(branch)
	tailStart := n - tailEntries
	if tailStart < 0 {
		tailStart = 0
	}
	if err := emitRange(ctx, file, opts, metadata, branch, tailStart, n, false, tailStart == 0, emit); err != nil {
		return err
	}
	for pos := tailStart; pos > 0; {
		start := pos - warmChunk
		if start < 0 {
			start = 0
		}
		if err := emitRange(ctx, file, opts, metadata, branch, start, pos, true, start == 0, emit); err != nil {
			return err
		}
		pos = start
	}
	return nil
}

func emitRange(ctx context.Context, file io.ReadSeeker, opts normalizedOptions, metadata Metadata, branch []entryRef, lo, hi int, head, complete bool, emit func(Metadata, Page) error) error {
	if lo == hi {
		if complete {
			return emit(metadata, Page{Entries: []json.RawMessage{}, Start: lo, Final: true, Head: head})
		}
		return nil
	}
	if head {
		return emitHeadRange(ctx, file, opts, metadata, branch, lo, hi, complete, emit)
	}

	page := make([]json.RawMessage, 0, min(opts.pageEntries, hi-lo))
	pageBytes := 0
	pageStart := lo
	flush := func(final bool) error {
		if err := emit(metadata, Page{Entries: page, Start: pageStart, Final: final, Head: head}); err != nil {
			return fmt.Errorf("page callback: %w", err)
		}
		pageStart += len(page)
		page = make([]json.RawMessage, 0, min(opts.pageEntries, hi-pageStart))
		pageBytes = 0
		return nil
	}

	for i := lo; i < hi; i++ {
		ref := branch[i]
		if err := ctx.Err(); err != nil {
			return err
		}
		raw, err := readRecord(file, ref, opts.chunkBytes)
		if err != nil {
			return lineError(ErrCorruptLine, ref.line, ref.offset, err)
		}
		if len(page) > 0 && (len(page) >= opts.pageEntries || pageBytes+len(raw) > opts.pageBytes) {
			if err := flush(false); err != nil {
				return err
			}
		}
		page = append(page, raw)
		pageBytes += len(raw)
		if i == hi-1 {
			return flush(complete)
		}
	}
	return nil
}

// emitHeadRange emits one backward warm range [lo, hi) newest-first: it walks
// from hi-1 down to lo and flushes each byte/count-bounded page as soon as it
// is full, so a range the bounds split across several pages delivers those
// pages newest-first too. Entries within a page stay in ascending branch
// order, so a prepend-style consumer rebuilds the range by stacking pages in
// arrival order; only the page that reaches lo, the oldest entry of the
// range, can carry complete.
func emitHeadRange(ctx context.Context, file io.ReadSeeker, opts normalizedOptions, metadata Metadata, branch []entryRef, lo, hi int, complete bool, emit func(Metadata, Page) error) error {
	page := make([]json.RawMessage, 0, min(opts.pageEntries, hi-lo))
	pageBytes := 0
	pageTop := hi - 1
	flush := func(final bool) error {
		start := pageTop - len(page) + 1
		entries := make([]json.RawMessage, len(page))
		for i, raw := range page {
			entries[len(page)-1-i] = raw
		}
		if err := emit(metadata, Page{Entries: entries, Start: start, Final: final, Head: true}); err != nil {
			return fmt.Errorf("page callback: %w", err)
		}
		page = make([]json.RawMessage, 0, min(opts.pageEntries, start-lo))
		pageBytes = 0
		return nil
	}

	for i := hi - 1; i >= lo; i-- {
		ref := branch[i]
		if err := ctx.Err(); err != nil {
			return err
		}
		raw, err := readRecord(file, ref, opts.chunkBytes)
		if err != nil {
			return lineError(ErrCorruptLine, ref.line, ref.offset, err)
		}
		if len(page) > 0 && (len(page) >= opts.pageEntries || pageBytes+len(raw) > opts.pageBytes) {
			if err := flush(false); err != nil {
				return err
			}
		}
		if len(page) == 0 {
			pageTop = i
		}
		page = append(page, raw)
		pageBytes += len(raw)
		if i == lo {
			return flush(complete)
		}
	}
	return nil
}

func readRecord(file io.ReadSeeker, ref entryRef, chunkBytes int) (json.RawMessage, error) {
	if _, err := file.Seek(ref.offset, io.SeekStart); err != nil {
		return nil, err
	}
	remaining := ref.length
	raw := make([]byte, 0, ref.length)
	buffer := make([]byte, min64(int64(chunkBytes), remaining))
	for remaining > 0 {
		want := min64(int64(len(buffer)), remaining)
		n, err := io.ReadFull(file, buffer[:want])
		raw = append(raw, buffer[:n]...)
		remaining -= int64(n)
		if err != nil {
			return nil, err
		}
	}
	raw = bytes.TrimSpace(raw)
	if !json.Valid(raw) {
		return nil, fmt.Errorf("entry changed while streaming")
	}
	return json.RawMessage(raw), nil
}

func min64(a, b int64) int {
	if a < b {
		return int(a)
	}
	return int(b)
}
