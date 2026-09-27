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

// fileIdentity pairs kernel identity with change signals. On filesystems
// without a change time, a content digest fences same-size rewrites.
type fileIdentity struct {
	device     uint64
	inode      uint64
	size       int64
	modTime    time.Time
	changeTime time.Time
	digest     [32]byte
}

func (f fileIdentity) matches(other fileIdentity) bool {
	return f.device == other.device && f.inode == other.inode &&
		f.size == other.size && f.modTime.Equal(other.modTime) &&
		f.changeTime.Equal(other.changeTime) && f.digest == other.digest
}

func newFileIdentity(info os.FileInfo) fileIdentity {
	device, inode, changeTime := statIdentity(info)
	return fileIdentity{device: device, inode: inode, size: info.Size(), modTime: info.ModTime(), changeTime: changeTime}
}

// cachedIndex is one immutable index result. metadata and branch are shared
// by every caller served from the cache and must never be mutated.
type cachedIndex struct {
	path         string
	identity     fileIdentity
	metadata     Metadata
	branch       []entryRef
	maxLineBytes int
	indexBytes   int64
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
func (c *indexCache) get(path string, identity fileIdentity, opts normalizedOptions) (Metadata, []entryRef, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	elem, ok := c.byPath[path]
	if !ok {
		return Metadata{}, nil, false
	}
	entry := elem.Value.(*cachedIndex)
	if !entry.identity.matches(identity) || entry.maxLineBytes != opts.maxLineBytes || entry.indexBytes != opts.indexBytes {
		c.evict(elem, entry)
		return Metadata{}, nil, false
	}
	c.order.MoveToFront(elem)
	c.hits++
	return entry.metadata, entry.branch, true
}

func (c *indexCache) put(entry cachedIndex) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if elem, ok := c.byPath[entry.path]; ok {
		c.order.MoveToFront(elem)
		elem.Value = &entry
		return
	}
	elem := c.order.PushFront(&entry)
	c.byPath[entry.path] = elem
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
