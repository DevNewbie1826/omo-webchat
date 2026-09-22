package session

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/coldhistory"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
)

// The replay/live overlap: while a reattaching subscriber's incremental
// history fetch is in flight, the engine can complete a message whose entry
// the history read already covers. The engine emits the wire message_end
// first, persists the entry, then emits entry_appended (agent-session.js
// processes all three on its event queue in that order). The subscriber
// therefore receives BOTH the replayed entry (in the entries pages) and the
// live message frame (from the pendingLive drain) — the same response
// delivered twice.
//
// The daemon reproduces the engine order exactly: EmitSession(message_end)
// is the wire event, AppendHistory is the persistence that makes the entry
// visible to get_entries, and EmitSession(entry_appended) carries the
// durable entry id plus message payload.
//
// Determinism: RPC responses settle on the client's pending-call path while
// events queue for the manager's serial event loop, so emitting events and
// then releasing the history handler does NOT order the session's dispatch
// against the history response — under GOMAXPROCS=1 the drain could run
// before entry_appended was consumed and the fail-open dedup would deliver
// the duplicate. Every test below therefore attaches a second subscriber
// before the replay window and waits until IT has observed the injected
// live frames before releasing the tail block: the barrier subscriber is
// fed by the same synchronous broadcast that retains frames in the
// replaying subscription's pendingLive, and event dispatch is FIFO, so
// observing the last injected frame proves every earlier engine event was
// already dispatched.

const overlapDupToken = "overlap-dup-token-7f3a9c"
const overlapSentinelToken = "overlap-sentinel-token-1d2b"

func overlapDupMessage() map[string]any {
	return map[string]any{
		"role":    "assistant",
		"content": []any{map[string]any{"type": "text", "text": overlapDupToken}},
	}
}

func overlapSentinelMessage() map[string]any {
	return map[string]any{
		"role":    "assistant",
		"content": []any{map[string]any{"type": "text", "text": overlapSentinelToken}},
	}
}

func overlapEntry(id string, message map[string]any) map[string]any {
	return map[string]any{
		"type":  "entry_appended",
		"entry": map[string]any{"type": "message", "id": id, "message": message},
	}
}

func overlapMessageEnd(message map[string]any) map[string]any {
	return map[string]any{"type": "message_end", "message": message}
}

func overlapDelta(text string) map[string]any {
	return map[string]any{
		"type":                  "message_delta",
		"assistantMessageEvent": map[string]any{"type": "text_delta", "delta": text},
	}
}

// countToken counts how many times token occurs across the JSON encoding of
// every collected frame (entries pages carry it once per replayed copy,
// message frames once per live copy).
func countToken(frames []Frame, token string, t *testing.T) int {
	t.Helper()
	total := 0
	for _, f := range frames {
		b, err := json.Marshal(f)
		if err != nil {
			t.Fatalf("marshal frame: %v", err)
		}
		total += strings.Count(string(b), token)
	}
	return total
}

// overlapSeed opens a daemon session, seeds the prompt's user entry plus two
// scripted entries, saves the reattach cursor, and returns the harness.
func overlapSeed(t *testing.T, chatID string) (*omorpctest.Daemon, *Manager, testChat, string) {
	t.Helper()
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	seedCtx, seedCancel := context.WithTimeout(context.Background(), testTimeout)
	defer seedCancel()
	response, err := client.Call(seedCtx, omorpc.OpenSession{CWD: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	var opened omorpc.OpenSessionData
	if err := json.Unmarshal(response.Data, &opened); err != nil {
		t.Fatal(err)
	}
	d.SetPromptScript(opened.State.SessionFile,
		map[string]any{"type": "message_end", "message": map[string]any{
			"role": "assistant", "content": []any{map[string]any{"type": "text", "text": "seed-one"}},
		}},
		map[string]any{"type": "message_end", "message": map[string]any{
			"role": "assistant", "content": []any{map[string]any{"type": "text", "text": "seed-two"}},
		}},
		map[string]any{"type": "agent_settled"},
	)
	if _, err := client.Call(seedCtx, omorpc.Prompt{SessionID: opened.SessionID, Message: "seed"}); err != nil {
		t.Fatal(err)
	}
	chat := testChat{id: chatID, cwd: filepath.Dir(opened.State.SessionFile)}
	_ = store.SaveCursor(context.Background(), chat.id, Cursor{SessionFile: opened.State.SessionFile})
	return d, testManager(t, client, store, 64), chat, opened.State.SessionFile
}

// awaitFramesWithToken blocks until the recorder observed count frames whose
// JSON encoding contains token, returning every frame consumed while
// waiting. Only frames observed during the call count. Channel receives
// only; no sleeps.
func awaitFramesWithToken(t *testing.T, sub *recorder, token string, count int) []Frame {
	t.Helper()
	var consumed []Frame
	seen := 0
	deadline := time.After(testTimeout)
	for seen < count {
		select {
		case f := <-sub.ch:
			consumed = append(consumed, f)
			if b, err := json.Marshal(f); err == nil && strings.Contains(string(b), token) {
				seen++
			}
		case <-deadline:
			t.Fatalf("timed out waiting for %d frame(s) containing %q, saw %d", count, token, seen)
		}
	}
	return consumed
}

// awaitAcquired settles a background Acquire, failing the test on error.
func awaitAcquired(t *testing.T, acquired <-chan error) {
	t.Helper()
	select {
	case err := <-acquired:
		if err != nil {
			t.Fatalf("Acquire: %v", err)
		}
	case <-time.After(testTimeout):
		t.Fatal("Acquire did not settle")
	}
}

func TestReplayOverlapSuppressesLiveDuplicateOfReplayedEntry(t *testing.T) {
	d, mgr, chat, file := overlapSeed(t, "overlap")

	// The dispatch barrier subscriber, attached with its hydration settled
	// before the replay window opens.
	pre := newRecorder(64)
	_, _, detachPre := acquire(t, mgr, chat, pre)
	defer detachPre()

	releaseTail := d.BlockHandlerForPath(omorpc.CmdGetEntries, file)
	sub := newRecorder(64)
	acquired := make(chan error, 1)
	go func() {
		_, _, _, err := mgr.Acquire(context.Background(), chat, sub)
		acquired <- err
	}()
	// The barrier subscriber's own attach already consumed one get_entries.
	if !d.AwaitRequestCountForPath(omorpc.CmdGetEntries, file, 2, testTimeout) {
		t.Fatal("incremental tail fetch never arrived")
	}

	// Engine order while the tail read is still in flight: wire message_end,
	// then persistence (the entry joins the daemon's history the get_entries
	// response will read), then the entry_appended event carrying the id.
	d.EmitSession(file, overlapMessageEnd(overlapDupMessage()))
	if !d.AppendHistory(file, "assistant", overlapDupToken) {
		t.Fatal("persisting the overlap entry failed")
	}
	d.EmitSession(file, overlapEntry("entry-4", overlapDupMessage()))
	// A non-message live frame must always survive the drain.
	d.EmitSession(file, overlapDelta("tick"))
	// Sentinel: a live message whose entry is NOT replayed must always be
	// delivered, proving the drain flushed and suppression is id-scoped.
	d.EmitSession(file, overlapMessageEnd(overlapSentinelMessage()))
	d.EmitSession(file, overlapEntry("entry-5", overlapSentinelMessage()))

	// Barrier: the tail block releases only after the session provably
	// dispatched every injected event (FIFO: the sentinel frame observed on
	// the barrier subscriber implies the dup frame and both entry_appended
	// events were consumed).
	awaitFramesWithToken(t, pre, overlapDupToken, 1)
	pre.await(t, FrameMessageDelta)
	awaitFramesWithToken(t, pre, overlapSentinelToken, 1)

	releaseTail()
	awaitAcquired(t, acquired)

	var collected []Frame
	sentinelSeen := false
	deltaSeen := false
	deadline := time.After(testTimeout)
	for !(sentinelSeen && deltaSeen) {
		select {
		case f := <-sub.ch:
			collected = append(collected, f)
			if f.Kind == FrameMessage {
				if b, err := json.Marshal(f); err == nil && strings.Contains(string(b), overlapSentinelToken) {
					sentinelSeen = true
				}
			}
			if f.Kind == FrameMessageDelta {
				deltaSeen = true
			}
		case <-deadline:
			t.Fatalf("timed out collecting frames; sentinel=%v delta=%v frames=%d", sentinelSeen, deltaSeen, len(collected))
		}
	}
	// Drain anything already queued behind the sentinel.
	collected = append(collected, sub.drain()...)

	dupCount := countToken(collected, overlapDupToken, t)
	if dupCount != 1 {
		t.Fatalf("overlap message deliveries = %d, want exactly 1 (replayed entry or live frame, never both); frames:\n%s", dupCount, framesSummary(collected))
	}
	sentinelCount := countToken(collected, overlapSentinelToken, t)
	if sentinelCount != 1 {
		t.Fatalf("sentinel deliveries = %d, want 1", sentinelCount)
	}
}

// TestReplayOverlapIdenticalPayloadAfterReplayedEntryStillDelivers pins the
// fail-open counter-case: an entry with payload P was already replayed, and a
// NEW live message with the identical payload completes inside the replay
// window before its own entry_appended arrives. The correlation map knows
// only the older entry, but the newer occurrence was never replayed and must
// still be delivered: the page carries one copy and the live frame the
// second, so the token appears exactly twice. Correlation is unavailable for
// the new frame (no entry_appended), which is precisely the fail-open path.
func TestReplayOverlapIdenticalPayloadAfterReplayedEntryStillDelivers(t *testing.T) {
	d, mgr, chat, file := overlapSeed(t, "overlap-identical")

	pre := newRecorder(64)
	_, _, detachPre := acquire(t, mgr, chat, pre)
	defer detachPre()

	// Occurrence A: completes, persists, and is announced while no replay is
	// in flight, so the reattaching subscriber's tail page will cover it.
	d.EmitSession(file, overlapMessageEnd(overlapDupMessage()))
	if !d.AppendHistory(file, "assistant", overlapDupToken) {
		t.Fatal("persisting the overlap entry failed")
	}
	d.EmitSession(file, overlapEntry("entry-4", overlapDupMessage()))
	// FIFO probe: observed on the barrier subscriber, it proves the
	// entry_appended above was dispatched.
	d.EmitSession(file, overlapDelta("probe-a"))
	awaitFramesWithToken(t, pre, overlapDupToken, 1)
	pre.await(t, FrameMessageDelta)

	releaseTail := d.BlockHandlerForPath(omorpc.CmdGetEntries, file)
	sub := newRecorder(64)
	acquired := make(chan error, 1)
	go func() {
		_, _, _, err := mgr.Acquire(context.Background(), chat, sub)
		acquired <- err
	}()
	if !d.AwaitRequestCountForPath(omorpc.CmdGetEntries, file, 2, testTimeout) {
		t.Fatal("incremental tail fetch never arrived")
	}

	// Occurrence B: an identical live message inside the replay window whose
	// entry_appended has NOT arrived. A marker delta queued behind it proves
	// the drain reached past it once observed.
	d.EmitSession(file, overlapMessageEnd(overlapDupMessage()))
	d.EmitSession(file, overlapDelta("probe-b"))
	awaitFramesWithToken(t, pre, overlapDupToken, 1)
	pre.await(t, FrameMessageDelta)

	releaseTail()
	awaitAcquired(t, acquired)

	prior, _ := sub.await(t, FrameMessageDelta)
	collected := append(prior, sub.drain()...)

	dupCount := countToken(collected, overlapDupToken, t)
	if dupCount != 2 {
		t.Fatalf("identical-payload deliveries = %d, want exactly 2 (the replayed page copy plus the never-replayed live occurrence); frames:\n%s", dupCount, framesSummary(collected))
	}
}

// firedDeadlineCtx is a context whose deadline the test fires at a chosen
// moment. Replay admission must reject a page deterministically once the
// history context is dead, so the regression cannot rely on a timer racing
// the queue select.
type firedDeadlineCtx struct {
	parent context.Context
	fired  chan struct{}
	once   sync.Once
}

func (c *firedDeadlineCtx) fire()                       { c.once.Do(func() { close(c.fired) }) }
func (c *firedDeadlineCtx) Deadline() (time.Time, bool) { return time.Time{}, false }
func (c *firedDeadlineCtx) Done() <-chan struct{}       { return c.fired }
func (c *firedDeadlineCtx) Err() error {
	select {
	case <-c.fired:
		return context.DeadlineExceeded
	default:
		return nil
	}
}
func (c *firedDeadlineCtx) Value(key any) any { return c.parent.Value(key) }

// TestReplayOverlapRejectedPageAdmissionLeavesLiveFramesDelivered pins the
// deadline/admission contract: when a history page's admission fails (here,
// the history context is already dead), the page's entry ids must never be
// recorded, and the live duplicate retained in pendingLive must still be
// delivered by the terminal drain. The history stream is stubbed so the page
// carrying the dup entry is emitted only after the deadline fires; the
// timeout path then queues the terminal error frame and the drain runs with
// an empty replayed set.
func TestReplayOverlapRejectedPageAdmissionLeavesLiveFramesDelivered(t *testing.T) {
	d, mgr, chat, file := overlapSeed(t, "overlap-admission")

	pre := newRecorder(64)
	sess, _, detachPre := acquire(t, mgr, chat, pre)
	defer detachPre()

	pageEntry, err := json.Marshal(map[string]any{
		"type": "message", "id": "entry-4", "message": overlapDupMessage(),
	})
	if err != nil {
		t.Fatal(err)
	}

	realStream := streamSessionHistory
	started := make(chan struct{})
	prepared := make(chan struct{})
	fire := make(chan struct{})
	streamSessionHistory = func(ctx context.Context, path string, options coldhistory.Options, emit func(coldhistory.Metadata, coldhistory.Page) error) (coldhistory.Metadata, error) {
		close(started)
		meta := coldhistory.Metadata{Header: coldhistory.Header{ID: sess.ID()}, LeafID: "entry-3"}
		// First callback completes preparation (the daemon tail fetch
		// included) with no entries, while the history context is live.
		if err := emit(meta, coldhistory.Page{}); err != nil {
			return meta, err
		}
		close(prepared)
		<-fire
		// Second callback carries the entry whose live duplicate is already
		// retained behind the replay gate; with the deadline fired its
		// admission must fail without queueing the page.
		return meta, emit(meta, coldhistory.Page{Entries: []json.RawMessage{pageEntry}})
	}
	t.Cleanup(func() { streamSessionHistory = realStream })

	// The stub's fire gate and the history context's deadline are separate
	// knobs: the context must die before the stub releases its second page.
	// Both are idempotent so a cleanup after any earlier failure cannot hang
	// teardown on the hydration goroutine.
	releaseStub := sync.OnceFunc(func() { close(fire) })
	t.Cleanup(releaseStub)
	historyCtx := &firedDeadlineCtx{parent: context.Background(), fired: make(chan struct{})}
	t.Cleanup(historyCtx.fire)
	// The hydration runs against the fired deadline directly: Manager.Acquire
	// wraps the caller context in WithCancel, and a custom parent's expiry
	// reaches that wrapper only through an async propagation watcher, which
	// would make admission nondeterministic under GOMAXPROCS=1.
	sub := newRecorder(64)
	detachSub, target, err := sess.attachCheckedReplayTarget(sub)
	if err != nil {
		t.Fatal(err)
	}
	defer detachSub()
	acquired := make(chan error, 1)
	go func() {
		acquired <- hydrateForSubscriber(historyCtx, sess, file, target, nil)
	}()
	select {
	case <-started:
	case <-time.After(testTimeout):
		t.Fatal("stubbed history stream never started")
	}

	// The live duplicate plus its entry_appended, and the sentinel that
	// proves the drain flushed. The barrier subscriber observes both frames
	// before the deadline fires, so dispatch consumed every event first.
	d.EmitSession(file, overlapMessageEnd(overlapDupMessage()))
	d.EmitSession(file, overlapEntry("entry-4", overlapDupMessage()))
	d.EmitSession(file, overlapMessageEnd(overlapSentinelMessage()))
	awaitFramesWithToken(t, pre, overlapDupToken, 1)
	awaitFramesWithToken(t, pre, overlapSentinelToken, 1)

	select {
	case <-prepared:
	case <-time.After(testTimeout):
		t.Fatal("history preparation never completed")
	}
	// The history context dies first; the stub then emits the page whose
	// admission must deterministically fail without queueing it.
	historyCtx.fire()
	releaseStub()
	awaitAcquired(t, acquired)

	prior, _ := sub.awaitError(t, "provider_timeout")
	// The token waits are the only consumers until both drained frames are
	// observed: a non-blocking sweep here would race the pump and swallow
	// the frames the waits still need under GOMAXPROCS=1.
	collected := append([]Frame(nil), prior...)
	collected = append(collected, awaitFramesWithToken(t, sub, overlapDupToken, 1)...)
	collected = append(collected, awaitFramesWithToken(t, sub, overlapSentinelToken, 1)...)
	collected = append(collected, sub.drain()...)
	for _, f := range collected {
		if f.Kind == FrameEntries {
			if b, err := json.Marshal(f); err == nil && strings.Contains(string(b), overlapDupToken) {
				t.Fatalf("rejected admission still delivered a page carrying the dup entry: %+v", f.Data)
			}
		}
	}
	dupCount := countToken(collected, overlapDupToken, t)
	if dupCount != 1 {
		t.Fatalf("live duplicate deliveries after rejected admission = %d, want exactly 1 (fail-open: the page never delivered); frames:\n%s", dupCount, framesSummary(collected))
	}
	sentinelCount := countToken(collected, overlapSentinelToken, t)
	if sentinelCount != 1 {
		t.Fatalf("sentinel deliveries = %d, want 1", sentinelCount)
	}
}

func framesSummary(frames []Frame) string {
	var b strings.Builder
	for _, f := range frames {
		fmt.Fprintf(&b, "%s %+v\n", f.Kind, f.Data)
	}
	return b.String()
}
