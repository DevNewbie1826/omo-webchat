package coldhistory

import (
	"container/list"
	"os"
	"sync"
	"time"
)

// DefaultIndexCacheFiles bounds how many session files keep their index in the
// process-wide cache.
const DefaultIndexCacheFiles = 8

// fileIdentity pairs immutable kernel identity with the change signals an
// append or rewrite always updates. A mismatch invalidates the cached index.
type fileIdentity struct {
	device  uint64
	inode   uint64
	size    int64
	modTime time.Time
}

func (f fileIdentity) matches(other fileIdentity) bool {
	return f.device == other.device && f.inode == other.inode &&
		f.size == other.size && f.modTime.Equal(other.modTime)
}

func newFileIdentity(info os.FileInfo) fileIdentity {
	device, inode := statIdentity(info)
	return fileIdentity{device: device, inode: inode, size: info.Size(), modTime: info.ModTime()}
}

// cachedIndex is one immutable index result. metadata and branch are shared
// by every caller served from the cache and must never be mutated.
type cachedIndex struct {
	path     string
	identity fileIdentity
	metadata Metadata
	branch   []entryRef
}

// indexCache keeps the most recently used index results keyed by path and
// fenced by file identity. Capacity is counted in files.
type indexCache struct {
	mu       sync.Mutex
	capacity int
	order    *list.List
	byPath   map[string]*list.Element
	hits     int
}

// sessionIndexCache is the process-wide index cache shared by the file-based
// readers.
var sessionIndexCache = newIndexCache(DefaultIndexCacheFiles)

func newIndexCache(capacity int) *indexCache {
	return &indexCache{
		capacity: capacity,
		order:    list.New(),
		byPath:   make(map[string]*list.Element),
	}
}

// get reports a hit only while the cached entry still matches the file's
// current identity; a stale entry is dropped instead of served.
func (c *indexCache) get(path string, identity fileIdentity) (Metadata, []entryRef, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	elem, ok := c.byPath[path]
	if !ok {
		return Metadata{}, nil, false
	}
	entry := elem.Value.(*cachedIndex)
	if !entry.identity.matches(identity) {
		c.evict(elem, entry)
		return Metadata{}, nil, false
	}
	c.order.MoveToFront(elem)
	c.hits++
	return entry.metadata, entry.branch, true
}

func (c *indexCache) put(path string, identity fileIdentity, metadata Metadata, branch []entryRef) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if elem, ok := c.byPath[path]; ok {
		c.order.MoveToFront(elem)
		elem.Value = &cachedIndex{path: path, identity: identity, metadata: metadata, branch: branch}
		return
	}
	elem := c.order.PushFront(&cachedIndex{path: path, identity: identity, metadata: metadata, branch: branch})
	c.byPath[path] = elem
	for c.order.Len() > c.capacity {
		oldest := c.order.Back()
		c.evict(oldest, oldest.Value.(*cachedIndex))
	}
}

func (c *indexCache) evict(elem *list.Element, entry *cachedIndex) {
	c.order.Remove(elem)
	delete(c.byPath, entry.path)
}

// hitCount exposes the hit tally to in-package tests: a re-index pass is not
// observable any other way.
func (c *indexCache) hitCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.hits
}
