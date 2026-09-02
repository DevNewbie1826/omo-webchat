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
	permit chan struct{}
	refs   int
}

// enter serializes operations for one chat through a permit channel. Waiting
// is cancellable so manager shutdown can drain every keyed-flight entry.
func (k *keyedFlight) enter(ctx context.Context, key string) (func(), error) {
	k.mu.Lock()
	if k.flights == nil {
		k.flights = make(map[string]*chatFlight)
	}
	x := k.flights[key]
	if x == nil {
		x = &chatFlight{permit: make(chan struct{}, 1)}
		x.permit <- struct{}{}
		k.flights[key] = x
	}
	x.refs++
	k.mu.Unlock()
	select {
	case <-x.permit:
		return func() {
			x.permit <- struct{}{}
			k.release(key, x)
		}, nil
	case <-ctx.Done():
		k.release(key, x)
		return nil, ctx.Err()
	}
}

func (k *keyedFlight) release(key string, x *chatFlight) {
	k.mu.Lock()
	x.refs--
	if x.refs == 0 {
		delete(k.flights, key)
	}
	k.mu.Unlock()
}

const (
	maxSlotGenerations  = 1024
	maxRetiringRoutes   = 1024
	cleanupDrainTimeout = 5 * time.Second
)

type generationRecord struct {
	chatID     string
	generation uint64
}

type retiringRecord struct {
	chatID string
	route  string
}

type Manager struct {
	cfg Config

	chats              keyedFlight
	mu                 sync.Mutex
	byChat             map[string]*Session
	byRoute            map[string]*Session
	retiringByChat     map[string]map[string]struct{}
	retiringFIFO       []retiringRecord
	slotGeneration     map[string]uint64
	slotGenerationFIFO []generationRecord
	generation         uint64
	closed             bool
	done               chan struct{}
	shutdownCtx        context.Context
	shutdownCancel     context.CancelFunc
	closeOnce          sync.Once
	acquireWG          sync.WaitGroup
	cleanupWG          sync.WaitGroup
	eventWG            sync.WaitGroup
	openCleanupExpired chan struct{}
	pendingOpen        map[string]bool
	openSlots          chan struct{}
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
	m := &Manager{cfg: cfg, byChat: make(map[string]*Session), byRoute: make(map[string]*Session), retiringByChat: make(map[string]map[string]struct{}), slotGeneration: make(map[string]uint64), done: make(chan struct{}), shutdownCtx: shutdownCtx, shutdownCancel: shutdownCancel, openCleanupExpired: make(chan struct{}, 64), pendingOpen: make(map[string]bool), openSlots: make(chan struct{}, cfg.DetachedOpenLimit)}
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
			if ev == nil || ev.SessionID == "" {
				continue
			}
			m.mu.Lock()
			s := m.byRoute[ev.SessionID]
			bound := s != nil && s.epoch == token
			m.mu.Unlock()
			if bound {
				s.dispatchEpoch(token, ev)
			}
		}
	}
}

// invalidateEpoch only retires sessions opened on the token that died. A
// delayed failure from an older request therefore cannot invalidate sessions
// registered after reconnect.
func (m *Manager) invalidateEpoch(token omorpc.EpochToken) {
	m.mu.Lock()
	all := make([]*Session, 0, len(m.byChat))
	for _, s := range m.byChat {
		if s.epoch == token {
			all = append(all, s)
			delete(m.byRoute, s.routingID)
		}
	}
	m.mu.Unlock()
	for _, s := range all {
		s.invalidate("provider_disconnected", "provider connection lost")
	}
}

func (m *Manager) Acquire(ctx context.Context, chat ChatRef, sub Subscriber) (*Session, bool, func(), error) {
	return m.acquire(ctx, chat, sub, nil, nil)
}

// AcquireInitialized keeps the per-chat flight through initialize, allowing a
// transport to publish its binding and complete initial state/history queries
// without cross-socket controls interleaving.
func (m *Manager) AcquireInitialized(ctx context.Context, chat ChatRef, sub Subscriber, initialize func(*Session, bool, func())) (*Session, bool, func(), error) {
	return m.acquire(ctx, chat, sub, initialize, nil)
}

// AcquireInitializedChecked validates its caller's metadata generation before
// provider work and again after initialize, immediately before publication.
// validate must not acquire a lock that nests outside the manager's per-chat
// flight.
func (m *Manager) AcquireInitializedChecked(ctx context.Context, chat ChatRef, sub Subscriber, initialize func(*Session, bool, func()), validate func() error) (*Session, bool, func(), error) {
	return m.acquire(ctx, chat, sub, initialize, validate)
}

func (m *Manager) acquire(ctx context.Context, chat ChatRef, sub Subscriber, initialize func(*Session, bool, func()), validate func() error) (*Session, bool, func(), error) {
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
	unlock, err := m.chats.enter(ctx, chatID)
	if err != nil {
		if m.isClosed() {
			return nil, false, nil, ErrManagerClosed
		}
		return nil, false, nil, err
	}
	defer unlock()

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
	m.mu.Unlock()
	if existing != nil && !existing.Resumable() {
		detach, err := existing.attachChecked(sub)
		if err == nil {
			if existing.sessionFile != "" {
				existing.hydrateEntries(ctx, existing.sessionFile)
			}
			if initialize != nil {
				initialize(existing, false, detach)
			}
			if validate != nil {
				if err := validate(); err != nil {
					detach()
					return nil, false, nil, err
				}
			}
			return existing, false, detach, nil
		}
		if !errors.Is(err, ErrSessionClosed) && !errors.Is(err, ErrSessionResumable) {
			return nil, false, nil, err
		}
	}

	cur := Cursor{}
	if m.cfg.Store != nil {
		cur, err = m.cfg.Store.CursorFor(ctx, chatID)
		if err != nil {
			return nil, false, nil, err
		}
	}

	resumed := cur.SessionFile != ""
	data, epoch, openErr := m.open(ctx, chatID, chat.CWD(), cur.SessionFile)
	if openErr == nil {
		openErr = validateOpen(data, cur, resumed)
	}
	if openErr != nil && data.SessionID != "" {
		m.discardRouting(chatID, data.SessionID)
	}
	if openErr != nil && m.isClosed() {
		return nil, false, nil, ErrManagerClosed
	}
	var recovery *ErrorInfo
	preserveCursor := false
	if openErr != nil && resumed {
		info := ErrorInfo{Code: "resume_failed", Message: openErr.Error(), StoredIdentity: cur, Dangling: danglingResume(openErr)}
		recovery = &info
		if !definitiveResumeFailure(openErr) {
			if existing != nil {
				existing.publishError(info)
			}
			return nil, false, nil, openErr
		}
		data, epoch, err = m.open(ctx, chatID, chat.CWD(), "")
		if err == nil {
			err = validateOpen(data, Cursor{}, false)
		}
		if err != nil {
			if data.SessionID != "" {
				m.discardRouting(chatID, data.SessionID)
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
	if cur.TitleIsPlaceholder {
		name = ""
	}
	s := newSession(m, chatID, chat.CWD(), data, resumed, epoch, name, cur.NameSource)
	identityChanged := cur.SessionFile != data.State.SessionFile || cur.DurableSessionID != data.State.SessionID
	if m.cfg.Store != nil && !preserveCursor && identityChanged {
		if err := m.cfg.Store.UpdateIdentity(ctx, chatID, data.State.SessionFile, data.State.SessionID); err != nil {
			m.discardRouting(chatID, data.SessionID)
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
			m.discardRouting(chatID, data.SessionID)
			return nil, false, nil, ErrManagerClosed
		}
		if !m.cfg.Client.EpochCurrent(epoch) {
			m.discardRouting(chatID, data.SessionID)
			return nil, false, nil, ErrSessionResumable
		}
		detach, err := s.attachChecked(sub)
		if err != nil {
			m.discardRouting(chatID, data.SessionID)
			return nil, false, nil, err
		}
		s.lifecycleMu.Lock()
		if recovery != nil {
			s.publishLocked(Frame{Kind: FrameError, SessionID: s.ID(), Data: *recovery})
		}
		s.publishLocked(Frame{Kind: FrameReady, SessionID: s.ID(), Resumed: resumed})
		s.lifecycleMu.Unlock()
		if resumed {
			s.hydrateEntries(ctx, cur.SessionFile)
		}
		if initialize != nil {
			initialize(s, true, detach)
		}
		if err := validate(); err != nil {
			detach()
			s.retireReplaced()
			m.discardRouting(chatID, data.SessionID)
			return nil, false, nil, err
		}
		m.mu.Lock()
		valid = !m.closed && m.generation == managerGeneration && m.slotGeneration[chatID] == slotGeneration && m.byChat[chatID] == existing
		epochLive := m.cfg.Client.EpochCurrent(epoch)
		if valid && epochLive {
			if existing != nil {
				delete(m.byRoute, existing.routingID)
			}
			m.byChat[chatID] = s
			m.byRoute[data.SessionID] = s
		}
		m.mu.Unlock()
		if !valid || !epochLive {
			detach()
			s.retireReplaced()
			m.discardRouting(chatID, data.SessionID)
			if !epochLive {
				return nil, false, nil, ErrSessionResumable
			}
			return nil, false, nil, ErrManagerClosed
		}
		if existing != nil {
			existing.retireReplaced()
		}
		return s, true, detach, nil
	}

	m.mu.Lock()
	valid := !m.closed && m.generation == managerGeneration && m.slotGeneration[chatID] == slotGeneration && m.byChat[chatID] == existing
	epochLive := m.cfg.Client.EpochCurrent(epoch)
	if valid {
		if existing != nil {
			delete(m.byRoute, existing.routingID)
		}
		m.byChat[chatID] = s
		if epochLive {
			m.byRoute[data.SessionID] = s
		}
	}
	m.mu.Unlock()
	if !valid {
		m.discardRouting(chatID, data.SessionID)
		return nil, false, nil, ErrManagerClosed
	}
	if !epochLive {
		s.invalidate("provider_disconnected", "provider connection changed while opening session")
		if existing != nil {
			existing.retireReplaced()
		}
		return s, true, nil, ErrSessionResumable
	}

	detach, err := s.attachChecked(sub)
	if err != nil {
		m.mu.Lock()
		if m.byChat[chatID] == s {
			delete(m.byChat, chatID)
			delete(m.byRoute, data.SessionID)
			m.bumpSlotGenerationLocked(chatID)
		}
		m.mu.Unlock()
		m.discardRouting(chatID, data.SessionID)
		return nil, false, nil, err
	}
	s.lifecycleMu.Lock()
	if recovery != nil {
		s.publishLocked(Frame{Kind: FrameError, SessionID: s.ID(), Data: *recovery})
	}
	s.publishLocked(Frame{Kind: FrameReady, SessionID: s.ID(), Resumed: resumed})
	s.lifecycleMu.Unlock()
	if existing != nil {
		existing.retireReplaced()
	}
	if resumed {
		s.hydrateEntries(ctx, cur.SessionFile)
	}
	if initialize != nil {
		initialize(s, true, detach)
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

func (m *Manager) discardRouting(chatID, route string) {
	if route == "" {
		return
	}
	m.mu.Lock()
	m.rememberRetiringLocked(chatID, route)
	m.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), m.cfg.CloseTimeout)
	defer cancel()
	_, err := m.cfg.Client.Call(ctx, omorpc.CloseSession{SessionID: route})
	if definitiveCloseFailure(err) {
		m.mu.Lock()
		m.removeRetiringLocked(chatID, route)
		m.mu.Unlock()
		return
	}
	slog.Warn("failed to discard provider routing handle; retaining for delete retry", "chat_id", chatID, "routing_id", route, "error", err)
}

func (m *Manager) rememberRetiringLocked(chatID, route string) {
	routes := m.retiringByChat[chatID]
	if routes == nil {
		routes = make(map[string]struct{})
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

func (m *Manager) removeRetiringLocked(chatID, route string) {
	routes := m.retiringByChat[chatID]
	delete(routes, route)
	if len(routes) == 0 {
		delete(m.retiringByChat, chatID)
	}
}

func (m *Manager) drainRetiring(ctx context.Context, chatID string) error {
	m.mu.Lock()
	routes := make([]string, 0, len(m.retiringByChat[chatID]))
	for route := range m.retiringByChat[chatID] {
		routes = append(routes, route)
	}
	m.mu.Unlock()
	var first error
	for _, route := range routes {
		_, err := m.cfg.Client.Call(ctx, omorpc.CloseSession{SessionID: route})
		if definitiveCloseFailure(err) {
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
	select {
	case m.openSlots <- struct{}{}:
	default:
		return omorpc.OpenSessionData{}, omorpc.EpochToken{}, ErrOpenBusy
	}
	m.mu.Lock()
	if m.pendingOpen[chatID] {
		m.mu.Unlock()
		<-m.openSlots
		return omorpc.OpenSessionData{}, omorpc.EpochToken{}, errors.New("session: open already in flight")
	}
	m.pendingOpen[chatID] = true
	m.mu.Unlock()
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
				m.discardRouting(chatID, got.data.SessionID)
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
				m.discardRouting(chatID, got.data.SessionID)
			}
			m.cleanupWG.Done()
		}
		return omorpc.OpenSessionData{}, omorpc.EpochToken{}, ctx.Err()
	}
}

func (m *Manager) clearPendingOpen(chatID string) {
	m.mu.Lock()
	if m.pendingOpen[chatID] {
		delete(m.pendingOpen, chatID)
		<-m.openSlots
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
						m.discardRouting(chatID, late.SessionID)
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
		all = append(all, s)
	}
	m.mu.Unlock()
	out := make([]Summary, 0, len(all))
	for _, s := range all {
		if sum, ok := s.summary(); ok {
			out = append(out, sum)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ChatID < out[j].ChatID })
	return out
}

func (m *Manager) Stop(chatID string) error { return m.stopContext(context.Background(), chatID) }

// StopContext is the cancellable form used by request-bound transports.
func (m *Manager) StopContext(ctx context.Context, chatID string) error {
	return m.stopContext(ctx, chatID)
}

func (m *Manager) stopContext(ctx context.Context, chatID string) error {
	unlock, err := m.chats.enter(ctx, chatID)
	if err != nil {
		return err
	}
	defer unlock()
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
	m.slotGeneration = make(map[string]uint64)
	m.slotGenerationFIFO = nil
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
	if s.closed || s.closing || s.resumable || s.activeLocked() || s.broadcast.count() != 0 {
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
	s.closing = true
	route := s.routingID
	s.lifecycleMu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), m.cfg.CloseTimeout)
	_, err = m.cfg.Client.Call(ctx, omorpc.CloseSession{SessionID: route})
	cancel()
	if err != nil && !definitiveCloseFailure(err) {
		s.lifecycleMu.Lock()
		s.closing = false
		s.reconcileFailedCloseLocked()
		s.scheduleIdleLocked()
		s.lifecycleMu.Unlock()
		slog.Warn("idle session close failed; retaining session", "chat_id", s.chatID, "error", err)
		return
	}

	s.lifecycleMu.Lock()
	s.closing = false
	s.closed = true
	s.cancelIdleLocked()
	s.publishLocked(Frame{Kind: FrameError, SessionID: s.durableID, Data: ErrorInfo{Code: "session_unloaded", Message: "session unloaded after idle timeout"}})
	m.mu.Lock()
	if m.byChat[s.chatID] == s {
		delete(m.byChat, s.chatID)
		delete(m.byRoute, route)
		m.bumpSlotGenerationLocked(s.chatID)
	}
	m.mu.Unlock()
	s.lifecycleMu.Unlock()
	s.broadcast.close(ErrSubscriberSessionEnd)
}
