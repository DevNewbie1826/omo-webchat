package chat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

var ErrPromptInFlight = errors.New("chat: prompt already in flight")

// ErrCompactionInFlight reports a request refused because a compaction owns
// the session: prompts and further compacts must wait for compaction_end (or
// the compact RPC response) to release it.
var ErrCompactionInFlight = errors.New("chat: compaction already in flight")

type FrameWriter interface {
	WriteJSON([]byte) error
}

type ResumeIdentity struct {
	Provider string
	Value    string
}

// ResumeIdentityCallback receives the source session so the caller can decide
// currency from the argument. Capturing a session pointer in a closure races:
// the provider can report its identity before Start has assigned it.
type ResumeIdentityCallback func(source *Session, identity ResumeIdentity) error

// ExitCallback runs once when the provider process ends on its own.
type ExitCallback func(*Session)

type SessionOptions struct {
	// ProviderContext owns the shared process lifetime when this acquire starts
	// it. The AcquireAttach context bounds only this logical session's open.
	// It is required when a new shared provider must be started.
	ProviderContext context.Context
	ID              string
	Cwd             string
	Binary          string
	Args            []string
	Env             []string
	Provider        string
	PiSessionID     string
	// StderrPath is the provider-stderr capture file for a provider started
	// by this acquire (shared provider). The state directory is resolved at
	// the API layer — the chat package cannot import internal/store — and an
	// empty value leaves provider stderr unwired.
	StderrPath string
	// SeedActivity pre-loads the replayable activity cache from the chat
	// record's persisted snapshot. Used only at session creation: a session
	// restored from disk replays the persisted pair to its first client until
	// live provider snapshots supersede it. nil seeds nothing.
	SeedActivity *ActivitySnapshotPair
	// OnActivitySnapshot receives the latest replayable pair when a run
	// settles with changed activity (the persistence write boundary). It
	// reports whether the store write succeeded: the deduplication marker
	// advances only on success, so a transient failure is retried on the
	// next settle carrying the same pair. Called with no session locks held;
	// implementations must not block the session.
	OnActivitySnapshot func(session *Session, pair ActivitySnapshotPair) bool
	// SeedNotices pre-loads the durable notice log from the chat record's
	// persisted notice list. Used only at session creation: a session
	// restored from disk replays the persisted notices to its first client
	// (after the activity snapshot frames) until new live notices append.
	// nil seeds nothing.
	SeedNotices []NoticeRecord
	// OnNoticePersist receives the durable notice log whenever a durable
	// notice arrives with a log changed since the last successful write (the
	// persistence write boundary is the durable notice itself, not run
	// settle: high_reasoning_warning fires with no run). It reports whether
	// the store write succeeded: the deduplication marker advances only on
	// success, so a transient failure is retried by the next durable notice.
	// Called with no session locks held; implementations must not block the
	// session, and a failed write never breaks forwarding.
	OnNoticePersist  func(session *Session, notices []NoticeRecord) bool
	OnResumeIdentity ResumeIdentityCallback
	// OnResumeFailure optionally recovers branch-session candidates for a
	// chat whose stored session path is dangling (the file is gone). It is
	// invoked on the permanent-resume-failure branch, before the
	// resume_failed error frame is sent, with no locks held; implementations
	// must stay bounded. nil skips the lookup.
	OnResumeFailure func(storedIdentity string) []SessionBranchCandidate
	OnProviderName  func(session *Session, name string)
	OnExit          ExitCallback
}

// StoredIdentityDangling reports whether a stored resume identity is an
// absolute session-file path whose file no longer exists. Empty identities
// and non-path ids (plain provider session ids) are never dangling: only a
// path can go missing.
func StoredIdentityDangling(identity string) bool {
	identity = strings.TrimSpace(identity)
	if identity == "" || !filepath.IsAbs(identity) {
		return false
	}
	_, err := os.Stat(identity)
	return os.IsNotExist(err)
}

type Session struct {
	id               string
	proc             *Process
	shared           *sharedProvider
	routingHandle    string
	owner            *Manager
	frames           *broadcaster
	procCtx          context.Context
	cancel           context.CancelFunc
	mu               sync.Mutex
	lifecycleMu      sync.Mutex
	provider         string
	piSessionID      string
	onResumeIdentity ResumeIdentityCallback
	// identityPersistSuppressed latches a fallback session opened after a
	// failed resume: identity captures keep updating the in-memory identity
	// but never reach the persistence callback, so the fallback can never
	// overwrite the stored binding to the original session file. Guarded by mu.
	identityPersistSuppressed bool
	onProviderName            func(session *Session, name string)
	onExit                    ExitCallback
	lastStop                  string
	runDone                   bool
	finishedAt                time.Time
	promptInFlight            bool
	promptSequence            uint64
	// lastActivitySnapshots caches the latest payload of the replayable
	// activity events (activitySnapshotOrder) so a client attaching after a
	// turn still sees the current task/DAG state. Guarded by mu. It is seeded
	// from the chat record's persisted snapshot at creation and superseded
	// name-by-name by live provider snapshots.
	lastActivitySnapshots map[string]json.RawMessage
	// taskOversized / dagOversized are in-memory only: a live replayable
	// payload over the cache cap sets that side; a later in-cap payload
	// clears it. Never persisted. Guarded by mu.
	taskOversized bool
	dagOversized  bool
	// taskDigest / dagDigest are compact in-memory count summaries extracted
	// from every recognized activity event, including over-cap payloads the
	// replay cache drops. Never persisted. Guarded by mu.
	taskDigest *ActivityTaskDigest
	dagDigest  *ActivityDagDigest
	// onActivitySnapshot persists the replayable pair at run completion.
	// Guarded by mu alongside activityPersisted, the pair last written
	// successfully: an unchanged pair is never re-persisted, and a failed
	// write leaves the marker in place so the next settle retries.
	onActivitySnapshot  func(session *Session, pair ActivitySnapshotPair) bool
	activityPersisted   ActivitySnapshotPair
	activityPersistence sync.WaitGroup
	// durableNotices is the bounded replayable log of durable advisory
	// notices (durableNoticeKinds), oldest first, dropped from the front at
	// maxDurableNotices. It is seeded from the chat record's persisted
	// notices at creation, appended by forwardNotice under the delivery
	// barrier, and replayed to every later attach — a second attach receives
	// it again, because the log is session state, not a consumed replay.
	// Guarded by mu.
	durableNotices     []NoticeRecord
	noticeNamespace    string
	nextNoticeSequence uint64
	// noticesPersisted mirrors the log as last successfully persisted. A log
	// equal to the marker is never written again; a failed write leaves the
	// marker in place so the next durable notice retries. Guarded by mu.
	noticesPersisted []NoticeRecord
	// onNoticePersist persists the durable log on the session-owned worker.
	onNoticePersist      func(session *Session, notices []NoticeRecord) bool
	noticePersistenceMu  sync.Mutex
	noticePersistWork    chan struct{}
	noticePersistPending []noticePersistenceRequest
	noticePersistDone    chan struct{}
	// providerRunActive latches a provider-initiated run (omo wake/triggerTurn)
	// that no client prompt armed: agent_start sets it (emitting run.started)
	// and agent_settled clears it (emitting run.done). An explicit latch — not
	// !runDone — because runDone's zero value would break fresh sessions.
	providerRunActive bool
	// localCommandActive marks an in-flight prompt consumed by an omo
	// extension-local command: it completes on the correlated prompt response
	// instead of agent_settled, because no agent run follows it.
	localCommandActive bool
	// compactionActive latches a live compaction: set by Compact before its
	// provider write (manual) and by compaction_start (automatic). The RPC id
	// correlates a manual response; the provider requestId independently pairs
	// compaction_start/end. Completed provider ids reject delayed duplicates.
	// While latched, prompts, further compacts, and idle reaping stay blocked.
	compactionActive            bool
	compactRPCID                string
	pendingCompactRPCs          map[string]struct{}
	handledCompactRPCResponses  map[string]struct{}
	compactionRequestID         string
	completedCompactionRequests map[string]struct{}
	nextCompactRPCSequence      uint64
	resumePending               bool
	done                        bool
	providerExitPending         bool
	pumpDone                    chan struct{}
	closeOnce                   sync.Once
	closeErr                    error
	// barrier serializes provider-frame delivery against control acks. The
	// pump holds it while writing a provider frame; sendControl holds it from
	// before the provider write until after the acceptance ack is written, so
	// the ack always precedes every frame the command can cause.
	barrier sync.Mutex
}

func StartSession(ctx context.Context, opts SessionOptions) (*Session, error) {
	if opts.ID == "" || opts.Binary == "" {
		return nil, fmt.Errorf("chat: session id and binary are required")
	}
	procCtx, cancel := context.WithCancel(ctx)
	// The single capability seam: every provider process is told this backend
	// accepts extension events (see EnsureExtensionEventsCapability).
	proc, err := Start(procCtx, ProcessOptions{
		Binary: opts.Binary,
		Args:   opts.Args,
		Cwd:    opts.Cwd,
		Env:    EnsureExtensionEventsCapability(opts.Env),
	})
	if err != nil {
		cancel()
		return nil, err
	}
	provider := opts.Provider
	if provider == "" {
		provider = DefaultProviderID()
	}
	s := &Session{
		id:                 opts.ID,
		proc:               proc,
		frames:             newBroadcaster(),
		procCtx:            procCtx,
		cancel:             cancel,
		provider:           provider,
		piSessionID:        opts.PiSessionID,
		onResumeIdentity:   opts.OnResumeIdentity,
		onProviderName:     opts.OnProviderName,
		onActivitySnapshot: opts.OnActivitySnapshot,
		onNoticePersist:    opts.OnNoticePersist,
		onExit:             opts.OnExit,
		lastStop:           "stop",
		pumpDone:           make(chan struct{}),
	}
	s.seedActivitySnapshots(opts.SeedActivity)
	s.seedNotices(opts.SeedNotices)
	s.startNoticePersistence()
	go s.pump()
	return s, nil
}

func (s *Session) ID() string { return s.id }

func (s *Session) PiSessionID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.piSessionID
}

// suppressIdentityPersistence latches the fallback-session flag honored by
// capturePiSessionID: later captures update memory only and never invoke the
// persistence callback.
func (s *Session) suppressIdentityPersistence() {
	s.mu.Lock()
	s.identityPersistSuppressed = true
	s.mu.Unlock()
}

// pump forwards provider events until stdout closes. The leader is reaped
// independently of stdout, so the pipe closes as soon as the group dies even
// when a descendant outlived the leader. Intentional teardown (Session.Close)
// and parent context cancellation stay quiet; only a provider that died on its
// own surfaces an error frame and runs the eviction hook, so the manager drops
// exactly this session once.
func (s *Session) pump() {
	defer close(s.pumpDone)
	events := make(chan Event, 64)
	go s.proc.Events(events)
	decodeFailed := false
	for ev := range events {
		if ev.Type == "decode_error" {
			decodeFailed = true
		}
		s.dispatch(ev)
	}
	_ = s.proc.CloseAfterEOF()
	if s.isDone() || s.parentCancelled() {
		return
	}
	// A decode failure already surfaced a specific decode_failed frame; don't
	// overwrite it with the generic pi_eof. The eviction hook runs either way.
	if !decodeFailed {
		s.send(&ErrorFrame{Type: "error", SessionID: s.id, Code: "pi_eof", Message: "Omo process ended (" + s.proc.ExitSummary() + ")"})
	}
	if s.onExit != nil {
		s.onExit(s)
	}
}

func (s *Session) isDone() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.done
}

func (s *Session) isFinishedLocked() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return !s.done && s.runDone && !s.promptInFlight && !s.providerRunActive && !s.compactionActive
}

func (s *Session) ProcessAlive() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return !s.done && (s.shared == nil || s.routingHandle != "")
}

func (s *Session) IsFinished() bool {
	s.lifecycleMu.Lock()
	defer s.lifecycleMu.Unlock()
	return s.isFinishedLocked()
}

func (s *Session) IdleFinished(idle time.Duration, now time.Time) bool {
	s.lifecycleMu.Lock()
	defer s.lifecycleMu.Unlock()
	return s.idleFinishedLocked(idle, now)
}

func (s *Session) idleFinishedLocked(idle time.Duration, now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return !s.done && s.runDone && !s.promptInFlight && !s.providerRunActive && !s.compactionActive && !s.finishedAt.IsZero() && now.Sub(s.finishedAt) >= idle && s.attachmentCountLocked() == 0
}

// parentCancelled reports whether the session's context was cancelled from
// above (server teardown). Process.Close cancels only the child context, so
// this never reflects an intentional Session.Close or the pump's own reap.
func (s *Session) parentCancelled() bool {
	return s.procCtx.Err() != nil
}

func (s *Session) send(frame any) {
	b, err := json.Marshal(frame)
	if err != nil {
		return
	}
	s.barrier.Lock()
	defer s.barrier.Unlock()
	s.writeFrame(b)
}

// sendControl writes cmd to the provider and then the pre-marshaled ack to the
// client while holding the delivery barrier. Provider frames queue behind the
// barrier, so the ack is guaranteed to reach the client before any frame the
// command produces.
func (s *Session) sendControl(cmd map[string]any, ack []byte) error {
	s.barrier.Lock()
	defer s.barrier.Unlock()
	if err := s.sendProvider(cmd); err != nil {
		return err
	}
	if len(ack) > 0 {
		s.writeFrame(ack)
	}
	return nil
}

// Close kills the provider and reaps it. No abort is written first: a
// provider that stopped reading stdin would block shutdown on that write,
// and the process is about to die anyway.
func (s *Session) Close() error {
	s.closeOnce.Do(func() {
		// Latch the terminal state under the session lock order, then release all
		// locks before provider I/O or the Manager callback. closeSession waits on
		// provider channels; sessionClosed takes Manager.mu.
		s.lifecycleMu.Lock()
		s.mu.Lock()
		alreadyDone := s.done
		s.done = true
		shared := s.shared
		owner := s.owner
		proc := s.proc
		s.mu.Unlock()
		s.lifecycleMu.Unlock()

		if !alreadyDone {
			if shared != nil {
				// Snapshot the route before closeSession detaches it. Closing its
				// queue is not itself a drain: wait for the route worker to finish
				// every already-queued provider event before stopping persistence.
				s.mu.Lock()
				handle := s.routingHandle
				s.mu.Unlock()
				shared.mu.Lock()
				route := shared.sessions[handle]
				if route != nil && route.session != s {
					route = nil
				}
				shared.mu.Unlock()
				s.closeErr = shared.closeSession(s)
				if route != nil {
					route.init()
					<-route.stopped
				}
			} else if proc != nil {
				s.closeErr = proc.Close()
			}
		}
		// Every persistence attempt registers under lifecycleMu before its
		// run.done frame is published. Once done is latched above, no later
		// attempt can register, so waiting here makes Close the deterministic
		// boundary after which no store write can remain in flight.
		s.stopNoticePersistence()
		s.activityPersistence.Wait()
		if owner != nil {
			owner.sessionClosed(s)
		}
	})
	return s.closeErr
}

func (s *Session) sendProvider(cmd map[string]any) error {
	s.mu.Lock()
	shared := s.shared
	proc := s.proc
	s.mu.Unlock()
	if shared != nil {
		return shared.send(s, cmd)
	}
	if proc == nil {
		return errors.New("chat: session has no provider")
	}
	return proc.Send(cmd)
}

// prepareProviderExit commits the lifecycle transition without performing any
// client I/O. Manager/provider teardown can therefore evict a session even if
// its attached writer is permanently blocked. The route worker later consumes
// providerExitPending when it reaches the terminal item in stdout order.
func (s *Session) prepareProviderExit() bool {
	s.lifecycleMu.Lock()
	defer s.lifecycleMu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.done {
		return s.providerExitPending
	}
	s.done = true
	s.providerExitPending = true
	s.routingHandle = ""
	s.promptInFlight = false
	s.providerRunActive = false
	s.compactionActive = false
	s.runDone = true
	s.finishedAt = time.Now()
	return true
}

func (s *Session) providerExited(termination providerTermination) {
	s.prepareProviderExit()

	s.lifecycleMu.Lock()
	s.mu.Lock()
	if !s.providerExitPending {
		s.mu.Unlock()
		s.lifecycleMu.Unlock()
		return
	}
	s.providerExitPending = false
	callback := s.onExit
	owner := s.owner
	s.mu.Unlock()
	s.lifecycleMu.Unlock()

	// The terminal route item follows every queued provider event, so no later
	// durable append can register. Drain and stop the worker while this session's
	// manager generation is still authoritative, then revoke it before a
	// replacement can register.
	s.stopNoticePersistence()
	s.activityPersistence.Wait()
	if owner != nil {
		owner.sessionClosed(s)
	}

	switch termination.kind {
	case providerTerminationDecodeFailed:
		s.send(&ErrorFrame{Type: "error", SessionID: s.id, Code: "decode_failed", Message: termination.message})
	case providerTerminationQueueOverflow:
		s.send(&ErrorFrame{Type: "error", SessionID: s.id, Code: "provider_overflow", Message: termination.summary})
	case providerTerminationDeliveryTimeout:
		s.send(&ErrorFrame{Type: "error", SessionID: s.id, Code: "provider_timeout", Message: termination.summary})
	case providerTerminationIdleEviction:
		s.send(&ErrorFrame{Type: "error", SessionID: s.id, Code: "session_unloaded", Message: "Idle session was unloaded by Omo"})
	case providerTerminationUnexpected:
		s.send(&ErrorFrame{Type: "error", SessionID: s.id, Code: "pi_eof", Message: "Omo process ended (" + termination.summary + ")"})
	}
	if callback != nil && termination.kind != providerTerminationIntentional {
		callback(s)
	}
}
