package session

import "container/list"

// residencyLRU keeps resident evidence outside the bounded distinct-key history.
// Its caller owns synchronization and must unpin when residency ends.
type residencyLRU[V any] struct {
	capacity int
	values   map[string]V
	pinned   map[string]struct{}
	index    map[string]*list.Element
	recent   list.List
}

func newResidencyLRU[V any](capacity int) residencyLRU[V] {
	return residencyLRU[V]{capacity: capacity, values: make(map[string]V)}
}

func (l *residencyLRU[V]) Get(key string) (V, bool) {
	value, ok := l.values[key]
	return value, ok
}

func (l *residencyLRU[V]) Put(key string, value V) {
	if l.values == nil {
		l.values = make(map[string]V)
	}
	l.values[key] = value
	if _, pinned := l.pinned[key]; pinned {
		return
	}
	if l.index == nil {
		l.index = make(map[string]*list.Element)
	}
	if element := l.index[key]; element == nil {
		l.index[key] = l.recent.PushBack(key)
	} else {
		l.recent.MoveToBack(element)
	}
	l.evict()
}

// Pin may precede Put so a newly resident identity never enters the budget.
func (l *residencyLRU[V]) Pin(key string) {
	if l.pinned == nil {
		l.pinned = make(map[string]struct{})
	}
	l.pinned[key] = struct{}{}
	if element := l.index[key]; element != nil {
		l.recent.Remove(element)
		delete(l.index, key)
	}
}

func (l *residencyLRU[V]) Unpin(key string) {
	if _, pinned := l.pinned[key]; !pinned {
		return
	}
	delete(l.pinned, key)
	if _, present := l.values[key]; !present {
		return
	}
	if l.index == nil {
		l.index = make(map[string]*list.Element)
	}
	l.index[key] = l.recent.PushBack(key)
	l.evict()
}

func (l *residencyLRU[V]) Delete(key string) {
	if element := l.index[key]; element != nil {
		l.recent.Remove(element)
		delete(l.index, key)
	}
	delete(l.pinned, key)
	delete(l.values, key)
}

func (l *residencyLRU[V]) Range(visit func(string, V)) {
	for key, value := range l.values {
		visit(key, value)
	}
}

func (l *residencyLRU[V]) Len() int {
	return len(l.values)
}

func (l *residencyLRU[V]) HistoryLen() int {
	return l.recent.Len()
}

func (l *residencyLRU[V]) evict() {
	for l.recent.Len() > l.capacity {
		oldest := l.recent.Front()
		key := oldest.Value.(string)
		delete(l.values, key)
		delete(l.index, key)
		l.recent.Remove(oldest)
	}
}
