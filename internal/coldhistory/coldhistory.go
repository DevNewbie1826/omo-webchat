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
	"os"
)

const (
	DefaultChunkBytes   = 64 << 10
	DefaultMaxLineBytes = 4 << 20
	DefaultPageBytes    = 4 << 20
	DefaultPageEntries  = 100
)

var (
	ErrEmpty          = errors.New("empty session file")
	ErrInvalidHeader  = errors.New("invalid session header")
	ErrCorruptLine    = errors.New("corrupt session line")
	ErrLineTooLong    = errors.New("session line exceeds limit")
	ErrDuplicateID    = errors.New("duplicate session entry id")
	ErrBrokenBranch   = errors.New("active branch has missing parent")
	ErrBranchCycle    = errors.New("active branch contains a cycle")
	ErrInvalidOptions = errors.New("invalid cold history options")
)

// Options bounds disk reads, individual JSONL records, and emitted pages.
// Zero fields select the defaults. MaxLineBytes may not exceed PageBytes, so a
// successful stream never emits a page larger than PageBytes.
type Options struct {
	ChunkBytes   int
	MaxLineBytes int
	PageBytes    int
	PageEntries  int
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
	Header Header
	LeafID string
	Total  int
}

// Page is one ordered segment of the active branch. Start is the zero-based
// branch index of Entries. Final is true only for the last callback.
type Page struct {
	Entries []json.RawMessage
	Start   int
	Final   bool
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

	f, err := os.Open(sessionPath)
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

type normalizedOptions struct {
	chunkBytes   int
	maxLineBytes int
	pageBytes    int
	pageEntries  int
}

func normalizeOptions(options Options) (normalizedOptions, error) {
	opts := normalizedOptions{
		chunkBytes:   options.ChunkBytes,
		maxLineBytes: options.MaxLineBytes,
		pageBytes:    options.PageBytes,
		pageEntries:  options.PageEntries,
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
	if opts.chunkBytes < 1 || opts.maxLineBytes < 1 || opts.pageBytes < 1 || opts.pageEntries < 1 {
		return normalizedOptions{}, fmt.Errorf("%w: all bounds must be positive", ErrInvalidOptions)
	}
	if opts.maxLineBytes > opts.pageBytes {
		return normalizedOptions{}, fmt.Errorf("%w: MaxLineBytes (%d) exceeds PageBytes (%d)", ErrInvalidOptions, opts.maxLineBytes, opts.pageBytes)
	}
	return opts, nil
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

func index(ctx context.Context, r io.Reader, opts normalizedOptions) (Metadata, []entryRef, error) {
	reader := bufio.NewReaderSize(r, opts.chunkBytes)
	refs := make([]entryRef, 0, 1024)
	byID := make(map[string]int, 1024)
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
	reversed := make([]entryRef, 0, len(refs))
	current := leaf
	for {
		if len(reversed) >= len(refs) {
			return Metadata{}, nil, fmt.Errorf("%w at entry %q", ErrBranchCycle, current.id)
		}
		reversed = append(reversed, current)
		if current.parentID == "" {
			break
		}
		parentIndex, ok := byID[current.parentID]
		if !ok {
			return Metadata{}, nil, fmt.Errorf("%w: entry %q references %q", ErrBrokenBranch, current.id, current.parentID)
		}
		current = refs[parentIndex]
	}

	branch := make([]entryRef, len(reversed))
	for i := range reversed {
		branch[len(reversed)-1-i] = reversed[i]
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
	if len(branch) == 0 {
		return emit(metadata, Page{Entries: []json.RawMessage{}, Final: true})
	}

	page := make([]json.RawMessage, 0, min(opts.pageEntries, len(branch)))
	pageBytes := 0
	pageStart := 0
	flush := func(final bool) error {
		if err := emit(metadata, Page{Entries: page, Start: pageStart, Final: final}); err != nil {
			return fmt.Errorf("page callback: %w", err)
		}
		pageStart += len(page)
		page = make([]json.RawMessage, 0, min(opts.pageEntries, len(branch)-pageStart))
		pageBytes = 0
		return nil
	}

	for i, ref := range branch {
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
		if i == len(branch)-1 {
			return flush(true)
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
