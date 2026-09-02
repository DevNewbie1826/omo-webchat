// Package adoptcopy adopts an omo engine session as a read-only, verified copy.
//
// Live session-file probing established the JSONL header and entry graph consumed
// by coldhistory. Copy naming, size limits, atomic publication, and verification
// are this package's design decisions.
package adoptcopy

import (
	"context"
	"crypto/rand"
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

// Adopt validates sourcePath, including its durable session ID, then atomically
// publishes and verifies a copy in destinationDir. It never writes to
// sourcePath. Concurrent calls for the same durable session converge on one
// destination. expectedSessionID must match the session header before any copy
// can be published.
func Adopt(ctx context.Context, sourcePath, destinationDir, expectedSessionID string) (Result, error) {
	return adopt(ctx, sourcePath, destinationDir, expectedSessionID, copyHooks{})
}

type copyHooks struct {
	afterChunk    func(int64)
	beforePublish func()
	afterPublish  func()
	sourceLimit   int64
}

func (h copyHooks) limit() int64 {
	if h.sourceLimit > 0 {
		return h.sourceLimit
	}
	return MaxSourceBytes
}

func adopt(ctx context.Context, sourcePath, destinationDir, expectedSessionID string, hooks copyHooks) (result Result, retErr error) {
	if ctx == nil {
		return Result{}, fail(KindInvalidSource, "validate", sourcePath, 0, 0, errors.Join(ErrInvalidSource, errors.New("nil context")))
	}
	if sourcePath == "" || destinationDir == "" || expectedSessionID == "" {
		return Result{}, fail(KindInvalidSource, "validate", sourcePath, 0, 0, errors.Join(ErrInvalidSource, errors.New("source, destination directory, and expected session id are required")))
	}

	limit := hooks.limit()
	metadata, sourceInfo, err := validateSource(ctx, sourcePath, limit)
	if err != nil {
		return Result{}, err
	}
	result.SessionID = metadata.Header.ID
	if result.SessionID != expectedSessionID {
		return Result{}, fail(KindInvalidSource, "validate expected session id", sourcePath, 0, 0, errors.Join(ErrInvalidSource, errors.New("session header id differs from expected durable session id")))
	}
	result.Path = filepath.Join(destinationDir, DestinationName(result.SessionID))

	unlock := adoptionLocks.lock(result.Path)
	defer unlock()

	// Revalidate under the destination lock so a queued adoption cannot act on
	// source metadata observed before another adoption completed.
	lockedMetadata, lockedSourceInfo, err := validateSource(ctx, sourcePath, limit)
	if err != nil {
		return Result{}, err
	}
	if lockedMetadata.Header.ID != result.SessionID || !os.SameFile(sourceInfo, lockedSourceInfo) {
		return Result{}, fail(KindHashMismatch, "revalidate source", sourcePath, 0, 0, ErrHashMismatch)
	}
	sourceInfo = lockedSourceInfo

	sourceHash, hashInfo, err := stableHash(ctx, sourcePath, sourceInfo, "hash source", limit)
	if err != nil {
		return Result{}, err
	}
	result.SHA256 = sourceHash

	destination, err := openDestination(destinationDir)
	if err != nil {
		return Result{}, err
	}
	defer destination.Close()
	destinationName := DestinationName(result.SessionID)

	if _, err := destination.Lstat(destinationName); err == nil {
		return verifyExisting(ctx, destination, destinationName, result, sourceInfo, sourceHash, limit)
	} else if !errors.Is(err, os.ErrNotExist) {
		return Result{}, fail(KindIO, "inspect destination", result.Path, 0, 0, errors.Join(ErrIO, err))
	}

	tmp, tmpName, err := createStage(destination)
	if err != nil {
		return Result{}, fail(KindIO, "create staging file", destinationDir, 0, 0, errors.Join(ErrIO, err))
	}
	published := false
	defer func() {
		cleanupErr := cleanup(destination, tmpName, destinationName, published)
		if cleanupErr != nil {
			if retErr == nil {
				retErr = fail(KindIO, "cleanup", result.Path, 0, 0, errors.Join(ErrIO, cleanupErr))
			} else {
				retErr = errors.Join(retErr, fail(KindIO, "cleanup", result.Path, 0, 0, errors.Join(ErrIO, cleanupErr)))
			}
		}
	}()

	copyHash, copied, copyErr := copyToStage(ctx, sourcePath, tmp, hooks, limit)
	if copyErr != nil {
		_ = tmp.Close()
		return Result{}, copyErr
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return Result{}, fail(KindIO, "fsync staging file", tmpName, 0, 0, errors.Join(ErrIO, err))
	}
	if err := tmp.Close(); err != nil {
		return Result{}, fail(KindIO, "close staging file", tmpName, 0, 0, errors.Join(ErrIO, err))
	}
	if copied != hashInfo.Size() || copyHash != sourceHash {
		return Result{}, fail(KindHashMismatch, "verify staged copy", sourcePath, 0, 0, ErrHashMismatch)
	}
	if err := sourceUnchanged(sourcePath, hashInfo); err != nil {
		return Result{}, err
	}

	if hooks.beforePublish != nil {
		hooks.beforePublish()
	}
	// A hard link is an atomic no-replace publication on both Darwin and Linux.
	// Unlike Rename, it cannot clobber a destination introduced by another
	// process between inspection and publication.
	if err := destination.Link(tmpName, destinationName); err != nil {
		if _, statErr := destination.Lstat(destinationName); statErr == nil {
			return verifyExisting(ctx, destination, destinationName, result, sourceInfo, sourceHash, limit)
		}
		return Result{}, fail(KindIO, "publish copy", result.Path, 0, 0, errors.Join(ErrIO, err))
	}
	published = true
	if err := destination.Remove(tmpName); err != nil {
		return Result{}, fail(KindIO, "remove staging link", tmpName, 0, 0, errors.Join(ErrIO, err))
	}
	tmpName = ""
	if err := syncRoot(destination); err != nil {
		return Result{}, fail(KindIO, "fsync destination directory", destinationDir, 0, 0, errors.Join(ErrIO, err))
	}
	if hooks.afterPublish != nil {
		hooks.afterPublish()
	}

	publishedHash, publishedInfo, err := stableRootHash(ctx, destination, destinationName, nil, "hash published copy", limit)
	if err != nil {
		return Result{}, err
	}
	if os.SameFile(sourceInfo, publishedInfo) {
		return Result{}, fail(KindCollision, "verify published copy", result.Path, 0, 0, ErrCollision)
	}
	finalSourceHash, _, err := stableHash(ctx, sourcePath, hashInfo, "verify source", limit)
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

func validateSource(ctx context.Context, path string, limit int64) (coldhistory.Metadata, os.FileInfo, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return coldhistory.Metadata{}, nil, fail(KindInvalidSource, "stat source", path, 0, 0, errors.Join(ErrInvalidSource, err))
	}
	if !info.Mode().IsRegular() {
		return coldhistory.Metadata{}, nil, fail(KindInvalidSource, "validate source", path, 0, 0, errors.Join(ErrInvalidSource, errors.New("not a regular file")))
	}
	if info.Size() > limit {
		return coldhistory.Metadata{}, nil, fail(KindTooLarge, "validate source", path, info.Size(), limit, ErrTooLarge)
	}

	// coldhistory needs a seekable path for its graph passes. Validate a bounded
	// private snapshot so a source that keeps growing cannot hold either pass
	// open beyond the adoption ceiling.
	snapshot, err := os.CreateTemp("", ".adopt-validate-*.jsonl")
	if err != nil {
		return coldhistory.Metadata{}, nil, fail(KindIO, "create validation snapshot", path, 0, 0, errors.Join(ErrIO, err))
	}
	snapshotPath := snapshot.Name()
	defer os.Remove(snapshotPath)
	source, err := os.Open(path)
	if err != nil {
		snapshot.Close()
		return coldhistory.Metadata{}, nil, fail(KindInvalidSource, "open source", path, 0, 0, errors.Join(ErrInvalidSource, err))
	}
	copied, copyErr := copyContext(ctx, snapshot, io.LimitReader(source, limit+1), copyHooks{})
	current, statErr := source.Stat()
	closeSourceErr := source.Close()
	closeSnapshotErr := snapshot.Close()
	if copyErr != nil {
		return coldhistory.Metadata{}, nil, fail(KindIO, "snapshot source", path, 0, 0, errors.Join(ErrIO, copyErr))
	}
	if copied > limit {
		return coldhistory.Metadata{}, nil, fail(KindTooLarge, "validate source", path, copied, limit, ErrTooLarge)
	}
	if statErr != nil || closeSourceErr != nil || closeSnapshotErr != nil {
		return coldhistory.Metadata{}, nil, fail(KindIO, "snapshot source", path, 0, 0, errors.Join(ErrIO, statErr, closeSourceErr, closeSnapshotErr))
	}
	if !os.SameFile(info, current) || !sameSnapshot(info, current) {
		return coldhistory.Metadata{}, nil, fail(KindHashMismatch, "validate stable source", path, 0, 0, ErrHashMismatch)
	}

	metadata, err := coldhistory.Stream(ctx, snapshotPath, coldhistory.Options{}, func(coldhistory.Metadata, coldhistory.Page) error { return nil })
	if err != nil {
		return coldhistory.Metadata{}, nil, fail(KindInvalidSource, "validate session", path, 0, 0, errors.Join(ErrInvalidSource, err))
	}
	if metadata.Header.ID == "" || metadata.Header.Version <= 0 {
		return coldhistory.Metadata{}, nil, fail(KindInvalidSource, "validate session header", path, 0, 0, errors.Join(ErrInvalidSource, errors.New("session id and positive version are required")))
	}
	return metadata, current, nil
}

func stableHash(ctx context.Context, path string, expected os.FileInfo, op string, limit int64) ([sha256.Size]byte, os.FileInfo, error) {
	file, err := os.Open(path)
	if err != nil {
		return [sha256.Size]byte{}, nil, fail(KindIO, op, path, 0, 0, errors.Join(ErrIO, err))
	}
	defer file.Close()
	return stableFileHash(ctx, file, expected, op, path, limit)
}

func stableRootHash(ctx context.Context, root *os.Root, name string, expected os.FileInfo, op string, limit int64) ([sha256.Size]byte, os.FileInfo, error) {
	file, err := root.Open(name)
	if err != nil {
		return [sha256.Size]byte{}, nil, fail(KindIO, op, name, 0, 0, errors.Join(ErrIO, err))
	}
	defer file.Close()
	return stableFileHash(ctx, file, expected, op, name, limit)
}

func stableFileHash(ctx context.Context, file *os.File, expected os.FileInfo, op, path string, limit int64) ([sha256.Size]byte, os.FileInfo, error) {
	var zero [sha256.Size]byte
	before, err := file.Stat()
	if err != nil {
		return zero, nil, fail(KindIO, op, path, 0, 0, errors.Join(ErrIO, err))
	}
	if !before.Mode().IsRegular() {
		return zero, nil, fail(KindInvalidSource, op, path, 0, 0, errors.Join(ErrInvalidSource, errors.New("not a regular file")))
	}
	if before.Size() > limit {
		return zero, nil, fail(KindTooLarge, op, path, before.Size(), limit, ErrTooLarge)
	}
	if expected != nil && (!os.SameFile(expected, before) || !sameSnapshot(expected, before)) {
		return zero, nil, fail(KindHashMismatch, op, path, 0, 0, ErrHashMismatch)
	}
	hash := sha256.New()
	read, err := copyContext(ctx, hash, io.LimitReader(file, limit+1), copyHooks{})
	if err != nil {
		return zero, nil, fail(KindIO, op, path, 0, 0, errors.Join(ErrIO, err))
	}
	if read > limit {
		return zero, nil, fail(KindTooLarge, op, path, read, limit, ErrTooLarge)
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

func copyToStage(ctx context.Context, sourcePath string, destination io.Writer, hooks copyHooks, limit int64) ([sha256.Size]byte, int64, error) {
	var zero [sha256.Size]byte
	source, err := os.Open(sourcePath)
	if err != nil {
		return zero, 0, fail(KindIO, "open source for copy", sourcePath, 0, 0, errors.Join(ErrIO, err))
	}
	defer source.Close()
	hash := sha256.New()
	written, err := copyContext(ctx, io.MultiWriter(destination, hash), io.LimitReader(source, limit+1), hooks)
	if err != nil {
		return zero, written, fail(KindIO, "copy source", sourcePath, 0, 0, errors.Join(ErrIO, err))
	}
	if written > limit {
		return zero, written, fail(KindTooLarge, "copy source", sourcePath, written, limit, ErrTooLarge)
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

func verifyExisting(ctx context.Context, root *os.Root, name string, result Result, sourceInfo os.FileInfo, sourceHash [sha256.Size]byte, limit int64) (Result, error) {
	existingHash, existingInfo, err := stableRootHash(ctx, root, name, nil, "hash existing copy", limit)
	if err != nil {
		return Result{}, fail(KindCollision, "verify existing copy", result.Path, 0, 0, errors.Join(ErrCollision, err))
	}
	if os.SameFile(sourceInfo, existingInfo) || existingHash != sourceHash {
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

func cleanup(root *os.Root, stagingName, publishedName string, published bool) error {
	var errs []error
	if stagingName != "" {
		if err := root.Remove(stagingName); err != nil && !errors.Is(err, os.ErrNotExist) {
			errs = append(errs, err)
		}
	}
	if published {
		if err := root.Remove(publishedName); err != nil && !errors.Is(err, os.ErrNotExist) {
			errs = append(errs, err)
		}
		if err := syncRoot(root); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

func openDestination(path string) (*os.Root, error) {
	clean := filepath.Clean(path)
	parentPath, name := filepath.Dir(clean), filepath.Base(clean)
	if name == "." || name == string(filepath.Separator) {
		return nil, fail(KindInvalidSource, "validate destination directory", path, 0, 0, errors.Join(ErrInvalidSource, errors.New("destination must be a child directory")))
	}
	parent, err := os.OpenRoot(parentPath)
	if err != nil {
		return nil, fail(KindIO, "open state directory", parentPath, 0, 0, errors.Join(ErrIO, err))
	}
	defer parent.Close()

	info, err := parent.Lstat(name)
	if errors.Is(err, os.ErrNotExist) {
		mkdirErr := parent.Mkdir(name, 0o700)
		if mkdirErr != nil && !errors.Is(mkdirErr, os.ErrExist) {
			return nil, fail(KindIO, "create destination directory", path, 0, 0, errors.Join(ErrIO, mkdirErr))
		}
		if mkdirErr == nil {
			if err := syncRoot(parent); err != nil {
				return nil, fail(KindIO, "fsync state directory", parentPath, 0, 0, errors.Join(ErrIO, err))
			}
		}
		info, err = parent.Lstat(name)
	}
	if err != nil {
		return nil, fail(KindIO, "inspect destination directory", path, 0, 0, errors.Join(ErrIO, err))
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return nil, fail(KindIO, "validate destination directory", path, 0, 0, errors.Join(ErrIO, errors.New("destination is not an owned directory")))
	}

	root, err := parent.OpenRoot(name)
	if err != nil {
		return nil, fail(KindIO, "open destination directory", path, 0, 0, errors.Join(ErrIO, err))
	}
	opened, err := root.Stat(".")
	if err != nil || !os.SameFile(info, opened) {
		root.Close()
		if err == nil {
			err = errors.New("destination changed while opening")
		}
		return nil, fail(KindIO, "pin destination directory", path, 0, 0, errors.Join(ErrIO, err))
	}
	return root, nil
}

func createStage(root *os.Root) (*os.File, string, error) {
	var random [16]byte
	for attempts := 0; attempts < 100; attempts++ {
		if _, err := rand.Read(random[:]); err != nil {
			return nil, "", err
		}
		name := ".adopt-" + hex.EncodeToString(random[:]) + ".tmp"
		file, err := root.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0o600)
		if err == nil {
			return file, name, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, "", err
		}
	}
	return nil, "", errors.New("could not allocate unique staging name")
}

func syncRoot(root *os.Root) error {
	directory, err := root.Open(".")
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
