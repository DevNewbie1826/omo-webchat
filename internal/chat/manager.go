package chat

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	// resumeOpenAttempts bounds open_session retries for transient failures:
	// one initial attempt plus at most two retries of the identical request.
	resumeOpenAttempts = 3
	// resumeOpenRetryBackoff separates transient open_session retries, giving
	// a racing session teardown time to release the requested path.
	resumeOpenRetryBackoff = 500 * time.Millisecond
)

// Lock order for chat lifecycle state is:
//
//	Session.lifecycleMu -> Manager.mu -> sharedProvider.mu -> Session.mu
//
// A path may skip locks, but must never acquire them in the opposite order.
// In particular, Manager code snapshots a Session pointer and releases
// Manager.mu before waiting for lifecycleMu, while provider callbacks release
// sharedProvider.mu before entering Manager. No lock in this order may be held
// across provider I/O or a channel receive.
type Manager struct {
	mu                  sync.Mutex
	sessions            map[string]*Session
	generations         map[string]*Session
	generationDone      map[string]chan struct{}
	generationLeases    map[string]int
	generationRetiring  map[string]bool
	pending             map[string]bool
	provider            *sharedProvider
	logger              *slog.Logger
	idleFor             time.Duration
	now                 func() time.Time
	stopSweep           chan struct{}
	sweepDone           chan struct{}
	closeOnce           sync.Once
	beforeOpenRegister  func()
	beforeReapLifecycle func()
	afterSweepStopped   func()
}

func NewManager() *Manager {
	m := &Manager{sessions: make(map[string]*Session), generations: make(map[string]*Session), generationDone: make(map[string]chan struct{}), generationLeases: make(map[string]int), generationRetiring: make(map[string]bool), pending: make(map[string]bool), idleFor: 30 * time.Minute, now: time.Now, stopSweep: make(chan struct{}), sweepDone: make(chan struct{})}
	go m.sweep()
	return m
}

// NewManagerWithLogger returns a Manager that reports resume-safety decisions
// (transient retries, permanent fallbacks, dangling stored paths) to logger.
// A nil logger is a no-op.
func NewManagerWithLogger(logger *slog.Logger) *Manager {
	m := NewManager()
	m.logger = logger
	return m
}

func (m *Manager) logWarn(msg string, args ...any) {
	if m.logger != nil {
		m.logger.Warn(msg, args...)
	}
}

// transientOpenError reports whether a failed open_session can succeed when
// retried unchanged: the provider still holds the requested session path open
// in a racing teardown (session_path_in_use), which resolves on its own.
func transientOpenError(err error) bool {
	return err != nil && strings.Contains(err.Error(), "session_path_in_use")
}

// openSessionWithRetry opens the session, retrying transient
// session_path_in_use rejections of the identical request up to
// resumeOpenAttempts attempts in total, bounded by ctx.
func (m *Manager) openSessionWithRetry(ctx context.Context, provider *sharedProvider, s *Session, opts SessionOptions) error {
	var err error
	for attempt := 1; ; attempt++ {
		err = provider.openSession(ctx, s, opts)
		if !transientOpenError(err) || attempt == resumeOpenAttempts {
			return err
		}
		m.logWarn("transient session_path_in_use; retrying open_session", "session", opts.ID, "attempt", attempt, "err", err)
		select {
		case <-time.After(resumeOpenRetryBackoff):
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

func (m *Manager) sweep() {
	defer close(m.sweepDone)
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			m.sweepOnce()
		case <-m.stopSweep:
			return
		}
	}
}

func (m *Manager) sweepOnce() {
	m.mu.Lock()
	candidates := make([]*Session, 0, len(m.sessions))
	for _, session := range m.sessions {
		candidates = append(candidates, session)
	}
	m.mu.Unlock()
	for _, session := range candidates {
		m.ReapFinished(session.ID(), session)
	}
}

// AcquireAttach returns the live logical session for opts.ID, or opens one on
// the Manager's shared multi-session provider. Socket attachments never own
// either the logical session or provider process lifetime.
func (m *Manager) AcquireAttach(ctx context.Context, opts SessionOptions, writer FrameWriter) (*Session, bool, func(), error) {
	if opts.ID == "" || opts.Binary == "" {
		return nil, false, nil, fmt.Errorf("chat: session id and binary are required")
	}
retry:
	m.mu.Lock()
	if existing := m.sessions[opts.ID]; existing != nil {
		m.mu.Unlock()
		existing.lifecycleMu.Lock()
		m.mu.Lock()
		if m.sessions[opts.ID] != existing {
			m.mu.Unlock()
			existing.lifecycleMu.Unlock()
			goto retry
		}
		if existing.isFinishedLocked() {
			existing.mu.Lock()
			existing.finishedAt = m.now()
			existing.mu.Unlock()
		}
		detach, replay := existing.attachLocked(writer)
		m.mu.Unlock()
		existing.lifecycleMu.Unlock()
		replay()
		return existing, false, detach, nil
	}
	if m.generations[opts.ID] != nil {
		done := m.generationDone[opts.ID]
		m.mu.Unlock()
		if done == nil {
			return nil, false, nil, fmt.Errorf("chat: session %s is retiring", opts.ID)
		}
		select {
		case <-done:
			goto retry
		case <-ctx.Done():
			return nil, false, nil, ctx.Err()
		}
	}
	if m.pending[opts.ID] {
		m.mu.Unlock()
		return nil, false, nil, fmt.Errorf("chat: session %s is already starting", opts.ID)
	}
	m.pending[opts.ID] = true
	provider := m.provider
	if provider == nil {
		var err error
		providerCtx := opts.ProviderContext
		if providerCtx == nil {
			providerCtx = ctx
		}
		provider, err = startSharedProvider(providerCtx, opts, m.providerExited)
		if err != nil {
			delete(m.pending, opts.ID)
			m.mu.Unlock()
			return nil, false, nil, err
		}
		m.provider = provider
	}
	m.mu.Unlock()

	var identityGate *identityGate
	if opts.OnResumeIdentity != nil {
		identityGate = newIdentityGate(opts.OnResumeIdentity)
		opts.OnResumeIdentity = identityGate.deliver
	}
	userOnExit := opts.OnExit
	exitGate := newExitGate(func(source *Session) {
		m.StopIfCurrent(source.ID(), source)
		if userOnExit != nil {
			userOnExit(source)
		}
	})
	providerName := opts.Provider
	if providerName == "" {
		providerName = DefaultProviderID()
	}
	s := &Session{
		id:                 opts.ID,
		frames:             newBroadcaster(),
		provider:           providerName,
		piSessionID:        opts.PiSessionID,
		onResumeIdentity:   opts.OnResumeIdentity,
		onProviderName:     opts.OnProviderName,
		onActivitySnapshot: opts.OnActivitySnapshot,
		onNoticePersist:    opts.OnNoticePersist,
		onExit:             exitGate.fire,
		lastStop:           "stop",
		owner:              m,
	}
	s.seedActivitySnapshots(opts.SeedActivity)
	s.seedNotices(opts.SeedNotices)
	s.startNoticePersistence()
	s.lifecycleMu.Lock()
	detach, replay := s.attachLocked(writer)
	s.lifecycleMu.Unlock()
	replay()
	openErr := m.openSessionWithRetry(ctx, provider, s, opts)
	if openErr != nil && opts.PiSessionID != "" {
		// A stale durable path must not brick the chat. Report the failed
		// resume and open a fresh cwd-backed logical session on the same
		// provider. The fallback session captures its identity in memory only:
		// persistence is suppressed for it, so the chat rebinds for this run
		// without overwriting the stored binding to the original session file.
		dangling := StoredIdentityDangling(opts.PiSessionID)
		var candidates []SessionBranchCandidate
		if dangling && opts.OnResumeFailure != nil {
			// Recovery lookup runs before the error frame is sent, with no
			// locks held; the callback must stay bounded.
			candidates = opts.OnResumeFailure(opts.PiSessionID)
		}
		m.logWarn("resume failed; opening fresh session", "session", opts.ID, "err", openErr)
		if dangling {
			m.logWarn("dangling stored path after resume failure", "session", opts.ID, "path", opts.PiSessionID, "err", openErr)
		}
		s.suppressIdentityPersistence()
		frame := &ErrorFrame{Type: "error", SessionID: s.id, Code: "resume_failed", Message: openErr.Error()}
		if dangling {
			// The doomed open was still sent; only now, after the provider has
			// rejected it, is the stored path flagged dangling on the wire. The
			// stored binding itself is never wiped or overwritten.
			frame.Dangling = true
			frame.StoredIdentity = opts.PiSessionID
			frame.BranchCandidates = candidates
		}
		s.send(frame)
		fresh := opts
		fresh.PiSessionID = ""
		openErr = provider.openSession(ctx, s, fresh)
	}
	if openErr != nil {
		detach()
		// The logical session never became manager-owned, so no later Close path
		// can drain its per-session persistence goroutine.
		s.stopNoticePersistence()
		m.mu.Lock()
		delete(m.pending, opts.ID)
		m.mu.Unlock()
		m.releaseProviderIfIdle()
		return nil, false, nil, openErr
	}

	if m.beforeOpenRegister != nil {
		m.beforeOpenRegister()
	}
	m.mu.Lock()
	delete(m.pending, opts.ID)
	// Registration and the provider's started -> closing transition linearize
	// under provider.mu while Manager.mu remains held. Closing still refuses
	// registration. If the provider answered successfully and then reached dead
	// before this point, return the terminal logical session without making the
	// dead route manager-visible; its route worker owns ordered termination.
	provider.mu.Lock()
	if m.provider != provider || provider.state != sharedProviderStarted {
		providerDead := provider.state == sharedProviderDead
		provider.mu.Unlock()
		m.mu.Unlock()
		if providerDead {
			exitGate.open()
			if identityGate != nil {
				if err := identityGate.open(); err != nil {
					return nil, false, nil, fmt.Errorf("chat: persist resumed identity: %w", err)
				}
			}
			return s, true, detach, nil
		}
		detach()
		s.prepareProviderExit()
		return nil, false, nil, errors.New("chat: provider process ended while opening session")
	}
	if existing := m.sessions[opts.ID]; existing != nil {
		provider.mu.Unlock()
		m.mu.Unlock()
		existing.lifecycleMu.Lock()
		m.mu.Lock()
		if m.sessions[opts.ID] != existing {
			m.mu.Unlock()
			existing.lifecycleMu.Unlock()
			_ = s.Close()
			return nil, false, nil, errors.New("chat: session changed while attaching")
		}
		detach, replay = existing.attachLocked(writer)
		m.mu.Unlock()
		existing.lifecycleMu.Unlock()
		replay()
		_ = s.Close()
		return existing, false, detach, nil
	}
	m.sessions[opts.ID] = s
	m.generations[opts.ID] = s
	m.generationDone[opts.ID] = make(chan struct{})
	provider.mu.Unlock()
	m.mu.Unlock()
	// Provider events can arrive before registration. Their asynchronous
	// persistence attempt deliberately remains dirty; registration immediately
	// wakes the worker so the durable log cannot be lost on restart.
	s.queueNoticePersistence()
	exitGate.open()
	if identityGate != nil {
		if err := identityGate.open(); err != nil {
			m.StopIfCurrent(opts.ID, s)
			return nil, false, nil, fmt.Errorf("chat: persist resumed identity: %w", err)
		}
	}
	return s, true, detach, nil
}

func (m *Manager) Acquire(ctx context.Context, opts SessionOptions) (*Session, bool, error) {
	s, started, _, err := m.AcquireAttach(ctx, opts, nil)
	if err != nil {
		return nil, false, err
	}
	return s, started, nil
}

func (m *Manager) Get(id string) *Session {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.sessions[id]
}

// PersistIfGeneration leases the authoritative generation before running
// persist without Manager.mu held. Retirement revokes new leases and waits for
// existing ones before allowing a replacement generation to register, so disk
// I/O cannot block unrelated manager operations or overwrite a replacement.
func (m *Manager) PersistIfGeneration(source *Session, persist func() bool) bool {
	if source == nil {
		return false
	}
	id := source.ID()
	m.mu.Lock()
	if m.generations[id] != source || m.generationRetiring[id] {
		m.mu.Unlock()
		return false
	}
	m.generationLeases[id]++
	m.mu.Unlock()

	defer func() {
		m.mu.Lock()
		m.generationLeases[id]--
		if m.generationLeases[id] == 0 && m.generationRetiring[id] && m.generations[id] == source {
			m.finishGenerationLocked(id, source)
		}
		m.mu.Unlock()
	}()
	return persist()
}

// finishGenerationLocked publishes the replacement boundary after every
// persistence lease for source has drained. The caller holds Manager.mu.
func (m *Manager) finishGenerationLocked(id string, source *Session) {
	if m.generations[id] != source {
		return
	}
	delete(m.generations, id)
	delete(m.generationLeases, id)
	delete(m.generationRetiring, id)
	if done := m.generationDone[id]; done != nil {
		close(done)
	}
	delete(m.generationDone, id)
}

func (m *Manager) LiveIDs() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	ids := make([]string, 0, len(m.sessions))
	for id, session := range m.sessions {
		if session.ProcessAlive() {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	return ids
}

// LiveSummary is one process-alive session as listed by GET /api/sessions/live:
// its id, display title, cached activity pair (nil payloads when absent), and
// in-memory per-side oversized flags for the latest replayable payloads.
type LiveSummary struct {
	ID            string
	Title         string
	Pair          ActivitySnapshotPair
	TaskOversized bool
	DagOversized  bool
}

// LiveSummaries returns process-alive sessions in ID order.
func (m *Manager) LiveSummaries() []LiveSummary {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]LiveSummary, 0, len(m.sessions))
	for id, session := range m.sessions {
		if session.ProcessAlive() {
			pair, taskOversized, dagOversized := session.activitySnapshotState()
			out = append(out, LiveSummary{
				ID:            id,
				Pair:          pair,
				TaskOversized: taskOversized,
				DagOversized:  dagOversized,
			})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

func (m *Manager) Stop(id string) {
	m.mu.Lock()
	s := m.sessions[id]
	delete(m.sessions, id)
	m.mu.Unlock()
	if s != nil {
		_ = s.Close()
	}
	m.releaseProviderIfIdle()
}

func (m *Manager) StopIfCurrent(id string, session *Session) bool {
	m.mu.Lock()
	if m.sessions[id] != session {
		m.mu.Unlock()
		return false
	}
	delete(m.sessions, id)
	m.mu.Unlock()
	_ = session.Close()
	m.releaseProviderIfIdle()
	return true
}

func (m *Manager) sessionClosed(session *Session) {
	id := session.ID()
	var generationDone chan struct{}
	m.mu.Lock()
	if m.sessions[id] == session {
		delete(m.sessions, id)
	}
	if m.generations[id] == session {
		generationDone = m.generationDone[id]
		if generationDone == nil {
			generationDone = make(chan struct{})
			m.generationDone[id] = generationDone
		}
		m.generationRetiring[id] = true
		if m.generationLeases[id] == 0 {
			m.finishGenerationLocked(id, session)
		}
	}
	m.mu.Unlock()
	if generationDone != nil {
		<-generationDone
	}
	m.releaseProviderIfIdle()
}

func (m *Manager) evictSession(session *Session) {
	m.mu.Lock()
	if m.sessions[session.ID()] == session {
		delete(m.sessions, session.ID())
	}
	m.mu.Unlock()
}

func (m *Manager) releaseProviderIfIdle() {
	m.mu.Lock()
	if len(m.sessions) != 0 || len(m.pending) != 0 || m.provider == nil {
		m.mu.Unlock()
		return
	}
	provider := m.provider
	remainingSessions := len(m.sessions)
	pending := len(m.pending)
	m.provider = nil
	m.mu.Unlock()
	m.logWarn("closing idle shared provider", "remaining_sessions", remainingSessions, "pending", pending)
	_ = provider.close()
}

func (m *Manager) providerExited(provider *sharedProvider, termination providerTermination) {
	m.mu.Lock()
	if m.provider != provider {
		m.mu.Unlock()
		return
	}
	// Publish the provider replacement point and evict every route atomically.
	// AcquireAttach can therefore see either the old provider with all of its
	// sessions, or a nil provider with none of them, never a dead route paired
	// with a freshly available provider slot.
	m.provider = nil
	routed := make(map[*Session]struct{}, len(termination.sessions))
	for _, session := range termination.sessions {
		routed[session] = struct{}{}
	}
	var unrouted []*Session
	for id, session := range m.sessions {
		session.mu.Lock()
		owned := session.shared == provider
		session.mu.Unlock()
		if owned {
			delete(m.sessions, id)
			if _, ok := routed[session]; !ok {
				unrouted = append(unrouted, session)
			}
		}
	}
	m.mu.Unlock()
	// Route workers own both the lifecycle transition and ordered terminal
	// delivery. In particular, do not acquire lifecycleMu on the shared pump:
	// a client writer may currently hold it while blocked in frame delivery.
	// A defensive fallback for an already-registered session whose provider
	// has no route (possible in tests and during partial setup): no route worker
	// exists to carry its final delivery.
	for _, session := range unrouted {
		session.prepareProviderExit()
		go session.providerExited(termination)
	}
}

// ReapFinished closes a session only while it is still registered and still
// finished. It is intended for explicit bounded cleanup points, not timers.
func (m *Manager) ReapFinished(id string, finished *Session) bool {
	if m.beforeReapLifecycle != nil {
		m.beforeReapLifecycle()
	}
	finished.lifecycleMu.Lock()
	m.mu.Lock()
	if m.sessions[id] != finished {
		m.mu.Unlock()
		finished.lifecycleMu.Unlock()
		return false
	}
	if !finished.idleFinishedLocked(m.idleFor, m.now()) {
		m.mu.Unlock()
		finished.lifecycleMu.Unlock()
		return false
	}
	delete(m.sessions, id)
	m.mu.Unlock()
	finished.lifecycleMu.Unlock()
	_ = finished.Close()
	m.releaseProviderIfIdle()
	return true
}

func (m *Manager) CloseAll() {
	m.closeOnce.Do(func() {
		// The stop handshake is deliberately lock-free. sweep may already be in
		// sweepOnce and need Manager.mu before it can return and close sweepDone.
		// Acquiring Manager.mu before this receive would deadlock shutdown.
		close(m.stopSweep)
		<-m.sweepDone
		if m.afterSweepStopped != nil {
			m.afterSweepStopped()
		}

		m.mu.Lock()
		sessions := make([]*Session, 0, len(m.sessions))
		for _, session := range m.sessions {
			sessions = append(sessions, session)
		}
		m.sessions = make(map[string]*Session)
		provider := m.provider
		m.provider = nil
		m.mu.Unlock()
		var wg sync.WaitGroup
		wg.Add(len(sessions))
		for _, session := range sessions {
			go func() {
				defer wg.Done()
				_ = session.Close()
			}()
		}
		closed := make(chan struct{})
		go func() {
			wg.Wait()
			close(closed)
		}()
		timer := time.NewTimer(closeSessionTimeout)
		defer timer.Stop()
		select {
		case <-closed:
		case <-timer.C:
			// One aggregate deadline covers every logical close. Terminating
			// the shared process releases any Send holding Process.writeMu.
			if provider != nil {
				_ = provider.close()
				provider = nil
			}
			<-closed
		}
		if provider != nil {
			_ = provider.close()
		}
	})
}
