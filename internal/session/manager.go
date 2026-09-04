package session

// Lock order: Session.lifecycleMu -> Manager.mu -> broadcaster.mu.
// No mutex in that order is held across RPC or cursor-store I/O. Per-chat
// work is serialized by an independent single-flight permit.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

type keyedFlight struct {
	mu      sync.Mutex
	flights map[string]*chatFlight
}
type chatFlight struct {
	owned   bool
	waiters []*chatWaiter
}

type chatWaiter struct {
	ready   chan struct{}
	granted bool
}

// enter serializes operations for one chat in explicit FIFO order. Waiting is
// cancellable, and enqueue can reserve recovery's position before the current
// owner hands the chat to another transport operation.
func (k *keyedFlight) enter(ctx context.Context, key string) (func(), error) {
	waiter := &chatWaiter{ready: make(chan struct{})}
	k.mu.Lock()
	if k.flights == nil {
		k.flights = make(map[string]*chatFlight)
	}
	x := k.flights[key]
	if x == nil {
		x = &chatFlight{}
		k.flights[key] = x
	}
	if !x.owned && len(x.waiters) == 0 {
		x.owned = true
		waiter.granted = true
		close(waiter.ready)
	} else {
		x.waiters = append(x.waiters, waiter)
	}
	k.mu.Unlock()

	select {
	case <-waiter.ready:
		var once sync.Once
		return func() { once.Do(func() { k.release(key, x) }) }, nil
	case <-ctx.Done():
		k.mu.Lock()
		if waiter.granted {
			k.mu.Unlock()
			k.release(key, x)
		} else {
			for i, queued := range x.waiters {
				if queued == waiter {
					x.waiters = append(x.waiters[:i], x.waiters[i+1:]...)
					break
				}
			}
			if !x.owned && len(x.waiters) == 0 {
				delete(k.flights, key)
			}
			k.mu.Unlock()
		}
		return nil, ctx.Err()
	}
}

func (k *keyedFlight) release(key string, x *chatFlight) {
	k.mu.Lock()
	if len(x.waiters) == 0 {
		x.owned = false
		delete(k.flights, key)
		k.mu.Unlock()
		return
	}
	next := x.waiters[0]
	x.waiters = x.waiters[1:]
	next.granted = true
	close(next.ready)
	k.mu.Unlock()
}

func (k *keyedFlight) enqueue(key string, run func()) {
	waiter := &chatWaiter{ready: make(chan struct{})}
	k.mu.Lock()
	if k.flights == nil {
		k.flights = make(map[string]*chatFlight)
	}
	x := k.flights[key]
	if x == nil {
		x = &chatFlight{}
		k.flights[key] = x
	}
	if !x.owned && len(x.waiters) == 0 {
		x.owned = true
		waiter.granted = true
		close(waiter.ready)
	} else {
		x.waiters = append(x.waiters, waiter)
	}
	k.mu.Unlock()
	go func() {
		<-waiter.ready
		defer k.release(key, x)
		run()
	}()
}

const (
	maxSlotGenerations    = 1024
	maxRetiringRoutes     = 1024
	maxIdentityTombstones = 256
	cleanupDrainTimeout   = 5 * time.Second
)

type generationRecord struct {
	chatID     string
	generation uint64
}

type retiringRecord struct {
	chatID string
	route  retiringRoute
}

type retiringRoute struct {
	route string
	epoch omorpc.EpochToken
}

type durableEpochBinding struct {
	session *Session
	chatID  string
}

type durableTombstoneRecord struct {
	epoch   omorpc.EpochToken
	durable string
	binding *durableEpochBinding
}

type retiredDurableRecord struct {
	durable    string
	generation uint64
}

type Manager struct {
	cfg Config

	chats                keyedFlight
	mu                   sync.Mutex
	byChat               map[string]*Session
	byRoute              map[string]*Session
	routeCleanup         map[string]chan struct{}
	operationOwners      map[string]*sendOperationOwner
	byDurableEpoch       map[omorpc.EpochToken]map[string]*durableEpochBinding
	durableTombstones    []durableTombstoneRecord
	durableToChat        map[string]string
	retiredDurable       map[string]uint64
	retiredDurableFIFO   []retiredDurableRecord
	identityGeneration   uint64
	invalidatedEpochs    map[omorpc.EpochToken]struct{}
	epochIngestions      map[omorpc.EpochToken]int
	retiringByChat       map[string]map[retiringRoute]struct{}
	retiringFIFO         []retiringRecord
	slotGeneration       map[string]uint64
	slotGenerationFIFO   []generationRecord
	generation           uint64
	closed               bool
	done                 chan struct{}
	shutdownCtx          context.Context
	shutdownCancel       context.CancelFunc
	closeOnce            sync.Once
	acquireWG            sync.WaitGroup
	cleanupWG            sync.WaitGroup
	eventWG              sync.WaitGroup
	openCleanupExpired   chan struct{}
	pendingOpen          map[string]chan struct{}
	openSlots            chan struct{}
	overviewCache        map[string]*overviewCacheEntry
	overviewCurrent      map[string]Summary
	overviewClock        uint64
	overviewSubscribers  map[uint64]*overviewSubscriber
	overviewSubscriberID uint64
}

func NewManager(cfg Config) *Manager {
	if cfg.IdleAfter == 0 {
		cfg.IdleAfter = DefaultIdleAfter
	}
	if cfg.QueueSize == 0 {
		cfg.QueueSize = DefaultQueueSize
	}
	if cfg.RetryAttempts == 0 {
		cfg.RetryAttempts = DefaultRetryAttempt
	}
	if cfg.RetryBackoff == 0 {
		cfg.RetryBackoff = DefaultRetryBackoff
	}
	if cfg.CloseTimeout == 0 {
		cfg.CloseTimeout = DefaultCloseTimeout
	}
	if cfg.DetachedOpenLimit == 0 {
		cfg.DetachedOpenLimit = DefaultDetachedOpenLimit
	}
	shutdownCtx, shutdownCancel := context.WithCancel(context.Background())
	m := &Manager{cfg: cfg, byChat: make(map[string]*Session), byRoute: make(map[string]*Session), routeCleanup: make(map[string]chan struct{}), operationOwners: make(map[string]*sendOperationOwner), byDurableEpoch: make(map[omorpc.EpochToken]map[string]*durableEpochBinding), durableToChat: make(map[string]string), retiredDurable: make(map[string]uint64), invalidatedEpochs: make(map[omorpc.EpochToken]struct{}), epochIngestions: make(map[omorpc.EpochToken]int), retiringByChat: make(map[string]map[retiringRoute]struct{}), slotGeneration: make(map[string]uint64), done: make(chan struct{}), shutdownCtx: shutdownCtx, shutdownCancel: shutdownCancel, openCleanupExpired: make(chan struct{}, 64), pendingOpen: make(map[string]chan struct{}), openSlots: make(chan struct{}, cfg.DetachedOpenLimit), overviewCache: make(map[string]*overviewCacheEntry), overviewCurrent: make(map[string]Summary), overviewSubscribers: make(map[uint64]*overviewSubscriber)}
	if cfg.Client != nil {
		m.eventWG.Add(1)
		go m.eventLoop()
	}
	return m
}

func (m *Manager) eventLoop() {
	defer m.eventWG.Done()
	backoff := time.Millisecond
	for {
		token, ch := m.cfg.Client.CurrentEpoch()
		m.observeEpoch(token)
		select {
		case <-m.done:
			return
		case ev, ok := <-ch:
			if !ok {
				m.invalidateEpoch(token)
				// omorpc currently has no epoch-change notification. Exponential
				// closed-channel backoff avoids polling hot while still discovering
				// an epoch established by the next RPC within 250ms.
				timer := time.NewTimer(backoff)
				select {
				case <-m.done:
					timer.Stop()
					return
				case <-timer.C:
				}
				backoff *= 2
				if backoff > 250*time.Millisecond {
					backoff = 250 * time.Millisecond
				}
				continue
			}
			backoff = time.Millisecond
			if ev == nil || ev.SessionID == "" || !m.cfg.Client.EpochCurrent(token) || !m.beginEpochIngestion(token) {
				continue
			}
			s, snapshot, subscribers := m.ingestEpochEvent(token, ev)
			if s != nil {
				s.dispatchEpoch(token, ev)
			} else {
				deliverOverview(subscribers, snapshot)
			}
			m.endEpochIngestion(token)
		}
	}
}

// invalidateEpoch only retires sessions opened on the token that died. A
// delayed failure from an older request therefore cannot invalidate sessions
// registered after reconnect.
func (m *Manager) invalidateEpoch(token omorpc.EpochToken) {
	all := m.detachEpoch(token)
	for _, s := range all {
		s.invalidate("provider_disconnected", "provider connection lost")
	}
}

// detachEpoch establishes the ingestion/publication barrier before session
// lifecycle invalidation. It deliberately does not take lifecycleMu, preserving
// the lifecycleMu -> Manager.mu lock order used by bound publication.
func (m *Manager) detachEpoch(token omorpc.EpochToken) []*Session {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.invalidatedEpochs[token] = struct{}{}
	all := make([]*Session, 0, len(m.byChat))
	for _, s := range m.byChat {
		if s.epoch == token {
			all = append(all, s)
			delete(m.byRoute, s.routingID)
		}
	}
	delete(m.byDurableEpoch, token)
	m.pruneDurableTombstonesLocked(token)
	for id, entry := range m.overviewCache {
		if entry.epoch == token {
			delete(m.overviewCache, id)
			delete(m.overviewCurrent, entry.chatID)
		}
	}
	for _, s := range all {
		delete(m.overviewCurrent, s.chatID)
	}
	return all
}

func (m *Manager) observeEpoch(token omorpc.EpochToken) {
	if token == (omorpc.EpochToken{}) {
		return
	}
	m.mu.Lock()
	for invalidated := range m.invalidatedEpochs {
		if invalidated != token && m.epochIngestions[invalidated] == 0 {
			delete(m.invalidatedEpochs, invalidated)
		}
	}
	m.mu.Unlock()
}

func (m *Manager) beginEpochIngestion(token omorpc.EpochToken) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, invalidated := m.invalidatedEpochs[token]; invalidated {
		return false
	}
	m.epochIngestions[token]++
	return true
}

func (m *Manager) endEpochIngestion(token omorpc.EpochToken) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.epochIngestions[token] <= 1 {
		delete(m.epochIngestions, token)
		delete(m.invalidatedEpochs, token)
		return
	}
	m.epochIngestions[token]--
}

// bindIdentityLocked publishes one live durable identity and retires any old
// durable identity previously associated with the same chat. It deliberately
// cannot revive a permanently retired durable; only a validated session
// activation may do that. Manager.mu is held.
func (m *Manager) bindIdentityLocked(s *Session) {
	if _, retired := m.retiredDurable[s.durableID]; retired {
		return
	}
	for durable, chatID := range m.durableToChat {
		if chatID == s.chatID && durable != s.durableID {
			m.retireDurableLocked(durable, chatID)
		}
	}
	m.durableToChat[s.durableID] = s.chatID
	byDurable := m.byDurableEpoch[s.epoch]
	if byDurable == nil {
		byDurable = make(map[string]*durableEpochBinding)
		m.byDurableEpoch[s.epoch] = byDurable
	}
	byDurable[s.durableID] = &durableEpochBinding{session: s, chatID: s.chatID}
}

// activateIdentityLocked revives an identity only for a session whose acquire
// has passed the chat-generation and epoch checks and published its live route.
// Epoch invalidation removes that route before touching Session lifecycle state,
// so a stale invalidation-side publication cannot clear permanent retirement.
func (m *Manager) activateIdentityLocked(s *Session) {
	if m.byChat[s.chatID] == s && m.byRoute[s.routingID] == s {
		if _, invalidated := m.invalidatedEpochs[s.epoch]; !invalidated {
			delete(m.retiredDurable, s.durableID)
		}
	}
	m.bindIdentityLocked(s)
}

// tombstoneSessionIdentityLocked drops the full Session reference while
// retaining a bounded same-epoch barrier against late child events.
func (m *Manager) tombstoneSessionIdentityLocked(s *Session) {
	byDurable := m.byDurableEpoch[s.epoch]
	if byDurable == nil {
		return
	}
	binding := byDurable[s.durableID]
	if binding == nil || binding.session != s {
		return
	}
	tombstone := &durableEpochBinding{chatID: s.chatID}
	byDurable[s.durableID] = tombstone
	m.durableTombstones = append(m.durableTombstones, durableTombstoneRecord{epoch: s.epoch, durable: s.durableID, binding: tombstone})
	for len(m.durableTombstones) > maxIdentityTombstones {
		old := m.durableTombstones[0]
		m.durableTombstones = m.durableTombstones[1:]
		if entries := m.byDurableEpoch[old.epoch]; entries != nil && entries[old.durable] == old.binding {
			delete(entries, old.durable)
			if len(entries) == 0 {
				delete(m.byDurableEpoch, old.epoch)
			}
		}
	}
}

func (m *Manager) pruneDurableTombstonesLocked(epoch omorpc.EpochToken) {
	kept := m.durableTombstones[:0]
	for _, record := range m.durableTombstones {
		if record.epoch != epoch {
			kept = append(kept, record)
		}
	}
	m.durableTombstones = kept
}

func (m *Manager) retireDurableLocked(durable, chatID string) {
	delete(m.durableToChat, durable)
	if entry := m.overviewCache[durable]; entry != nil {
		delete(m.overviewCurrent, entry.chatID)
		delete(m.overviewCache, durable)
	}
	for epoch, entries := range m.byDurableEpoch {
		if binding := entries[durable]; binding != nil && binding.chatID == chatID {
			delete(entries, durable)
			if len(entries) == 0 {
				delete(m.byDurableEpoch, epoch)
			}
		}
	}
	m.identityGeneration++
	generation := m.identityGeneration
	m.retiredDurable[durable] = generation
	m.retiredDurableFIFO = append(m.retiredDurableFIFO, retiredDurableRecord{durable: durable, generation: generation})
	for len(m.retiredDurableFIFO) > maxIdentityTombstones {
		old := m.retiredDurableFIFO[0]
		m.retiredDurableFIFO = m.retiredDurableFIFO[1:]
		if m.retiredDurable[old.durable] == old.generation {
			delete(m.retiredDurable, old.durable)
		}
	}
}

func (m *Manager) retireChatIdentityLocked(chatID string) {
	delete(m.overviewCurrent, chatID)
	for durable, mappedChat := range m.durableToChat {
		if mappedChat == chatID {
			m.retireDurableLocked(durable, chatID)
		}
	}
}

func (m *Manager) retireSessionIdentityLocked(s *Session, bumpGeneration bool) {
	if m.byChat[s.chatID] == s {
		delete(m.byChat, s.chatID)
		delete(m.overviewCurrent, s.chatID)
		if bumpGeneration {
			m.bumpSlotGenerationLocked(s.chatID)
		}
	}
	if m.byRoute[s.routingID] == s {
		delete(m.byRoute, s.routingID)
	}
	m.tombstoneSessionIdentityLocked(s)
}

// RetireIdentity permanently forgets aliases for deleted chat metadata.
func (m *Manager) RetireIdentity(chatID string) {
	m.mu.Lock()
	m.retireChatIdentityLocked(chatID)
	delete(m.operationOwners, chatID)
	m.mu.Unlock()
}

// ReplayBackpressureSubscriber lets a transport apply replay-specific write
// deadlines. EndReplay is called only after the terminal frame is delivered,
// or when the subscription stops.
type ReplayBackpressureSubscriber interface {
	BeginReplay()
	EndReplay()
}

func hydrateForSubscriber(ctx context.Context, s *Session, path string, target *subscription) {
	if target == nil {
		return
	}
	target.beginReplay()
	s.hydrateEntries(ctx, path, target)
}

func (m *Manager) Acquire(ctx context.Context, chat ChatRef, sub Subscriber) (*Session, bool, func(), error) {
	return m.acquire(ctx, chat, sub, nil, nil, nil, nil, false, false, false)
}

// AcquireInitialized keeps the per-chat flight through initialize, allowing a
// transport to publish its binding and complete initial state/history queries
// without cross-socket controls interleaving.
func (m *Manager) AcquireInitialized(ctx context.Context, chat ChatRef, sub Subscriber, initialize func(*Session, bool, func())) (*Session, bool, func(), error) {
	return m.acquire(ctx, chat, sub, initialize, nil, nil, nil, false, false, false)
}

// AcquireInitializedWithRecovery is AcquireInitialized with explicit authority
// to replace a quarantined in-place provider route.
func (m *Manager) AcquireInitializedWithRecovery(ctx context.Context, chat ChatRef, sub Subscriber, initialize func(*Session, bool, func())) (*Session, bool, func(), error) {
	return m.acquire(ctx, chat, sub, initialize, nil, nil, nil, true, false, false)
}

// AcquireInitializedChecked validates its caller's metadata generation before
// provider work and again after initialize, immediately before publication.
// validate must not acquire a lock that nests outside the manager's per-chat
// flight.
func (m *Manager) AcquireInitializedChecked(ctx context.Context, chat ChatRef, sub Subscriber, initialize func(*Session, bool, func()), validate func() error) (*Session, bool, func(), error) {
	return m.acquire(ctx, chat, sub, initialize, validate, nil, nil, false, false, false)
}

// AcquireInitializedCheckedWithRecovery combines checked publication with
// explicit authority to replace a quarantined in-place provider route.
func (m *Manager) AcquireInitializedCheckedWithRecovery(ctx context.Context, chat ChatRef, sub Subscriber, initialize func(*Session, bool, func()), validate func() error) (*Session, bool, func(), error) {
	return m.acquire(ctx, chat, sub, initialize, validate, nil, nil, true, false, false)
}

// AcquireInitializedCheckedAndRun invokes run only after checked manager
// publication, while retaining the per-chat owner through the callback.
func (m *Manager) AcquireInitializedCheckedAndRun(ctx context.Context, chat ChatRef, sub Subscriber, initialize func(*Session, bool, func()), validate func() error, run func(*Session) error) (*Session, bool, func(), error) {
	return m.acquire(ctx, chat, sub, initialize, validate, run, nil, false, false, false)
}

// AcquireInitializedCheckedWithRecoveryAndRun is the explicit-recovery form of
// AcquireInitializedCheckedAndRun.
func (m *Manager) AcquireInitializedCheckedWithRecoveryAndRun(ctx context.Context, chat ChatRef, sub Subscriber, initialize func(*Session, bool, func()), validate func() error, run func(*Session) error) (*Session, bool, func(), error) {
	return m.acquire(ctx, chat, sub, initialize, validate, run, nil, true, false, false)
}

// ResumeInitialized resumes a durable cursor through the ordinary acquisition
// checks but never falls back to a fresh session when that cursor is unusable.
func (m *Manager) ResumeInitialized(ctx context.Context, chat ChatRef, sub Subscriber, initialize func(*Session, bool, func())) (*Session, bool, func(), error) {
	return m.acquire(ctx, chat, sub, initialize, nil, nil, nil, false, true, false)
}

// ResumeInitializedChecked is ResumeInitialized with metadata-generation
// validation before and after provider acquisition.
func (m *Manager) ResumeInitializedChecked(ctx context.Context, chat ChatRef, sub Subscriber, initialize func(*Session, bool, func()), validate func() error) (*Session, bool, func(), error) {
	return m.acquire(ctx, chat, sub, initialize, validate, nil, nil, false, true, false)
}

// ResumeInitializedCheckedAndRun keeps the per-chat permit through acquisition
// and run. It is used by transports that must preserve ordering between a
// resume and the mutation that caused it.
func (m *Manager) ResumeInitializedCheckedAndRun(ctx context.Context, chat ChatRef, sub Subscriber, initialize func(*Session, bool, func()), validate func() error, run func(*Session) error) (*Session, bool, func(), error) {
	return m.acquire(ctx, chat, sub, initialize, validate, run, nil, false, true, false)
}

// ResumeInitializedCheckedAndRunInFlight is the queued-recovery form. The
// caller already owns the chat through EnqueueChat and the acquire therefore
// preserves that exact FIFO position instead of waiting on itself. published
// runs after route publication so transports can bind before replay; run waits
// until replay has finished and the route has been revalidated.
func (m *Manager) ResumeInitializedCheckedAndRunInFlight(ctx context.Context, chat ChatRef, sub Subscriber, initialize func(*Session, bool, func()), validate func() error, published func(*Session) error, run func(*Session) error) (*Session, bool, func(), error) {
	return m.acquire(ctx, chat, sub, initialize, validate, published, run, false, true, true)
}

func (m *Manager) acquire(ctx context.Context, chat ChatRef, sub Subscriber, initialize func(*Session, bool, func()), validate func() error, after func(*Session) error, afterHydration func(*Session) error, recoveryAuthorized, resumeOnly, permitHeld bool) (*Session, bool, func(), error) {
	if chat == nil || chat.ChatID() == "" {
		return nil, false, nil, errors.New("session: empty chat id")
	}
	if m.cfg.Client == nil {
		return nil, false, nil, errors.New("session: nil rpc client")
	}
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil, false, nil, ErrManagerClosed
	}
	m.acquireWG.Add(1)
	m.mu.Unlock()
	defer m.acquireWG.Done()

	ctx, cancel := context.WithCancel(ctx)
	stopShutdownCancel := context.AfterFunc(m.shutdownCtx, cancel)
	defer func() { stopShutdownCancel(); cancel() }()

	chatID := chat.ChatID()
	var err error
	if !permitHeld {
		unlock, err := m.chats.enter(ctx, chatID)
		if err != nil {
			if m.isClosed() {
				return nil, false, nil, ErrManagerClosed
			}
			return nil, false, nil, err
		}
		defer unlock()
	}

	// A delete that acquired the flight first has already invalidated callers
	// prepared against its prior metadata generation. Reject them before they
	// can open a route that would appear after the delete's retiring-set drain.
	if validate != nil {
		if err := validate(); err != nil {
			return nil, false, nil, err
		}
	}

	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil, false, nil, ErrManagerClosed
	}
	managerGeneration := m.generation
	slotGeneration := m.slotGeneration[chatID]
	existing := m.byChat[chatID]
	replaced := existing
	if m.operationOwners == nil {
		m.operationOwners = make(map[string]*sendOperationOwner)
	}
	sendOwner := m.operationOwners[chatID]
	if sendOwner == nil {
		sendOwner = &sendOperationOwner{operations: make(map[string]sendOperation), sessions: make(map[*Session]struct{})}
		m.operationOwners[chatID] = sendOwner
	}
	m.mu.Unlock()
	revalidateMutation := func(s *Session) error {
		if validate != nil {
			if err := validate(); err != nil {
				return err
			}
		}
		if err := s.acquisitionError(); err != nil {
			return err
		}
		m.mu.Lock()
		valid := !m.closed && m.generation == managerGeneration && m.slotGeneration[chatID] == slotGeneration && m.byChat[chatID] == s
		epochLive := m.cfg.Client.EpochCurrent(s.epoch)
		if _, invalidated := m.invalidatedEpochs[s.epoch]; invalidated {
			epochLive = false
		}
		m.mu.Unlock()
		if !valid {
			return ErrManagerClosed
		}
		if !epochLive {
			return ErrSessionResumable
		}
		return nil
	}
	if existing != nil {
		routeErr := existing.acquisitionError()
		if routeErr == nil {
			var detach func()
			var target *subscription
			var attachErr error
			if existing.sessionFile != "" {
				detach, target, attachErr = existing.attachCheckedReplayTarget(sub)
			} else {
				detach, target, attachErr = existing.attachCheckedTarget(sub)
			}
			if attachErr == nil {
				if initialize != nil {
					initialize(existing, false, detach)
				}
				if validate != nil {
					if err := validate(); err != nil {
						detach()
						return nil, false, nil, err
					}
				}
				if after != nil {
					if err := after(existing); err != nil {
						return existing, false, detach, err
					}
				}
				// Checked callers publish and activate their validated binding in
				// after before history can fill a transport's staging buffer.
				if existing.sessionFile != "" {
					hydrateForSubscriber(ctx, existing, existing.sessionFile, target)
				}
				if afterHydration != nil {
					if err := revalidateMutation(existing); err != nil {
						return existing, false, detach, err
					}
					if err := afterHydration(existing); err != nil {
						return existing, false, detach, err
					}
				}
				return existing, false, detach, nil
			}
			routeErr = attachErr
		}
		var drift *ExternalWriteError
		if errors.As(routeErr, &drift) {
			if !recoveryAuthorized {
				return nil, false, nil, drift
			}
			// Explicit recovery stops the quarantined route before reopening the
			// stored path, so the provider never sees two owners for one file.
			if err := existing.closeContext(ctx); err != nil {
				return nil, false, nil, err
			}
			m.mu.Lock()
			slotGeneration = m.slotGeneration[chatID]
			existing = m.byChat[chatID]
			m.mu.Unlock()
		} else if !errors.Is(routeErr, ErrSessionClosed) && !errors.Is(routeErr, ErrSessionResumable) {
			return nil, false, nil, routeErr
		}
	}

	cur := Cursor{}
	if m.cfg.Store != nil {
		cur, err = m.cfg.Store.CursorForOpen(ctx, chatID)
		if err != nil {
			return nil, false, nil, err
		}
	}

	resumed := cur.SessionFile != ""
	if resumeOnly && !resumed {
		return nil, false, nil, ErrNoDurableCursor
	}
	var sessionFileIdentity os.FileInfo
	if resumed && cur.InPlace {
		sessionFileIdentity, err = os.Lstat(cur.SessionFile)
		if err != nil {
			return nil, false, nil, externalIdentityReadError(err)
		}
	}
	data, epoch, openErr := m.open(ctx, chatID, chat.CWD(), cur.SessionFile)
	if openErr == nil {
		openErr = validateOpen(data, cur, resumed)
	}
	if openErr != nil && data.SessionID != "" {
		m.discardRouting(chatID, data.SessionID, epoch)
	}
	if openErr != nil && m.isClosed() {
		return nil, false, nil, ErrManagerClosed
	}
	var recovery *ErrorInfo
	preserveCursor := false
	if openErr != nil && resumed {
		slog.Warn("failed to resume provider session", "chat_id", chatID, "error", openErr)
		info := ErrorInfo{Code: "resume_failed", Message: "could not resume the saved session", StoredIdentity: cur, Dangling: danglingResume(openErr)}
		recovery = &info
		if resumeOnly {
			return nil, false, nil, &ResumeError{Info: info, Cause: openErr}
		}
		if cur.InPlace {
			// An in-place cursor names the user's original file. Opening without
			// that path would create launch debris and then mislabel it in-place.
			// Preserve the typed provider error (notably session_path_in_use) and
			// leave the cursor untouched for a later explicit recovery.
			if replaced != nil {
				replaced.publishError(info)
			}
			return nil, false, nil, openErr
		}
		if !definitiveResumeFailure(openErr) {
			if replaced != nil {
				replaced.publishError(info)
			}
			return nil, false, nil, openErr
		}
		data, epoch, err = m.open(ctx, chatID, chat.CWD(), "")
		if err == nil {
			err = validateOpen(data, Cursor{}, false)
		}
		if err != nil {
			if data.SessionID != "" {
				m.discardRouting(chatID, data.SessionID, epoch)
			}
			return nil, false, nil, fmt.Errorf("resume failed (%v), fallback open failed: %w", openErr, err)
		}
		resumed = false
		preserveCursor = true
	} else if openErr != nil {
		if m.isClosed() {
			return nil, false, nil, ErrManagerClosed
		}
		return nil, false, nil, openErr
	}

	// Only an explicitly marked creation-time default is replaceable. Empty
	// names also derive naturally; every other auto/provider name is established,
	// regardless of which durable identity fields happen to be available.
	name := cur.Name
	if cur.TitleIsPlaceholder && cur.NameSource != NameSourceUser {
		name = ""
	}
	if providerName := strings.TrimSpace(data.State.SessionName); providerName != "" && name == "" && cur.NameSource != NameSourceUser {
		name = providerName
	}
	s := newSession(m, chatID, chat.CWD(), data, resumed, epoch, name, cur.NameSource)
	s.inheritSendOperationOwner(sendOwner)
	sendOwnerAdopted := false
	defer func() {
		if !sendOwnerAdopted {
			s.releaseSendOperations()
		}
	}()
	s.inPlace = cur.InPlace
	s.writePrepared = cur.WritePrepared
	s.sessionFileIdentity = sessionFileIdentity
	identityChanged := cur.SessionFile != data.State.SessionFile || cur.DurableSessionID != data.State.SessionID
	if m.cfg.Store != nil && !preserveCursor && identityChanged {
		if err := m.cfg.Store.UpdateIdentity(ctx, chatID, data.State.SessionFile, data.State.SessionID); err != nil {
			m.discardRouting(chatID, data.SessionID, epoch)
			return nil, false, nil, err
		}
	}

	// The checked bridge path initializes an unpublished route first. This lets
	// API deletion finish its metadata flush while initialization is in flight,
	// then reject the stale generation without ever exposing it in byChat.
	if validate != nil {
		m.mu.Lock()
		valid := !m.closed && m.generation == managerGeneration && m.slotGeneration[chatID] == slotGeneration && m.byChat[chatID] == existing
		m.mu.Unlock()
		if !valid {
			m.discardRouting(chatID, data.SessionID, epoch)
			return nil, false, nil, ErrManagerClosed
		}
		if !m.cfg.Client.EpochCurrent(epoch) {
			m.discardRouting(chatID, data.SessionID, epoch)
			return nil, false, nil, ErrSessionResumable
		}
		var detach func()
		var target *subscription
		var attachErr error
		if resumed {
			initial := make([]Frame, 0, 2)
			if recovery != nil {
				initial = append(initial, Frame{Kind: FrameError, SessionID: s.ID(), Data: *recovery})
			}
			initial = append(initial, Frame{Kind: FrameReady, SessionID: s.ID(), Resumed: true})
			detach, target, attachErr = s.attachCheckedReplayTarget(sub, initial...)
		} else {
			detach, target, attachErr = s.attachCheckedTarget(sub)
		}
		if attachErr != nil {
			m.discardRouting(chatID, data.SessionID, epoch)
			return nil, false, nil, attachErr
		}
		if !resumed {
			s.lifecycleMu.Lock()
			if recovery != nil {
				s.publishLocked(Frame{Kind: FrameError, SessionID: s.ID(), Data: *recovery})
			}
			s.publishLocked(Frame{Kind: FrameReady, SessionID: s.ID()})
			s.lifecycleMu.Unlock()
		}
		if initialize != nil {
			initialize(s, true, detach)
		}
		if err := validate(); err != nil {
			detach()
			s.retireReplaced()
			m.discardRouting(chatID, data.SessionID, epoch)
			return nil, false, nil, err
		}
		var overviewSnapshot Summary
		var overviewSubscribers []*overviewSubscriber
		s.lifecycleMu.Lock()
		m.mu.Lock()
		valid = !m.closed && m.generation == managerGeneration && m.slotGeneration[chatID] == slotGeneration && m.byChat[chatID] == existing
		epochLive := m.cfg.Client.EpochCurrent(epoch)
		if _, invalidated := m.invalidatedEpochs[epoch]; invalidated {
			epochLive = false
		}
		_, cleanupInFlight := m.routeCleanup[data.SessionID]
		if valid && epochLive && !cleanupInFlight {
			sendOwnerAdopted = true
			if existing != nil {
				delete(m.byRoute, existing.routingID)
			}
			m.byChat[chatID] = s
			m.byRoute[data.SessionID] = s
			delete(m.overviewCurrent, chatID)
			overviewSnapshot, overviewSubscribers = m.mergeOverviewIntoSessionLocked(s)
		}
		m.mu.Unlock()
		s.lifecycleMu.Unlock()
		deliverOverview(overviewSubscribers, overviewSnapshot)
		if !valid || !epochLive || cleanupInFlight {
			detach()
			if cleanupInFlight && valid {
				s.invalidate("provider_disconnected", "provider route cleanup was already in progress")
			} else {
				s.retireReplaced()
				m.discardRouting(chatID, data.SessionID, epoch)
			}
			if !valid {
				return nil, false, nil, ErrManagerClosed
			}
			return nil, false, nil, ErrSessionResumable
		}
		if after != nil {
			if err := after(s); err != nil {
				if replaced != nil {
					replaced.retireReplaced()
				}
				return s, true, detach, err
			}
		}
		if resumed {
			hydrateForSubscriber(ctx, s, cur.SessionFile, target)
		}
		if afterHydration != nil {
			if err := revalidateMutation(s); err != nil {
				if replaced != nil {
					replaced.retireReplaced()
				}
				return s, true, detach, err
			}
			if err := afterHydration(s); err != nil {
				if replaced != nil {
					replaced.retireReplaced()
				}
				return s, true, detach, err
			}
		}
		if replaced != nil {
			replaced.retireReplaced()
		}
		return s, true, detach, nil
	}

	var overviewSnapshot Summary
	var overviewSubscribers []*overviewSubscriber
	s.lifecycleMu.Lock()
	m.mu.Lock()
	valid := !m.closed && m.generation == managerGeneration && m.slotGeneration[chatID] == slotGeneration && m.byChat[chatID] == existing
	epochLive := m.cfg.Client.EpochCurrent(epoch)
	if _, invalidated := m.invalidatedEpochs[epoch]; invalidated {
		epochLive = false
	}
	_, cleanupInFlight := m.routeCleanup[data.SessionID]
	if valid {
		sendOwnerAdopted = true
		if existing != nil {
			delete(m.byRoute, existing.routingID)
		}
		m.byChat[chatID] = s
		delete(m.overviewCurrent, chatID)
		if epochLive && !cleanupInFlight {
			m.byRoute[data.SessionID] = s
			overviewSnapshot, overviewSubscribers = m.mergeOverviewIntoSessionLocked(s)
		}
	}
	m.mu.Unlock()
	s.lifecycleMu.Unlock()
	deliverOverview(overviewSubscribers, overviewSnapshot)
	if !valid {
		m.discardRouting(chatID, data.SessionID, epoch)
		return nil, false, nil, ErrManagerClosed
	}
	if !epochLive || cleanupInFlight {
		message := "provider connection changed while opening session"
		if cleanupInFlight {
			message = "provider route cleanup was already in progress"
		}
		s.invalidate("provider_disconnected", message)
		if existing != nil {
			existing.retireReplaced()
		}
		return s, true, nil, ErrSessionResumable
	}

	var detach func()
	var target *subscription
	var attachErr error
	if resumed {
		initial := make([]Frame, 0, 2)
		if recovery != nil {
			initial = append(initial, Frame{Kind: FrameError, SessionID: s.ID(), Data: *recovery})
		}
		initial = append(initial, Frame{Kind: FrameReady, SessionID: s.ID(), Resumed: true})
		detach, target, attachErr = s.attachCheckedReplayTarget(sub, initial...)
	} else {
		detach, target, attachErr = s.attachCheckedTarget(sub)
	}
	if attachErr != nil {
		m.mu.Lock()
		m.retireSessionIdentityLocked(s, true)
		m.mu.Unlock()
		m.discardRouting(chatID, data.SessionID, epoch)
		return nil, false, nil, attachErr
	}
	if !resumed {
		s.lifecycleMu.Lock()
		if recovery != nil {
			s.publishLocked(Frame{Kind: FrameError, SessionID: s.ID(), Data: *recovery})
		}
		s.publishLocked(Frame{Kind: FrameReady, SessionID: s.ID()})
		s.lifecycleMu.Unlock()
	}
	if replaced != nil {
		replaced.retireReplaced()
	}
	if initialize != nil {
		initialize(s, true, detach)
	}
	if resumed {
		hydrateForSubscriber(ctx, s, cur.SessionFile, target)
	}
	if after != nil {
		if err := after(s); err != nil {
			return s, true, detach, err
		}
	}
	if afterHydration != nil {
		if err := revalidateMutation(s); err != nil {
			return s, true, detach, err
		}
		if err := afterHydration(s); err != nil {
			return s, true, detach, err
		}
	}
	return s, true, detach, nil
}

func validateOpen(data omorpc.OpenSessionData, cur Cursor, resumed bool) error {
	if data.SessionID == "" {
		return errors.New("session: open_session returned empty routing session id")
	}
	if data.State.SessionID == "" {
		return errors.New("session: open_session returned empty durable session id")
	}
	if data.State.SessionFile == "" {
		return errors.New("session: open_session returned empty sessionFile")
	}
	if resumed && cur.DurableSessionID != "" && data.State.SessionID != cur.DurableSessionID {
		return fmt.Errorf("durable session id mismatch: provider %q, stored %q", data.State.SessionID, cur.DurableSessionID)
	}
	if resumed && cur.InPlace && data.State.SessionFile != cur.SessionFile {
		return fmt.Errorf("in-place session path mismatch: provider %q, stored %q", data.State.SessionFile, cur.SessionFile)
	}
	return nil
}

func definitiveResumeFailure(err error) bool {
	var stable *omorpc.StableError
	if errors.As(err, &stable) {
		return true
	}
	// Validation/decode failures happened after a successful response, so the
	// request definitively landed and its routing handle was discarded.
	return !errors.Is(err, omorpc.ErrDisconnected) && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded)
}

// beginFallbackCleanup fences publication of route while a dead-epoch close
// is sent on the current connection. Ownership inspection and marker creation
// share one critical section, so a colliding open cannot publish between them.
func (m *Manager) beginFallbackCleanup(owner *Session, route string) (chan struct{}, bool) {
	if route == "" {
		return nil, false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if holder := m.byRoute[route]; holder != nil && holder != owner {
		return nil, false
	}
	if _, cleaning := m.routeCleanup[route]; cleaning {
		return nil, false
	}
	done := make(chan struct{})
	m.routeCleanup[route] = done
	return done, true
}

func (m *Manager) endRouteCleanup(route string, expected chan struct{}) {
	m.mu.Lock()
	if done := m.routeCleanup[route]; done == expected {
		delete(m.routeCleanup, route)
		close(done)
	}
	m.mu.Unlock()
}

// RouteCleanupDone returns a channel that closes when the active fallback
// cleanup for route definitively settles. It is already closed when route has
// no active cleanup marker.
func (m *Manager) RouteCleanupDone(route string) <-chan struct{} {
	m.mu.Lock()
	done := m.routeCleanup[route]
	m.mu.Unlock()
	if done != nil {
		return done
	}
	settled := make(chan struct{})
	close(settled)
	return settled
}

func (m *Manager) discardRouting(chatID, route string, epoch omorpc.EpochToken) {
	if route == "" {
		return
	}
	retiring := retiringRoute{route: route, epoch: epoch}
	m.mu.Lock()
	m.rememberRetiringLocked(chatID, retiring)
	m.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), m.cfg.CloseTimeout)
	defer cancel()
	_, _, err := m.cfg.Client.CallInEpochToken(ctx, epoch, omorpc.CloseSession{SessionID: route})
	if definitiveCloseFailure(err) || errors.Is(err, omorpc.ErrEpochMismatch) {
		m.mu.Lock()
		m.removeRetiringLocked(chatID, retiring)
		m.mu.Unlock()
		return
	}
	slog.Warn("failed to discard provider routing handle; retaining for delete retry", "chat_id", chatID, "routing_id", route, "error", err)
}

func (m *Manager) rememberRetiringLocked(chatID string, route retiringRoute) {
	routes := m.retiringByChat[chatID]
	if routes == nil {
		routes = make(map[retiringRoute]struct{})
		m.retiringByChat[chatID] = routes
	}
	if _, exists := routes[route]; exists {
		return
	}
	routes[route] = struct{}{}
	m.retiringFIFO = append(m.retiringFIFO, retiringRecord{chatID: chatID, route: route})
	for len(m.retiringFIFO) > maxRetiringRoutes {
		old := m.retiringFIFO[0]
		m.retiringFIFO = m.retiringFIFO[1:]
		m.removeRetiringLocked(old.chatID, old.route)
	}
}

func (m *Manager) removeRetiringLocked(chatID string, route retiringRoute) {
	routes := m.retiringByChat[chatID]
	delete(routes, route)
	if len(routes) == 0 {
		delete(m.retiringByChat, chatID)
	}
}

func (m *Manager) drainRetiring(ctx context.Context, chatID string) error {
	m.mu.Lock()
	routes := make([]retiringRoute, 0, len(m.retiringByChat[chatID]))
	for route := range m.retiringByChat[chatID] {
		routes = append(routes, route)
	}
	m.mu.Unlock()
	var first error
	for _, route := range routes {
		_, _, err := m.cfg.Client.CallInEpochToken(ctx, route.epoch, omorpc.CloseSession{SessionID: route.route})
		if definitiveCloseFailure(err) || errors.Is(err, omorpc.ErrEpochMismatch) {
			m.mu.Lock()
			m.removeRetiringLocked(chatID, route)
			m.mu.Unlock()
		} else if first == nil {
			first = err
		}
	}
	return first
}

type openResult struct {
	data     omorpc.OpenSessionData
	response *omorpc.Response
	epoch    omorpc.EpochToken
	err      error
	detached bool
}

// open keeps transport ownership after its caller stops waiting. The manager
// tracks that ownership until the response or epoch death is observed and any
// routing handle from a late success has been closed.
func (m *Manager) open(ctx context.Context, chatID, cwd, path string) (omorpc.OpenSessionData, omorpc.EpochToken, error) {
	for {
		select {
		case m.openSlots <- struct{}{}:
		default:
			return omorpc.OpenSessionData{}, omorpc.EpochToken{}, ErrOpenBusy
		}
		m.mu.Lock()
		pending := m.pendingOpen[chatID]
		if pending == nil {
			m.pendingOpen[chatID] = make(chan struct{})
			m.mu.Unlock()
			break
		}
		m.mu.Unlock()
		<-m.openSlots
		select {
		case <-pending:
			if err := ctx.Err(); err != nil {
				return omorpc.OpenSessionData{}, omorpc.EpochToken{}, fmt.Errorf("session: waiting for in-flight open: %w", err)
			}
		case <-ctx.Done():
			return omorpc.OpenSessionData{}, omorpc.EpochToken{}, fmt.Errorf("session: waiting for in-flight open: %w", ctx.Err())
		}
	}
	opCtx, cancel := context.WithCancel(context.Background())
	result := make(chan openResult, 1)
	m.cleanupWG.Add(1)
	go func() {
		data, epoch, detached, err := m.openCall(opCtx, chatID, cwd, path)
		result <- openResult{data: data, epoch: epoch, err: err, detached: detached}
	}()

	select {
	case got := <-result:
		cancel()
		if !got.detached {
			m.clearPendingOpen(chatID)
		}
		m.cleanupWG.Done()
		return got.data, got.epoch, got.err
	case <-ctx.Done():
		timer := time.NewTimer(m.cfg.CloseTimeout)
		select {
		case got := <-result:
			timer.Stop()
			cancel()
			if !got.detached {
				m.clearPendingOpen(chatID)
			}
			if got.data.SessionID != "" {
				m.discardRouting(chatID, got.data.SessionID, got.epoch)
			}
			m.cleanupWG.Done()
		case <-timer.C:
			cancel()
			select {
			case m.openCleanupExpired <- struct{}{}:
			default:
			}
			got := <-result
			if !got.detached {
				m.clearPendingOpen(chatID)
			}
			if got.data.SessionID != "" {
				m.discardRouting(chatID, got.data.SessionID, got.epoch)
			}
			m.cleanupWG.Done()
		}
		return omorpc.OpenSessionData{}, omorpc.EpochToken{}, ctx.Err()
	}
}

func (m *Manager) clearPendingOpen(chatID string) {
	m.mu.Lock()
	if pending := m.pendingOpen[chatID]; pending != nil {
		delete(m.pendingOpen, chatID)
		<-m.openSlots
		close(pending)
	}
	m.mu.Unlock()
}

func (m *Manager) openCall(ctx context.Context, chatID, cwd, path string) (omorpc.OpenSessionData, omorpc.EpochToken, bool, error) {
	cmd := omorpc.OpenSession{CWD: cwd}
	if path != "" {
		cmd = omorpc.OpenSession{SessionPath: path}
	}
	var last error
	var epoch omorpc.EpochToken
	for attempt := 0; attempt < m.cfg.RetryAttempts; attempt++ {
		completion := make(chan openResult, 1)
		err := m.cfg.Client.CallDetached(ctx, cmd, func(resp *omorpc.Response, responseEpoch omorpc.EpochToken, err error) {
			completion <- openResult{epoch: responseEpoch, err: err, response: resp}
		})
		var resp *omorpc.Response
		if err == nil {
			select {
			case got := <-completion:
				resp, epoch, err = got.response, got.epoch, got.err
			case <-ctx.Done():
				// The caller stops waiting now, but detached correlation ownership
				// remains until the response or epoch settles. A late success is
				// closed so cancellation can never orphan a provider route.
				m.cleanupWG.Add(1)
				go func() {
					defer m.cleanupWG.Done()
					defer m.clearPendingOpen(chatID)
					got := <-completion
					if got.err != nil || got.response == nil {
						return
					}
					var late omorpc.OpenSessionData
					if json.Unmarshal(got.response.Data, &late) == nil && late.SessionID != "" {
						m.discardRouting(chatID, late.SessionID, got.epoch)
					}
				}()
				return omorpc.OpenSessionData{}, epoch, true, ctx.Err()
			}
		}
		if err == nil {
			var out omorpc.OpenSessionData
			if err := json.Unmarshal(resp.Data, &out); err != nil {
				return out, epoch, false, fmt.Errorf("session: decode open_session: %w", err)
			}
			return out, epoch, false, nil
		}
		last = err
		var stable *omorpc.StableError
		if !errors.As(err, &stable) || stable.Code != omorpc.ErrCodeSessionPathInUse || attempt+1 >= m.cfg.RetryAttempts {
			break
		}
		t := time.NewTimer(m.cfg.RetryBackoff)
		select {
		case <-t.C:
		case <-ctx.Done():
			t.Stop()
			return omorpc.OpenSessionData{}, epoch, false, ctx.Err()
		}
	}
	return omorpc.OpenSessionData{}, epoch, false, last
}

func danglingResume(err error) bool {
	var stable *omorpc.StableError
	if !errors.As(err, &stable) {
		return false
	}
	return stable.Code == omorpc.ErrCodeInvalidPath || (stable.Code == omorpc.ErrCodeOpenFailed && strings.Contains(strings.ToLower(stable.Detail), "no such"))
}

func (m *Manager) isClosed() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.closed
}

func (m *Manager) bumpSlotGenerationLocked(chatID string) {
	m.slotGeneration[chatID]++
	record := generationRecord{chatID: chatID, generation: m.slotGeneration[chatID]}
	m.slotGenerationFIFO = append(m.slotGenerationFIFO, record)
	for len(m.slotGenerationFIFO) > maxSlotGenerations {
		old := m.slotGenerationFIFO[0]
		m.slotGenerationFIFO = m.slotGenerationFIFO[1:]
		if m.slotGeneration[old.chatID] == old.generation {
			if _, live := m.byChat[old.chatID]; !live {
				delete(m.slotGeneration, old.chatID)
			}
		}
	}
}

// EnterChat serializes transport work for a chat. The returned release must be
// called exactly once; waiting respects ctx cancellation.
func (m *Manager) EnterChat(ctx context.Context, chatID string) (func(), error) {
	return m.chats.enter(ctx, chatID)
}

// EnqueueChat reserves a FIFO chat-owner position before returning. run is
// invoked asynchronously while that position is owned.
func (m *Manager) EnqueueChat(chatID string, run func()) {
	m.chats.enqueue(chatID, run)
}

func (m *Manager) Get(chatID string) (*Session, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.byChat[chatID]
	return s, ok
}

func (m *Manager) LiveSummaries() []Summary {
	m.mu.Lock()
	all := make([]*Session, 0, len(m.byChat))
	for _, s := range m.byChat {
		if _, retired := m.retiredDurable[s.durableID]; !retired {
			all = append(all, s)
		}
	}
	cached := make([]Summary, 0, len(m.overviewCache))
	for id, entry := range m.overviewCache {
		cached = append(cached, entry.summary(entry.chatID, id))
	}
	m.mu.Unlock()
	out := make([]Summary, 0, len(all)+len(cached))
	for _, s := range all {
		if sum, ok := s.summary(); ok {
			out = append(out, sum)
		}
	}
	out = append(out, cached...)
	sort.Slice(out, func(i, j int) bool { return out[i].ChatID < out[j].ChatID })
	return out
}

func (m *Manager) Stop(chatID string) error { return m.stopContext(context.Background(), chatID) }

// StopContext is the cancellable form used by request-bound transports.
func (m *Manager) StopContext(ctx context.Context, chatID string) error {
	return m.stopContext(ctx, chatID)
}

// StopAndMutateContext retires every provider route for chatID and runs mutate
// while holding the same per-chat permit used by Acquire. A later acquire
// therefore cannot observe metadata from before mutate.
func (m *Manager) StopAndMutateContext(ctx context.Context, chatID string, mutate func() error) error {
	unlock, err := m.chats.enter(ctx, chatID)
	if err != nil {
		return err
	}
	defer unlock()
	if err := m.stopChatInFlight(ctx, chatID); err != nil {
		return err
	}
	if mutate == nil {
		return nil
	}
	return mutate()
}

func (m *Manager) stopContext(ctx context.Context, chatID string) error {
	unlock, err := m.chats.enter(ctx, chatID)
	if err != nil {
		return err
	}
	defer unlock()
	return m.stopChatInFlight(ctx, chatID)
}

func (m *Manager) stopChatInFlight(ctx context.Context, chatID string) error {
	m.mu.Lock()
	m.bumpSlotGenerationLocked(chatID)
	s := m.byChat[chatID]
	m.mu.Unlock()
	if s != nil {
		if err := s.closeContext(ctx); err != nil {
			return err
		}
	}
	return m.drainRetiring(ctx, chatID)
}

func (m *Manager) CloseAll(ctx context.Context) error {
	m.mu.Lock()
	if !m.closed {
		m.closed = true
		m.generation++
		m.closeOnce.Do(func() {
			m.shutdownCancel()
			close(m.done)
		})
	}
	m.mu.Unlock()

	acquiresDone := make(chan struct{})
	go func() { m.acquireWG.Wait(); close(acquiresDone) }()
	select {
	case <-acquiresDone:
	case <-ctx.Done():
		return ctx.Err()
	}
	m.eventWG.Wait()

	cleanupsDone := make(chan struct{})
	go func() { m.cleanupWG.Wait(); close(cleanupsDone) }()
	drainTimer := time.NewTimer(cleanupDrainTimeout)
	defer drainTimer.Stop()
	select {
	case <-cleanupsDone:
	case <-ctx.Done():
		return ctx.Err()
	case <-drainTimer.C:
		return errors.New("session: timed out draining detached cleanup")
	}

	m.mu.Lock()
	all := make([]*Session, 0, len(m.byChat))
	for _, s := range m.byChat {
		all = append(all, s)
	}
	m.byChat = make(map[string]*Session)
	m.byRoute = make(map[string]*Session)
	m.operationOwners = make(map[string]*sendOperationOwner)
	m.byDurableEpoch = make(map[omorpc.EpochToken]map[string]*durableEpochBinding)
	m.durableTombstones = nil
	m.durableToChat = make(map[string]string)
	m.retiredDurable = make(map[string]uint64)
	m.retiredDurableFIFO = nil
	m.invalidatedEpochs = make(map[omorpc.EpochToken]struct{})
	m.epochIngestions = make(map[omorpc.EpochToken]int)
	m.slotGeneration = make(map[string]uint64)
	m.slotGenerationFIFO = nil
	m.overviewCache = make(map[string]*overviewCacheEntry)
	m.overviewCurrent = make(map[string]Summary)
	for id, sub := range m.overviewSubscribers {
		delete(m.overviewSubscribers, id)
		close(sub.stop)
	}
	m.mu.Unlock()
	var first error
	for _, s := range all {
		if err := s.closeContext(ctx); err != nil && first == nil {
			first = err
		}
	}
	m.mu.Lock()
	retiringChats := make([]string, 0, len(m.retiringByChat))
	for chatID := range m.retiringByChat {
		retiringChats = append(retiringChats, chatID)
	}
	m.mu.Unlock()
	for _, chatID := range retiringChats {
		if err := m.drainRetiring(ctx, chatID); err != nil && first == nil {
			first = err
		}
	}
	return first
}

func (m *Manager) evict(s *Session) {
	unlock, err := m.chats.enter(context.Background(), s.chatID)
	if err != nil {
		return
	}
	defer unlock()
	s.lifecycleMu.Lock()
	if s.closed || s.closing || s.resumable || s.activeLocked() || s.broadcast.count() != 0 ||
		(s.sendOwner != nil && s.sendOwner.activeDetached.Load() != 0) {
		s.lifecycleMu.Unlock()
		return
	}
	m.mu.Lock()
	current := m.byChat[s.chatID] == s
	m.mu.Unlock()
	if !current {
		s.lifecycleMu.Unlock()
		return
	}
	txn := s.beginCloseLocked(true)
	s.lifecycleMu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), m.cfg.CloseTimeout)
	err = s.executeClose(ctx, txn)
	cancel()
	if err != nil {
		slog.Warn("idle session close pending or rejected; retaining session", "chat_id", s.chatID, "error", err)
	}
}
