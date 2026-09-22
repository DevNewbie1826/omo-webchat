package session

import (
	"context"
	"sync"
)

type errorDeliverer interface{ DeliverFrame(Frame) error }
type deliveryInterrupter interface{ CancelDelivery() error }
type overflowRecoverer interface{ RecoverSubscriberOverflow() }
type overflowTransferSubscriber interface{ SubscriberOverflowTransferKey() string }

const SubscriberOverflowTransferCapacity = 256

type queuedFrame struct {
	frame       Frame
	replayedIDs []string
	delivered   chan struct{}
	barrier     bool
}

// pendingLiveFrame carries one live frame retained behind a replay gate,
// with the message-occurrence sequence the session assigned when the frame
// was published (FrameMessage only; every other kind keeps zero).
type pendingLiveFrame struct {
	frame  Frame
	msgSeq uint64
}

// replayDedupDecider reports, in append order, the durable entry ids whose
// recent live append carried the same canonical message payload as the
// frame data and whose append observation did not precede the frame's
// publication sequence. The drain fails open on an empty result.
type replayDedupDecider func(data any, msgSeq uint64) (entryIDs []string, matched bool)

type subscription struct {
	sub              Subscriber
	q                chan queuedFrame
	stopCh           chan struct{}
	exited           chan struct{}
	initialDone      chan struct{}
	initialRemaining int
	initialOnce      sync.Once
	stopOnce         sync.Once
	cleanupOnce      sync.Once
	stopReason       error
	retire           func(error)
	cleanupDone      chan struct{}
	failedFrame      *Frame

	replayMu        sync.Mutex
	replaying       bool
	pendingLive     []pendingLiveFrame
	replayDrain     []pendingLiveFrame
	replayedEntries map[string]struct{}
	replayDedup     replayDedupDecider
	msgSeqSource    func() uint64
}

type overflowTransfer struct {
	frames     []Frame
	suffix     []Frame
	reserved   int
	finalized  bool
	overflowed bool
}

func (t *overflowTransfer) append(f Frame) {
	size := len(t.frames)
	if !t.finalized {
		size = t.reserved + len(t.suffix)
	}
	if t.overflowed || size >= SubscriberOverflowTransferCapacity {
		t.overflowed = true
		return
	}
	if t.finalized {
		t.frames = append(t.frames, f)
		return
	}
	t.suffix = append(t.suffix, f)
}

func (t *overflowTransfer) finalize(prefix []Frame) {
	if t.finalized {
		return
	}
	if len(prefix)+len(t.suffix) > SubscriberOverflowTransferCapacity {
		t.overflowed = true
		t.suffix = nil
		t.reserved = 0
		t.finalized = true
		return
	}
	t.frames = append(prefix, t.suffix...)
	t.suffix = nil
	t.reserved = 0
	t.finalized = true
}

func (x *subscription) start() { go x.run() }

func (x *subscription) run() {
	var retireReason error
	defer func() {
		x.endReplay()
		x.initialOnce.Do(func() { close(x.initialDone) })
		close(x.exited)
		if retireReason != nil {
			x.retire(retireReason)
		}
	}()
	for {
		select {
		case <-x.stopCh:
			return
		default:
		}
		select {
		case <-x.stopCh:
			return
		case item := <-x.q:
			if !item.barrier {
				if !x.deliver(item.frame) {
					failed := item.frame
					x.failedFrame = &failed
					retireReason = ErrSubscriberDelivery
					return
				}
				// History pages record their entry ids in the delivery path: after
				// the page frame was successfully delivered and strictly before
				// the terminal item's finishReplay drain can consult them (this
				// loop is the only drainer). A page admission that failed upstream
				// never queues, so it leaves no ids behind.
				if len(item.replayedIDs) > 0 {
					x.noteReplayedEntryIDs(item.replayedIDs)
				}
				if x.initialRemaining > 0 {
					x.initialRemaining--
					if x.initialRemaining == 0 {
						x.initialOnce.Do(func() { close(x.initialDone) })
					}
				}
			}
			if item.delivered != nil {
				if !x.finishReplay() {
					retireReason = ErrSubscriberDelivery
					return
				}
				close(item.delivered)
			}
		}
	}
}

func (x *subscription) deliver(f Frame) bool {
	// Detach wins over a queued frame even when both cases became ready.
	select {
	case <-x.stopCh:
		return false
	default:
	}
	if d, ok := x.sub.(errorDeliverer); ok {
		if err := d.DeliverFrame(f); err != nil {
			return false
		}
	} else {
		x.sub.Deliver(f)
	}
	return true
}

func (x *subscription) beginReplay() {
	x.replayMu.Lock()
	if !x.replaying {
		x.replaying = true
		// The replayed-entry set is per replay: ids a previous replay
		// delivered must not suppress frames drained after this one begins.
		x.replayedEntries = nil
		if replay, ok := x.sub.(ReplayBackpressureSubscriber); ok {
			replay.BeginReplay()
		}
	}
	x.replayMu.Unlock()
}

func (x *subscription) finishReplay() bool {
	for {
		x.replayMu.Lock()
		if !x.replaying {
			x.replayMu.Unlock()
			return true
		}
		if len(x.replayDrain) == 0 {
			if len(x.pendingLive) == 0 {
				x.replaying = false
				if replay, ok := x.sub.(ReplayBackpressureSubscriber); ok {
					replay.EndReplay()
				}
				x.replayMu.Unlock()
				return true
			}
			x.replayDrain = x.pendingLive
			x.pendingLive = nil
		}
		frame := x.replayDrain[0]
		dedup := x.replayDedup
		x.replayMu.Unlock()

		// A message completing inside the replay window is both an entries-page
		// entry and a pendingLive frame (observed engine order: message_end,
		// persistence, entry_appended). The page already delivered it, so the
		// drained duplicate is dropped. Suppression is occurrence-bound and
		// fails open: the frame must correlate to an entry whose append this
		// session observed at or after the frame's publication sequence, and
		// each replayed entry id consumes itself suppressing exactly one frame,
		// so an identical-payload frame whose own entry was never replayed
		// always delivers. Every other frame kind delivers, as does an
		// unmatched message (no entry_appended, mutated payload, or an append
		// older than the frame), preserving pre-dedup behavior.
		if frame.frame.Kind == FrameMessage && dedup != nil && x.frameReplaysDeliveredEntry(frame, dedup) {
			// dropped: the replayed entry already carried this message
		} else if !x.deliver(frame.frame) {
			return false
		}
		x.replayMu.Lock()
		x.replayDrain = x.replayDrain[1:]
		x.replayMu.Unlock()
	}
}

// frameReplaysDeliveredEntry resolves the frame's message to the entry ids
// that can own its occurrence and reports whether this replay's pages
// already delivered one of them, consuming that id: one replayed entry
// occurrence can never suppress a second frame. The dedup call must stay
// outside replayMu: the session decider takes the lifecycle lock, and
// replayMu -> lifecycleMu is never nested.
func (x *subscription) frameReplaysDeliveredEntry(pending pendingLiveFrame, dedup replayDedupDecider) bool {
	if pending.msgSeq == 0 {
		// An occurrence retained before its sequence source was installed
		// cannot be attributed, so it always delivers (fail open).
		return false
	}
	entryIDs, matched := dedup(pending.frame.Data, pending.msgSeq)
	if !matched || len(entryIDs) == 0 {
		return false
	}
	x.replayMu.Lock()
	defer x.replayMu.Unlock()
	for _, id := range entryIDs {
		if _, replayed := x.replayedEntries[id]; replayed {
			delete(x.replayedEntries, id)
			return true
		}
	}
	return false
}

// setReplayDedup installs the session-supplied decider consulted by the
// pendingLive drain. Callers install it before the replay gate opens.
func (x *subscription) setReplayDedup(decider replayDedupDecider) {
	x.replayMu.Lock()
	x.replayDedup = decider
	x.replayMu.Unlock()
}

// setMessageSeqSource installs the session's message-occurrence sequence
// reader consulted when a live FrameMessage is retained in pendingLive, so
// the drain can tell occurrences of an identical payload apart. The read is
// an atomic load, safe under replayMu. Callers install it before the replay
// gate opens.
func (x *subscription) setMessageSeqSource(source func() uint64) {
	x.replayMu.Lock()
	x.msgSeqSource = source
	x.replayMu.Unlock()
}

// noteReplayedEntryIDs records the entry ids a replay page delivered to this
// subscriber; ids never replayed cannot suppress any drained frame. Called
// on the pump goroutine from the delivery path.
func (x *subscription) noteReplayedEntryIDs(ids []string) {
	x.replayMu.Lock()
	if !x.replaying {
		x.replayMu.Unlock()
		return
	}
	if x.replayedEntries == nil {
		x.replayedEntries = make(map[string]struct{}, len(ids))
	}
	for _, id := range ids {
		if id != "" {
			x.replayedEntries[id] = struct{}{}
		}
	}
	x.replayMu.Unlock()
}

func (x *subscription) endReplay() {
	x.replayMu.Lock()
	if x.replaying {
		x.replaying = false
		x.pendingLive = nil
		if replay, ok := x.sub.(ReplayBackpressureSubscriber); ok {
			replay.EndReplay()
		}
	}
	x.replayMu.Unlock()
}

func (x *subscription) drainReplayTail() []Frame {
	x.replayMu.Lock()
	defer x.replayMu.Unlock()
	frames := make([]Frame, 0, len(x.replayDrain))
	for _, pending := range x.replayDrain {
		frames = append(frames, pending.frame)
	}
	x.replayDrain = nil
	return frames
}

func (x *subscription) beginOverflowTransfer(f Frame) ([]Frame, bool) {
	x.replayMu.Lock()
	defer x.replayMu.Unlock()
	if !x.replaying {
		return nil, false
	}
	frames := make([]Frame, 0, len(x.pendingLive)+1)
	for _, pending := range x.pendingLive {
		frames = append(frames, pending.frame)
	}
	frames = append(frames, f)
	x.pendingLive = nil
	return frames, true
}

func (x *subscription) drainOverflowQueue() []Frame {
	frames := make([]Frame, 0, len(x.q)+1)
	if x.failedFrame != nil {
		frames = append(frames, *x.failedFrame)
	}
	for {
		select {
		case item := <-x.q:
			if !item.barrier {
				frames = append(frames, item.frame)
			}
		default:
			return frames
		}
	}
}

func (x *subscription) stop(cancel bool) {
	x.stopWithReason(ErrSubscriberDetached, cancel)
}

func (x *subscription) stopWithReason(reason error, cancel bool) {
	x.stopOnce.Do(func() {
		x.stopReason = reason
		close(x.stopCh)
		x.endReplay()
		if cancel {
			_ = x.sub.Cancel()
		}
	})
}

// enqueue is non-blocking. While a targeted replay is active, live frames are
// retained in a separate bounded FIFO so publishers never wait under session
// or broadcaster locks and cannot overtake the replay terminal. Transient
// preview frames are shed at capacity instead of detaching the subscriber;
// see droppableLiveFrame.
func (x *subscription) enqueue(f Frame) bool {
	select {
	case <-x.stopCh:
		return false
	default:
	}
	x.replayMu.Lock()
	if x.replaying {
		if len(x.pendingLive) >= cap(x.q) {
			x.replayMu.Unlock()
			return droppableLiveFrame(f)
		}
		pending := pendingLiveFrame{frame: f}
		if f.Kind == FrameMessage && x.msgSeqSource != nil {
			// Captured at retention time: the sequence has advanced past every
			// earlier publication by the time the drain runs.
			pending.msgSeq = x.msgSeqSource()
		}
		x.pendingLive = append(x.pendingLive, pending)
		x.replayMu.Unlock()
		return true
	}
	x.replayMu.Unlock()
	select {
	case x.q <- queuedFrame{frame: f}:
		return true
	default:
		return droppableLiveFrame(f)
	}
}

// droppableLiveFrame reports whether a live frame is a transient preview
// whose committed content is re-delivered verbatim by a later authoritative
// frame: streamed message deltas are superseded by the terminal message frame
// at message_end, and tool execution updates by the terminal tool frame at
// tool_execution_end. Shedding previews under backpressure preserves every
// committed byte while keeping a slow consumer attached.
func droppableLiveFrame(f Frame) bool {
	switch f.Kind {
	case FrameMessageDelta:
		return true
	case FrameTool:
		payload, ok := f.Data.(map[string]any)
		if !ok {
			return false
		}
		phase, _ := payload["phase"].(string)
		return phase == "update"
	default:
		return false
	}
}

// enqueueReplay admits one history frame to this subscriber only. The
// page's entry ids ride on the item so the pump records them after the page
// is delivered, before any terminal drain. Admission and terminal delivery
// acknowledgment are both bounded by the history context.
func (x *subscription) enqueueReplay(ctx context.Context, f Frame, terminal bool, replayedIDs []string) error {
	item := queuedFrame{frame: f, replayedIDs: replayedIDs}
	if terminal {
		item.delivered = make(chan struct{})
	}
	// Admission checks context liveness first: once the history context has
	// expired, a page must deterministically fail admission - leaving no
	// recorded entry ids for the drain to suppress live frames with - instead
	// of racing the queue select between delivery and rejection.
	if err := ctx.Err(); err != nil {
		return err
	}
	select {
	case x.q <- item:
	case <-x.stopCh:
		return x.stopReason
	case <-ctx.Done():
		return ctx.Err()
	}
	if item.delivered == nil {
		return nil
	}
	select {
	case <-item.delivered:
		return nil
	case <-x.stopCh:
		return x.stopReason
	case <-ctx.Done():
		return ctx.Err()
	}
}

// enqueueReplayBarrier completes replay without delivering another frame. It
// is used when the terminal transition is already buffered as a live frame.
func (x *subscription) enqueueReplayBarrier(ctx context.Context) error {
	item := queuedFrame{delivered: make(chan struct{}), barrier: true}
	select {
	case x.q <- item:
	case <-x.stopCh:
		return x.stopReason
	case <-ctx.Done():
		return ctx.Err()
	}
	select {
	case <-item.delivered:
		return nil
	case <-x.stopCh:
		return x.stopReason
	case <-ctx.Done():
		return ctx.Err()
	}
}

// enqueueReplayTerminalNow is used after the history context has expired. It
// never waits, but the pump still ends replay only after delivering the error.
func (x *subscription) enqueueReplayTerminalNow(f Frame) bool {
	item := queuedFrame{frame: f, delivered: make(chan struct{})}
	select {
	case x.q <- item:
		return true
	case <-x.stopCh:
		return false
	default:
		return false
	}
}

type broadcaster struct {
	mu                sync.Mutex
	next              uint64
	subs              map[uint64]*subscription
	overflowTransfers map[string]*overflowTransfer
	onDetach          func(Subscriber, error)
}

func (b *broadcaster) attach(sub Subscriber, size int, initial []Frame) (uint64, *subscription, func()) {
	id, target, detach, _ := b.attachWithError(sub, size, initial)
	return id, target, detach
}

func (b *broadcaster) attachWithError(sub Subscriber, size int, initial []Frame) (uint64, *subscription, func(), error) {
	if sub == nil {
		return 0, nil, func() {}, nil
	}
	b.mu.Lock()
	if b.subs == nil {
		b.subs = make(map[uint64]*subscription)
	}
	b.next++
	id := b.next
	transferRejected := false
	if keyed, ok := sub.(overflowTransferSubscriber); ok {
		key := keyed.SubscriberOverflowTransferKey()
		if transfer := b.overflowTransfers[key]; transfer != nil {
			delete(b.overflowTransfers, key)
			if transfer.overflowed || !transfer.finalized {
				transferRejected = true
			} else {
				initial = mergeOverflowTransfer(initial, transfer.frames)
				if size < len(initial) {
					size = len(initial)
				}
			}
		}
	}
	x := &subscription{sub: sub, q: make(chan queuedFrame, size), stopCh: make(chan struct{}), exited: make(chan struct{}), initialDone: make(chan struct{}), initialRemaining: len(initial), cleanupDone: make(chan struct{})}
	x.retire = func(reason error) { b.retire(id, reason, true) }
	b.subs[id] = x
	accepted := !transferRejected
	if accepted {
		for _, f := range initial {
			if !x.enqueue(f) {
				accepted = false
				delete(b.subs, id)
				break
			}
		}
	} else {
		delete(b.subs, id)
	}
	b.mu.Unlock()
	if x.initialRemaining == 0 {
		x.initialOnce.Do(func() { close(x.initialDone) })
	}
	x.start()
	if !accepted {
		x.stopWithReason(ErrSubscriberOverflow, false)
		<-x.exited
		b.notifyDetach(x, ErrSubscriberOverflow)
		x.cleanupOnce.Do(func() { close(x.cleanupDone) })
	} else if _, synchronous := sub.(SynchronousAttachHook); synchronous {
		<-x.initialDone
	}
	var once sync.Once
	detach := func() {
		once.Do(func() { b.retire(id, ErrSubscriberDetached, false) })
		<-x.cleanupDone
	}
	if !accepted {
		return id, x, detach, ErrSubscriberOverflow
	}
	return id, x, detach, nil
}

func mergeOverflowTransfer(initial, transfer []Frame) []Frame {
	transferredNotices := make(map[string]struct{})
	for _, frame := range transfer {
		if id := overflowNoticeIdentity(frame); id != "" {
			transferredNotices[id] = struct{}{}
		}
	}
	merged := make([]Frame, 0, len(initial)+len(transfer))
	for _, frame := range initial {
		if _, duplicate := transferredNotices[overflowNoticeIdentity(frame)]; duplicate {
			continue
		}
		merged = append(merged, frame)
	}
	return append(merged, transfer...)
}

func overflowNoticeIdentity(frame Frame) string {
	if frame.Kind != FrameNotice {
		return ""
	}
	data, _ := frame.Data.(map[string]any)
	id, _ := data["nid"].(string)
	return id
}

func (b *broadcaster) retire(id uint64, reason error, cancel bool) {
	if id == 0 {
		return
	}
	b.mu.Lock()
	x := b.subs[id]
	delete(b.subs, id)
	b.mu.Unlock()
	if x != nil {
		b.finish(x, reason, true, cancel)
	}
}

func (b *broadcaster) finish(x *subscription, reason error, wait, cancel bool) {
	x.stop(cancel)
	if wait {
		<-x.exited
	}
	b.notifyDetach(x, reason)
	x.cleanupOnce.Do(func() { close(x.cleanupDone) })
}

func (b *broadcaster) finishOverflowAsync(x *subscription, transferKey string, replayFrames []Frame) {
	x.stopWithReason(ErrSubscriberOverflow, false)
	go func() {
		if interrupter, ok := x.sub.(deliveryInterrupter); ok {
			_ = interrupter.CancelDelivery()
		} else {
			_ = x.sub.Cancel()
		}
		<-x.exited
		if transferKey != "" {
			b.mu.Lock()
			if transfer := b.overflowTransfers[transferKey]; transfer != nil {
				if replayFrames != nil {
					prefix := append(x.drainReplayTail(), replayFrames...)
					transfer.finalize(prefix)
				} else {
					transfer.finalize(x.drainOverflowQueue())
				}
			}
			b.mu.Unlock()
		}
		b.notifyDetach(x, ErrSubscriberOverflow)
		if recoverer, ok := x.sub.(overflowRecoverer); ok {
			recoverer.RecoverSubscriberOverflow()
		}
		x.cleanupOnce.Do(func() { close(x.cleanupDone) })
	}()
}

func (b *broadcaster) notifyDetach(x *subscription, reason error) {
	if b.onDetach != nil {
		b.onDetach(x.sub, reason)
	}
}

func (b *broadcaster) publish(f Frame) {
	b.publishExcept(f, nil)
}

func (b *broadcaster) publishExcept(f Frame, except *subscription) {
	type retiredSubscription struct {
		sub          *subscription
		transferKey  string
		replayFrames []Frame
	}
	var retired []retiredSubscription
	b.mu.Lock()
	// Previews never enter a recovery transfer. droppableLiveFrame frames are
	// superseded by a later authoritative frame, so counting them would exhaust
	// SubscriberOverflowTransferCapacity and reject re-attach.
	if !droppableLiveFrame(f) {
		for _, transfer := range b.overflowTransfers {
			transfer.append(f)
		}
	}
	for id, x := range b.subs {
		if x == except {
			continue
		}
		if !x.enqueue(f) {
			delete(b.subs, id)
			var transferKey string
			replayFrames, replaying := x.beginOverflowTransfer(f)
			if keyed, ok := x.sub.(overflowTransferSubscriber); ok {
				transferKey = keyed.SubscriberOverflowTransferKey()
				if transferKey != "" {
					if b.overflowTransfers == nil {
						b.overflowTransfers = make(map[string]*overflowTransfer)
					}
					transfer := &overflowTransfer{}
					if replaying {
						transfer.reserved = len(replayFrames)
					} else {
						transfer.reserved = cap(x.q) + 1
						transfer.append(f)
					}
					b.overflowTransfers[transferKey] = transfer
				}
			}
			retired = append(retired, retiredSubscription{sub: x, transferKey: transferKey, replayFrames: replayFrames})
		}
	}
	b.mu.Unlock()
	for _, retired := range retired {
		b.finishOverflowAsync(retired.sub, retired.transferKey, retired.replayFrames)
	}
}

func (b *broadcaster) close(reason error) {
	b.finishAll(reason, true)
}

// retire ends subscriptions without closing their transports. A connection
// still bound to a replaced route can then enter the per-chat recovery flight
// on its next user-required operation.
func (b *broadcaster) retireAll(reason error) {
	b.finishAll(reason, false)
}

func (b *broadcaster) finishAll(reason error, cancel bool) {
	b.mu.Lock()
	all := make([]*subscription, 0, len(b.subs))
	for id, x := range b.subs {
		delete(b.subs, id)
		all = append(all, x)
	}
	clear(b.overflowTransfers)
	b.mu.Unlock()
	for _, x := range all {
		b.finish(x, reason, true, cancel)
	}
}

func (b *broadcaster) count() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.subs)
}
