package chat

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type sharedProviderState uint8

const (
	sharedProviderUnstarted sharedProviderState = iota
	sharedProviderStarted
	sharedProviderClosing
	sharedProviderDead
)

type providerTerminationKind uint8

const (
	providerTerminationUnexpected providerTerminationKind = iota
	providerTerminationDecodeFailed
	providerTerminationIntentional
	providerTerminationQueueOverflow
	providerTerminationDeliveryTimeout
)

type providerTermination struct {
	kind     providerTerminationKind
	summary  string
	message  string
	sessions []*Session
}

// sharedProvider owns the one multi-session RPC process used by a Manager.
// Session values retain all chat-local state; this type only correlates control
// requests and demultiplexes tagged provider records.
type sharedProvider struct {
	proc *Process

	mu          sync.Mutex
	sessions    map[string]*sessionRoute
	pending     map[string]pendingProviderRequest
	requests    map[string]*sessionRoute
	state       sharedProviderState
	exitSummary string
	done        chan struct{}

	nextID         atomic.Uint64
	closeDeadline  func() <-chan time.Time
	afterCloseSend func()
	onExit         func(*sharedProvider, providerTermination)
	// afterOpenDeath fires once openSession has committed to the
	// provider-death arm and is about to wait for the final state of its
	// response channel. Only tests set it; production leaves it nil.
	afterOpenDeath func()

	closeOnce    sync.Once
	closeProcess func() error
	closeErr     error
}

func startSharedProvider(ctx context.Context, opts SessionOptions, onExit func(*sharedProvider, providerTermination)) (*sharedProvider, error) {
	args := append([]string(nil), opts.Args...)
	if !containsArg(args, "--multi-session") {
		args = append(args, "--multi-session")
	}
	proc, err := Start(ctx, ProcessOptions{
		Binary: opts.Binary,
		Args:   args,
		Env:    EnsureExtensionEventsCapability(opts.Env),
	})
	if err != nil {
		return nil, err
	}
	p := &sharedProvider{
		proc:          proc,
		state:         sharedProviderStarted,
		sessions:      make(map[string]*sessionRoute),
		pending:       make(map[string]pendingProviderRequest),
		requests:      make(map[string]*sessionRoute),
		done:          make(chan struct{}),
		closeDeadline: func() <-chan time.Time { return time.After(closeSessionTimeout) },
		closeProcess:  proc.Close,
		onExit:        onExit,
	}
	go p.pump()
	return p, nil
}

func containsArg(args []string, want string) bool {
	for _, arg := range args {
		if arg == want {
			return true
		}
	}
	return false
}

func (p *sharedProvider) pump() {
	events := make(chan Event, 64)
	go p.proc.Events(events)
	var decodeMessage string
	for ev := range events {
		if ev.Type == "decode_error" {
			decodeMessage = rawString(ev.Raw)
			continue
		}
		p.route(ev)
	}
	_ = p.proc.CloseAfterEOF()
	summary := p.proc.ExitSummary()

	p.mu.Lock()
	if p.state == sharedProviderDead {
		p.mu.Unlock()
		return
	}
	closing := p.state == sharedProviderClosing
	p.state = sharedProviderDead
	p.exitSummary = summary
	close(p.done)
	pending := p.pending
	p.pending = make(map[string]pendingProviderRequest)
	routes := make([]*sessionRoute, 0, len(p.sessions))
	for handle, route := range p.sessions {
		delete(p.sessions, handle)
		routes = append(routes, route)
	}
	p.requests = make(map[string]*sessionRoute)
	p.mu.Unlock()
	for _, request := range pending {
		close(request.response)
	}

	termination := providerTermination{kind: providerTerminationUnexpected, summary: summary}
	if decodeMessage != "" {
		termination.kind = providerTerminationDecodeFailed
		termination.message = decodeMessage
	} else if closing || strings.Contains(summary, "cancelled by parent") {
		termination.kind = providerTerminationIntentional
	}
	// Publish provider death and evict registered/opening sessions before any
	// client delivery. A blocked writer can then delay only its own terminal
	// frame, never manager replacement or sibling teardown.
	if p.onExit != nil {
		termination.sessions = make([]*Session, 0, len(routes))
		for _, route := range routes {
			termination.sessions = append(termination.sessions, route.session)
		}
		p.onExit(p, termination)
	}
	// Each worker receives termination as its final queue item. Workers are
	// independent so one blocked client cannot prevent another route ending,
	// and all already-queued provider frames precede the terminal frame.
	for _, route := range routes {
		go route.terminate(termination)
	}
}

func (p *sharedProvider) route(ev Event) bool {
	var envelope struct {
		ID        string `json:"id"`
		SessionID string `json:"sessionId"`
	}
	if len(ev.Raw) > 0 {
		_ = json.Unmarshal(ev.Raw, &envelope)
	}
	if envelope.ID == "" {
		envelope.ID = ev.RequestID
	}
	if envelope.SessionID == "" {
		envelope.SessionID = ev.SessionID
	}

	p.mu.Lock()
	if request, ok := p.pending[envelope.ID]; ok {
		delete(p.pending, envelope.ID)
		if request.open {
			p.installOpenRouteLocked(request.session, ev)
		}
		p.mu.Unlock()
		request.response <- ev
		return true
	}
	route := p.sessions[envelope.SessionID]
	if route == nil && envelope.ID != "" {
		route = p.requests[envelope.ID]
	}
	if ev.Final && envelope.ID != "" {
		delete(p.requests, envelope.ID)
	}
	if route == nil {
		p.mu.Unlock()
		return false
	}
	delivery := sessionDelivery{event: &ev}
	select {
	case route.queue <- delivery:
		p.mu.Unlock()
		return true
	default:
		p.mu.Unlock()
		p.teardownRoute(route, providerTermination{kind: providerTerminationQueueOverflow, summary: "session delivery queue overflow"})
		return true
	}
}

func (p *sharedProvider) close() error {
	p.closeOnce.Do(func() {
		p.mu.Lock()
		switch p.state {
		case sharedProviderUnstarted:
			// Start returned an error before a Process existed. Production never
			// publishes this state, but closing it is intentionally a no-op.
			p.mu.Unlock()
			return
		case sharedProviderDead:
			p.mu.Unlock()
			<-p.done
			return
		case sharedProviderStarted:
			p.state = sharedProviderClosing
		}
		closeProcess := p.closeProcess
		if closeProcess == nil {
			// A started provider without a close function is a malformed,
			// partially constructed value. It cannot own process shutdown.
			p.state = sharedProviderUnstarted
			p.closeErr = errors.New("chat: provider process was not fully constructed")
			p.mu.Unlock()
			return
		}
		p.mu.Unlock()

		// closeProcess is installed only after Start has returned a fully
		// initialized Process and before the provider enters started state or is
		// published to Manager. A nil Process.cancel is therefore not reachable
		// from this call and needs no defensive guard in Process.cancelWith.
		p.closeErr = closeProcess()
		<-p.done
	})
	return p.closeErr
}
