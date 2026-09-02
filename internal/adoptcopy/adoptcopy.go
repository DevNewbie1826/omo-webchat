// Package adoptcopy adopts an omo engine session as a read-only, verified copy.
//
// Live session-file probing established the JSONL header and entry graph consumed
// by coldhistory. Copy naming, size limits, atomic publication, and verification
// are this package's design decisions.
package adoptcopy

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"

	"github.com/DevNewbie1826/omo-webchat/internal/coldhistory"
)

// MaxSourceBytes is the adoption ceiling. It accommodates known large session
// files while bounding validation, copying, and verification work to 256 MiB.
const MaxSourceBytes int64 = 256 << 20

// Kind identifies an adoption failure category.
type Kind string

const (
	KindInvalidSource Kind = "invalid_source"
	KindTooLarge      Kind = "too_large"
	KindHashMismatch  Kind = "hash_mismatch"
	KindCollision     Kind = "collision"
	KindIO            Kind = "io"
)

var (
	ErrInvalidSource = errors.New("invalid adoption source")
	ErrTooLarge      = errors.New("adoption source exceeds size limit")
	ErrHashMismatch  = errors.New("adoption source changed during copy")
	ErrCollision     = errors.New("adoption destination collision")
	ErrIO            = errors.New("adoption I/O failure")
)

// Error is returned for every adoption failure. Err supports errors.Is with
// ErrInvalidSource, ErrTooLarge, ErrHashMismatch, ErrCollision, and ErrIO.
type Error struct {
	Kind  Kind
	Op    string
	Path  string
	Size  int64
	Limit int64
	Err   error
}

func (e *Error) Error() string {
	if e.Size > e.Limit && e.Limit > 0 {
		return fmt.Sprintf("adoptcopy: %s %q: %v (size %d, limit %d)", e.Op, e.Path, e.Err, e.Size, e.Limit)
	}
	return fmt.Sprintf("adoptcopy: %s %q: %v", e.Op, e.Path, e.Err)
}

func (e *Error) Unwrap() error { return e.Err }

// Result identifies the durable session and its verified copy. Created is
// false when an already-verified identical copy made the adoption a no-op.
type Result struct {
	SessionID string
	Path      string
	SHA256    [sha256.Size]byte
	Created   bool
}

// DestinationName deterministically maps a durable session ID to a safe file
// name without exposing the ID to path parsing or file-name length limits.
func DestinationName(sessionID string) string {
	sum := sha256.Sum256([]byte(sessionID))
	return hex.EncodeToString(sum[:]) + ".jsonl"
}

// Adopt validates sourcePath, then atomically publishes and verifies a copy in
// destinationDir. It never writes to sourcePath. Concurrent calls for the same
// durable session converge on one destination.
func Adopt(ctx context.Context, sourcePath, destinationDir string) (Result, error) {
	return adopt(ctx, sourcePath, destinationDir, copyHooks{})
}

type copyHooks struct {
	afterChunk func(int64)
}

func adopt(ctx context.Context, sourcePath, destinationDir string, hooks copyHooks) (result Result, retErr error) {
	if ctx == nil {
		return Result{}, fail(KindInvalidSource, "validate", sourcePath, 0, 0, errors.Join(ErrInvalidSource, errors.New("nil context")))
	}
	if sourcePath == "" || destinationDir == "" {
		return Result{}, fail(KindInvalidSource, "validate", sourcePath, 0, 0, errors.Join(ErrInvalidSource, errors.New("source and destination directory are required")))
	}

	metadata, sourceInfo, err := validateSource(ctx, sourcePath)
	if err != nil {
		return Result{}, err
	}
	result.SessionID = metadata.Header.ID
	result.Path = filepath.Join(destinationDir, DestinationName(result.SessionID))

	unlock := adoptionLocks.lock(result.Path)
	defer unlock()

	// Revalidate under the destination lock so a queued adoption cannot act on
	// source metadata observed before another adoption completed.
	lockedMetadata, lockedSourceInfo, err := validateSource(ctx, sourcePath)
	if err != nil {
		return Result{}, err
	}
	if lockedMetadata.Header.ID != result.SessionID || !os.SameFile(sourceInfo, lockedSourceInfo) {
		return Result{}, fail(KindHashMismatch, "revalidate source", sourcePath, 0, 0, ErrHashMismatch)
	}
	sourceInfo = lockedSourceInfo

	sourceHash, hashInfo, err := stableHash(ctx, sourcePath, sourceInfo, "hash source")
	if err != nil {
		return Result{}, err
	}
	result.SHA256 = sourceHash

	if _, err := os.Lstat(result.Path); err == nil {
		return verifyExisting(ctx, result, sourceHash)
	} else if !errors.Is(err, os.ErrNotExist) {
		return Result{}, fail(KindIO, "inspect destination", result.Path, 0, 0, errors.Join(ErrIO, err))
	}

	if err := os.MkdirAll(destinationDir, 0o700); err != nil {
		return Result{}, fail(KindIO, "create destination directory", destinationDir, 0, 0, errors.Join(ErrIO, err))
	}
	tmp, err := os.CreateTemp(destinationDir, ".adopt-*.tmp")
	if err != nil {
		return Result{}, fail(KindIO, "create staging file", destinationDir, 0, 0, errors.Join(ErrIO, err))
	}
	tmpPath := tmp.Name()
	published := false
	defer func() {
		cleanupErr := cleanup(tmpPath, result.Path, published)
		if cleanupErr != nil {
			if retErr == nil {
				retErr = fail(KindIO, "cleanup", result.Path, 0, 0, errors.Join(ErrIO, cleanupErr))
			} else {
				retErr = errors.Join(retErr, fail(KindIO, "cleanup", result.Path, 0, 0, errors.Join(ErrIO, cleanupErr)))
			}
		}
	}()

	copyHash, copied, copyErr := copyToStage(ctx, sourcePath, tmp, hooks)
	if copyErr != nil {
		_ = tmp.Close()
		return Result{}, copyErr
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return Result{}, fail(KindIO, "fsync staging file", tmpPath, 0, 0, errors.Join(ErrIO, err))
	}
	if err := tmp.Close(); err != nil {
		return Result{}, fail(KindIO, "close staging file", tmpPath, 0, 0, errors.Join(ErrIO, err))
	}
	if copied != hashInfo.Size() || copyHash != sourceHash {
		return Result{}, fail(KindHashMismatch, "verify staged copy", sourcePath, 0, 0, ErrHashMismatch)
	}
	if err := sourceUnchanged(sourcePath, hashInfo); err != nil {
		return Result{}, err
	}

	// Same-process adopters are serialized above. This check also refuses to
	// replace a destination introduced before publication.
	if _, err := os.Lstat(result.Path); err == nil {
		return verifyExisting(ctx, result, sourceHash)
	} else if !errors.Is(err, os.ErrNotExist) {
		return Result{}, fail(KindIO, "inspect destination", result.Path, 0, 0, errors.Join(ErrIO, err))
	}
	if err := os.Rename(tmpPath, result.Path); err != nil {
		return Result{}, fail(KindIO, "publish copy", result.Path, 0, 0, errors.Join(ErrIO, err))
	}
	tmpPath = ""
	published = true
	if err := syncDirectory(destinationDir); err != nil {
		return Result{}, fail(KindIO, "fsync destination directory", destinationDir, 0, 0, errors.Join(ErrIO, err))
	}

	publishedHash, _, err := stableHash(ctx, result.Path, nil, "hash published copy")
	if err != nil {
		return Result{}, err
	}
	finalSourceHash, _, err := stableHash(ctx, sourcePath, hashInfo, "verify source")
	if err != nil {
		return Result{}, err
	}
	if publishedHash != finalSourceHash || finalSourceHash != sourceHash {
		return Result{}, fail(KindHashMismatch, "verify published copy", sourcePath, 0, 0, ErrHashMismatch)
	}

	published = false
	result.Created = true
	return result, nil
}

func validateSource(ctx context.Context, path string) (coldhistory.Metadata, os.FileInfo, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return coldhistory.Metadata{}, nil, fail(KindInvalidSource, "stat source", path, 0, 0, errors.Join(ErrInvalidSource, err))
	}
	if !info.Mode().IsRegular() {
		return coldhistory.Metadata{}, nil, fail(KindInvalidSource, "validate source", path, 0, 0, errors.Join(ErrInvalidSource, errors.New("not a regular file")))
	}
	if info.Size() > MaxSourceBytes {
		return coldhistory.Metadata{}, nil, fail(KindTooLarge, "validate source", path, info.Size(), MaxSourceBytes, ErrTooLarge)
	}
	metadata, err := coldhistory.Stream(ctx, path, coldhistory.Options{}, func(coldhistory.Metadata, coldhistory.Page) error { return nil })
	if err != nil {
		return coldhistory.Metadata{}, nil, fail(KindInvalidSource, "validate session", path, 0, 0, errors.Join(ErrInvalidSource, err))
	}
	if metadata.Header.ID == "" || metadata.Header.Version <= 0 {
		return coldhistory.Metadata{}, nil, fail(KindInvalidSource, "validate session header", path, 0, 0, errors.Join(ErrInvalidSource, errors.New("session id and positive version are required")))
	}
	current, err := os.Lstat(path)
	if err != nil || !os.SameFile(info, current) || !sameSnapshot(info, current) {
		if err == nil {
			err = ErrHashMismatch
		}
		return coldhistory.Metadata{}, nil, fail(KindHashMismatch, "validate stable source", path, 0, 0, errors.Join(ErrHashMismatch, err))
	}
	return metadata, current, nil
}

func stableHash(ctx context.Context, path string, expected os.FileInfo, op string) ([sha256.Size]byte, os.FileInfo, error) {
	var zero [sha256.Size]byte
	file, err := os.Open(path)
	if err != nil {
		return zero, nil, fail(KindIO, op, path, 0, 0, errors.Join(ErrIO, err))
	}
	defer file.Close()
	before, err := file.Stat()
	if err != nil {
		return zero, nil, fail(KindIO, op, path, 0, 0, errors.Join(ErrIO, err))
	}
	if !before.Mode().IsRegular() {
		return zero, nil, fail(KindInvalidSource, op, path, 0, 0, errors.Join(ErrInvalidSource, errors.New("not a regular file")))
	}
	if expected != nil && (!os.SameFile(expected, before) || !sameSnapshot(expected, before)) {
		return zero, nil, fail(KindHashMismatch, op, path, 0, 0, ErrHashMismatch)
	}
	hash := sha256.New()
	if _, err := copyContext(ctx, hash, file, copyHooks{}); err != nil {
		return zero, nil, fail(KindIO, op, path, 0, 0, errors.Join(ErrIO, err))
	}
	after, err := file.Stat()
	if err != nil {
		return zero, nil, fail(KindIO, op, path, 0, 0, errors.Join(ErrIO, err))
	}
	if !sameSnapshot(before, after) {
		return zero, nil, fail(KindHashMismatch, op, path, 0, 0, ErrHashMismatch)
	}
	var sum [sha256.Size]byte
	copy(sum[:], hash.Sum(nil))
	return sum, after, nil
}

func copyToStage(ctx context.Context, sourcePath string, destination io.Writer, hooks copyHooks) ([sha256.Size]byte, int64, error) {
	var zero [sha256.Size]byte
	source, err := os.Open(sourcePath)
	if err != nil {
		return zero, 0, fail(KindIO, "open source for copy", sourcePath, 0, 0, errors.Join(ErrIO, err))
	}
	defer source.Close()
	hash := sha256.New()
	written, err := copyContext(ctx, io.MultiWriter(destination, hash), io.LimitReader(source, MaxSourceBytes+1), hooks)
	if err != nil {
		return zero, written, fail(KindIO, "copy source", sourcePath, 0, 0, errors.Join(ErrIO, err))
	}
	if written > MaxSourceBytes {
		return zero, written, fail(KindTooLarge, "copy source", sourcePath, written, MaxSourceBytes, ErrTooLarge)
	}
	var sum [sha256.Size]byte
	copy(sum[:], hash.Sum(nil))
	return sum, written, nil
}

func copyContext(ctx context.Context, destination io.Writer, source io.Reader, hooks copyHooks) (int64, error) {
	buffer := make([]byte, 64<<10)
	var written int64
	for {
		if err := ctx.Err(); err != nil {
			return written, err
		}
		n, readErr := source.Read(buffer)
		if n > 0 {
			wn, writeErr := destination.Write(buffer[:n])
			written += int64(wn)
			if writeErr != nil {
				return written, writeErr
			}
			if wn != n {
				return written, io.ErrShortWrite
			}
			if hooks.afterChunk != nil {
				hooks.afterChunk(written)
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				return written, nil
			}
			return written, readErr
		}
	}
}

func verifyExisting(ctx context.Context, result Result, sourceHash [sha256.Size]byte) (Result, error) {
	metadata, _, err := validateSource(ctx, result.Path)
	if err != nil || metadata.Header.ID != result.SessionID {
		if err == nil {
			err = errors.New("durable session id differs")
		}
		return Result{}, fail(KindCollision, "verify existing copy", result.Path, 0, 0, errors.Join(ErrCollision, err))
	}
	existingHash, _, err := stableHash(ctx, result.Path, nil, "hash existing copy")
	if err != nil {
		return Result{}, fail(KindCollision, "verify existing copy", result.Path, 0, 0, errors.Join(ErrCollision, err))
	}
	if existingHash != sourceHash {
		return Result{}, fail(KindCollision, "verify existing copy", result.Path, 0, 0, ErrCollision)
	}
	result.SHA256 = existingHash
	result.Created = false
	return result, nil
}

func sourceUnchanged(path string, expected os.FileInfo) error {
	current, err := os.Lstat(path)
	if err != nil || !os.SameFile(expected, current) || !sameSnapshot(expected, current) {
		if err == nil {
			err = ErrHashMismatch
		}
		return fail(KindHashMismatch, "verify source metadata", path, 0, 0, errors.Join(ErrHashMismatch, err))
	}
	return nil
}

func sameSnapshot(left, right os.FileInfo) bool {
	return left.Size() == right.Size() && left.Mode() == right.Mode() && left.ModTime().Equal(right.ModTime())
}

func cleanup(stagingPath, publishedPath string, published bool) error {
	var errs []error
	if stagingPath != "" {
		if err := os.Remove(stagingPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			errs = append(errs, err)
		}
	}
	if published {
		if err := os.Remove(publishedPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			errs = append(errs, err)
		}
		if err := syncDirectory(filepath.Dir(publishedPath)); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

func fail(kind Kind, op, path string, size, limit int64, err error) *Error {
	return &Error{Kind: kind, Op: op, Path: path, Size: size, Limit: limit, Err: err}
}

type lockTable struct {
	mu    sync.Mutex
	locks map[string]*lockEntry
}

type lockEntry struct {
	mu   sync.Mutex
	refs int
}

func (t *lockTable) lock(path string) func() {
	t.mu.Lock()
	if t.locks == nil {
		t.locks = make(map[string]*lockEntry)
	}
	entry := t.locks[path]
	if entry == nil {
		entry = &lockEntry{}
		t.locks[path] = entry
	}
	entry.refs++
	t.mu.Unlock()
	entry.mu.Lock()
	return func() {
		entry.mu.Unlock()
		t.mu.Lock()
		entry.refs--
		if entry.refs == 0 {
			delete(t.locks, path)
		}
		t.mu.Unlock()
	}
}

var adoptionLocks lockTable
