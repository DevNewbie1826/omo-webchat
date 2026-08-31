package chat

import (
	"context"
	"encoding/json"
	"reflect"
	"strconv"
	"testing"
	"time"
)

// durableNoticeFixtureKinds is exactly the advisory set the durability
// contract designates as durable: logged on the session, replayed to late
// attachers, and persisted through OnNoticePersist. Everything else —
// including extension_notify — is transient and must never enter the log.
var durableNoticeFixtureKinds = []string{
	"retry_fallback_applied",
	"retry_fallback_reverted",
	"retry_fallback_succeeded",
	"retry_fallback_exhausted",
	"server_fallback_aborted",
	"high_reasoning_warning",
}

var transientNoticeFixtureKinds = []string{
	"auto_retry_start",
	"auto_retry_end",
	"summarization_retry_attempt_start",
	"summarization_retry_scheduled",
	"summarization_retry_finished",
	"settings_source_selected",
	"extension_notify",
}

// durableLog copies the session's durable notice log under its lock.
func durableLog(s *Session) []NoticeRecord {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]NoticeRecord(nil), s.durableNotices...)
}

func parseNoticeAt(t *testing.T, raw string) time.Time {
	t.Helper()
	if raw == "" {
		t.Fatalf("notice frame carries no \"at\" timestamp")
	}
	at, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		t.Fatalf("notice \"at\" %q is not RFC3339Nano: %v", raw, err)
	}
	if at.IsZero() {
		t.Fatalf("notice \"at\" %q is the zero time", raw)
	}
	return at
}

// Every forwarded notice frame — durable, transient, and extension_notify —
// must carry a parseable non-zero "at" receipt timestamp.
func TestNoticeFramesCarryReceiptTime(t *testing.T) {
	kinds := make([]string, 0, len(durableNoticeFixtureKinds)+len(transientNoticeFixtureKinds))
	kinds = append(kinds, durableNoticeFixtureKinds...)
	kinds = append(kinds, transientNoticeFixtureKinds...)
	for _, kind := range kinds {
		t.Run(kind, func(t *testing.T) {
			writer := newCollectWriter()
			s := newTestSession("chat-notice-at-"+kind, writer)
			if kind == "extension_notify" {
				dispatchEvent(s, "extension_ui_request", `{"type":"extension_ui_request","id":"n1","method":"notify","title":"Heads up","message":"Compaction scheduled"}`)
			} else {
				dispatchEvent(s, kind, `{"type":"`+kind+`","sessionId":"rpc-1","marker":true}`)
			}
			frames := collectNoticeFrames(t, writer.snapshot())
			if len(frames) != 1 {
				t.Fatalf("notice frames = %d, want exactly 1; frames: %s", len(frames), writer.typesString())
			}
			parseNoticeAt(t, frames[0].At)
		})
	}
}

// Durable kinds append exactly one record to the session log (kind, bare
// payload, non-zero receipt time); transient kinds never touch the log.
func TestDurableNoticesLogAndTransientDoNot(t *testing.T) {
	for _, kind := range durableNoticeFixtureKinds {
		t.Run("durable/"+kind, func(t *testing.T) {
			writer := newCollectWriter()
			s := newTestSession("chat-durable-"+kind, writer)
			dispatchEvent(s, kind, `{"type":"`+kind+`","sessionId":"rpc-1","marker":"`+kind+`"}`)
			if got := countFramesOfType(writer.snapshot(), "notice"); got != 1 {
				t.Fatalf("live notice frames = %d, want 1; frames: %s", got, writer.typesString())
			}
			log := durableLog(s)
			if len(log) != 1 {
				t.Fatalf("durable log = %+v, want exactly 1 record", log)
			}
			if log[0].Kind != kind {
				t.Fatalf("durable log kind = %q, want %q", log[0].Kind, kind)
			}
			var payload map[string]any
			if err := json.Unmarshal(log[0].Payload, &payload); err != nil {
				t.Fatalf("log payload is not valid JSON: %v (%s)", err, log[0].Payload)
			}
			if payload["marker"] != kind {
				t.Fatalf("log payload = %s, want the bare advisory object with marker %q", log[0].Payload, kind)
			}
			if log[0].At.IsZero() {
				t.Fatalf("durable log record carries a zero receipt time")
			}
		})
	}
	for _, kind := range transientNoticeFixtureKinds {
		t.Run("transient/"+kind, func(t *testing.T) {
			writer := newCollectWriter()
			s := newTestSession("chat-transient-"+kind, writer)
			if kind == "extension_notify" {
				dispatchEvent(s, "extension_ui_request", `{"type":"extension_ui_request","id":"n1","method":"notify","message":"Heads up"}`)
			} else {
				dispatchEvent(s, kind, `{"type":"`+kind+`","sessionId":"rpc-1","marker":true}`)
			}
			if got := countFramesOfType(writer.snapshot(), "notice"); got != 1 {
				t.Fatalf("live notice frames = %d, want 1; frames: %s", got, writer.typesString())
			}
			if log := durableLog(s); len(log) != 0 {
				t.Fatalf("transient %s logged %+v, want an empty durable log", kind, log)
			}
		})
	}
}

// The durable log is bounded: the 51st durable notice drops the oldest
// record, keeping exactly the newest 50.
func TestDurableNoticeLogDropsOldest(t *testing.T) {
	writer := newCollectWriter()
	s := newTestSession("chat-durable-cap", writer)
	for i := 1; i <= 51; i++ {
		dispatchEvent(s, "high_reasoning_warning", `{"type":"high_reasoning_warning","sessionId":"rpc-1","n":`+strconv.Itoa(i)+`}`)
	}
	log := durableLog(s)
	if len(log) != 50 {
		t.Fatalf("durable log length = %d, want 50", len(log))
	}
	var first map[string]any
	if err := json.Unmarshal(log[0].Payload, &first); err != nil {
		t.Fatalf("oldest kept payload is not valid JSON: %v (%s)", err, log[0].Payload)
	}
	if first["n"] != float64(2) {
		t.Fatalf("oldest kept record = %s, want n=2 (record n=1 dropped)", log[0].Payload)
	}
	var last map[string]any
	if err := json.Unmarshal(log[len(log)-1].Payload, &last); err != nil {
		t.Fatalf("newest payload is not valid JSON: %v (%s)", err, log[len(log)-1].Payload)
	}
	if last["n"] != float64(51) {
		t.Fatalf("newest record = %s, want n=51", log[len(log)-1].Payload)
	}
}

// Attach replay delivers the activity snapshot frames first, then the durable
// notice frames oldest -> newest. A second attach receives them again: the
// log is session state, not a consumed replay.
func TestAttachReplaySnapshotsThenDurableNotices(t *testing.T) {
	writer := newCollectWriter()
	s := newTestSession("chat-notice-replay", writer)

	dispatchEvent(s, "extension_event", `{"type":"extension_event","name":"omo.task.updated","data":{"task":{"id":"st_1","status":"running"}}}`)
	dispatchEvent(s, "high_reasoning_warning", `{"type":"high_reasoning_warning","sessionId":"rpc-1","modelId":"gpt-5.6-sol"}`)
	dispatchEvent(s, "retry_fallback_applied", `{"type":"retry_fallback_applied","sessionId":"rpc-1","from":"a","to":"b"}`)

	for pass := 1; pass <= 2; pass++ {
		late := newCollectWriter()
		s.Attach(late)
		assertSnapshotThenNoticesReplay(t, late, pass)
	}
}

func assertSnapshotThenNoticesReplay(t *testing.T, late *collectWriter, pass int) {
	t.Helper()
	frames := late.snapshot()
	snapshotIndex := -1
	var noticeKinds []string
	for i, raw := range frames {
		var env struct {
			Type string `json:"type"`
			Name string `json:"name"`
		}
		if err := json.Unmarshal(raw, &env); err != nil {
			t.Fatalf("replayed frame %d is not valid JSON: %v (%s)", i, err, raw)
		}
		switch env.Type {
		case "extensionEvent":
			if env.Name != "omo.task.updated" {
				t.Fatalf("pass %d: unexpected replayed extension event %q", pass, env.Name)
			}
			snapshotIndex = i
		case "notice":
			var notice noticeEnvelope
			if err := json.Unmarshal(raw, &notice); err != nil {
				t.Fatalf("replayed notice %d is not valid JSON: %v (%s)", i, err, raw)
			}
			noticeKinds = append(noticeKinds, notice.Kind)
		}
	}
	if snapshotIndex == -1 {
		t.Fatalf("pass %d: replay carries no activity snapshot; frames: %s", pass, late.typesString())
	}
	if !reflect.DeepEqual(noticeKinds, []string{"high_reasoning_warning", "retry_fallback_applied"}) {
		t.Fatalf("pass %d: replayed notice kinds = %v, want [high_reasoning_warning retry_fallback_applied] (oldest first); frames: %s", pass, noticeKinds, late.typesString())
	}
	var noticeIndexes []int
	for i, raw := range frames {
		var env struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(raw, &env) == nil && env.Type == "notice" {
			noticeIndexes = append(noticeIndexes, i)
		}
	}
	for _, idx := range noticeIndexes {
		if idx < snapshotIndex {
			t.Fatalf("pass %d: notice frame at %d precedes activity snapshot at %d", pass, idx, snapshotIndex)
		}
	}
}

// The OnNoticePersist callback is the write-through boundary: fired once per
// durable notice with the full log, skipped when the log is unchanged since
// the last successful write, and retried with the full log after a failure.
func TestOnNoticePersistWriteThroughAndChangedGuard(t *testing.T) {
	calls := make(chan []NoticeRecord, 4)
	writer := newCollectWriter()
	s := newTestSession("chat-notice-persist", writer)
	callNumber := 0 // worker-owned
	s.mu.Lock()
	s.onNoticePersist = func(_ *Session, notices []NoticeRecord) bool {
		callNumber++
		calls <- cloneNoticeRecords(notices)
		return callNumber != 2 // second write fails, must retry on the next notice
	}
	s.mu.Unlock()
	s.startNoticePersistence()
	t.Cleanup(s.stopNoticePersistence)

	dispatchEvent(s, "retry_fallback_applied", `{"type":"retry_fallback_applied","sessionId":"rpc-1","n":1}`)
	s.drainNoticePersistence()
	first := <-calls
	if len(first) != 1 {
		t.Fatalf("first durable write = %+v, want one record", first)
	}
	dispatchEvent(s, "retry_fallback_applied", `{"type":"retry_fallback_applied","sessionId":"rpc-1","n":2}`)
	s.drainNoticePersistence()
	if failed := <-calls; len(failed) != 2 {
		t.Fatalf("failed durable write = %+v, want the full 2-record log", failed)
	}
	dispatchEvent(s, "high_reasoning_warning", `{"type":"high_reasoning_warning","sessionId":"rpc-1","n":3}`)
	s.drainNoticePersistence()
	retry := <-calls
	if len(retry) != 3 {
		t.Fatalf("retry handed %+v, want the full 3-record log", retry)
	}
	for i, want := range []float64{1, 2, 3} {
		var got map[string]any
		if err := json.Unmarshal(retry[i].Payload, &got); err != nil {
			t.Fatalf("record %d payload is not valid JSON: %v (%s)", i, err, retry[i].Payload)
		}
		if got["n"] != want {
			t.Fatalf("retry record %d = %s, want n=%v", i, retry[i].Payload, want)
		}
	}
	// A worker barrier makes the unchanged guard deterministic: if the callback
	// ran, its buffered call would be observable after the drain acknowledges.
	s.queueNoticePersistence()
	s.drainNoticePersistence()
	select {
	case unexpected := <-calls:
		t.Fatalf("unchanged log was persisted again: %+v", unexpected)
	default:
	}
}

func TestSlowNoticePersistenceWritesEveryAppendSnapshotInOrder(t *testing.T) {
	firstStarted := make(chan struct{})
	releaseFirst := make(chan struct{})
	calls := make(chan []NoticeRecord, 4)
	s := newTestSession("chat-notice-ordered", nil)
	call := 0
	s.mu.Lock()
	s.onNoticePersist = func(_ *Session, notices []NoticeRecord) bool {
		call++
		if call == 1 {
			close(firstStarted)
			<-releaseFirst
		}
		calls <- cloneNoticeRecords(notices)
		return true
	}
	s.mu.Unlock()
	s.startNoticePersistence()
	t.Cleanup(s.stopNoticePersistence)

	dispatchEvent(s, "high_reasoning_warning", `{"type":"high_reasoning_warning","n":1}`)
	<-firstStarted
	dispatchEvent(s, "high_reasoning_warning", `{"type":"high_reasoning_warning","n":2}`)
	dispatchEvent(s, "high_reasoning_warning", `{"type":"high_reasoning_warning","n":3}`)
	close(releaseFirst)
	s.drainNoticePersistence()

	for wantLen := 1; wantLen <= 3; wantLen++ {
		got := <-calls
		if len(got) != wantLen {
			t.Fatalf("write %d snapshot length = %d, want %d: %+v", wantLen, len(got), wantLen, got)
		}
		for i := range got {
			var payload struct {
				N int `json:"n"`
			}
			if err := json.Unmarshal(got[i].Payload, &payload); err != nil || payload.N != i+1 {
				t.Fatalf("write %d record %d = %s, want n=%d (err=%v)", wantLen, i, got[i].Payload, i+1, err)
			}
		}
	}
}

func TestIdenticalDurableNoticesHaveDistinctPersistedReplayIDs(t *testing.T) {
	persisted := make(chan []NoticeRecord, 2)
	s := newTestSession("chat-notice-distinct", nil)
	s.mu.Lock()
	s.onNoticePersist = func(_ *Session, notices []NoticeRecord) bool {
		persisted <- cloneNoticeRecords(notices)
		return true
	}
	s.mu.Unlock()
	s.startNoticePersistence()
	t.Cleanup(s.stopNoticePersistence)

	raw := `{"type":"high_reasoning_warning","modelId":"same"}`
	at := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	s.forwardNotice("high_reasoning_warning", advisoryNoticePayload(json.RawMessage(raw)), at)
	s.forwardNotice("high_reasoning_warning", advisoryNoticePayload(json.RawMessage(raw)), at)
	s.drainNoticePersistence()
	<-persisted
	last := <-persisted
	if len(last) != 2 || last[0].NID == "" || last[1].NID == "" || last[0].NID == last[1].NID {
		t.Fatalf("persisted identical notices have ids %q and %q, want two non-empty distinct ids", last[0].NID, last[1].NID)
	}

	late := newCollectWriter()
	s.Attach(late)
	frames := collectNoticeFrames(t, late.snapshot())
	if len(frames) != 2 {
		t.Fatalf("replayed notices = %d, want 2", len(frames))
	}
	if frames[0].NID != last[0].NID || frames[1].NID != last[1].NID {
		t.Fatalf("replayed notice ids = [%q %q], want persisted ids [%q %q]", frames[0].NID, frames[1].NID, last[0].NID, last[1].NID)
	}
}

func TestCloseDrainsNoticePersistenceWorker(t *testing.T) {
	persisted := make(chan []NoticeRecord, 1)
	s := newTestSession("chat-notice-close", nil)
	s.mu.Lock()
	s.onNoticePersist = func(_ *Session, notices []NoticeRecord) bool {
		persisted <- cloneNoticeRecords(notices)
		return true
	}
	s.mu.Unlock()
	s.startNoticePersistence()
	dispatchEvent(s, "high_reasoning_warning", `{"type":"high_reasoning_warning","sessionId":"rpc-1"}`)
	if err := s.Close(); err != nil {
		t.Fatalf("close session: %v", err)
	}
	select {
	case records := <-persisted:
		if len(records) != 1 {
			t.Fatalf("persisted records at Close = %+v, want one", records)
		}
	default:
		t.Fatal("Close returned before the notice worker persisted its dirty log")
	}
}

func TestManagerRetainsPersistenceGenerationThroughDisconnectDrain(t *testing.T) {
	manager := NewManager()
	t.Cleanup(manager.CloseAll)
	firstStarted := make(chan struct{})
	releaseFirst := make(chan struct{})
	persisted := make(chan []NoticeRecord, 2)
	s := newTestSession("chat-retiring-persist", nil)
	s.owner = manager
	call := 0
	s.mu.Lock()
	s.onNoticePersist = func(source *Session, notices []NoticeRecord) bool {
		return manager.PersistIfGeneration(source, func() bool {
			call++
			if call == 1 {
				close(firstStarted)
				<-releaseFirst
			}
			persisted <- cloneNoticeRecords(notices)
			return true
		})
	}
	s.mu.Unlock()
	s.startNoticePersistence()
	manager.mu.Lock()
	manager.sessions[s.ID()] = s
	manager.generations[s.ID()] = s
	manager.mu.Unlock()

	dispatchEvent(s, "high_reasoning_warning", `{"type":"high_reasoning_warning","n":1}`)
	<-firstStarted
	dispatchEvent(s, "high_reasoning_warning", `{"type":"high_reasoning_warning","n":2}`)
	stopped := make(chan struct{})
	go func() {
		manager.StopIfCurrent(s.ID(), s)
		close(stopped)
	}()
	close(releaseFirst)
	<-stopped

	first, second := <-persisted, <-persisted
	if len(first) != 1 || len(second) != 2 {
		t.Fatalf("disconnect writes lengths = %d, %d; want 1, 2", len(first), len(second))
	}
}

func TestProviderExitStopsNoticePersistenceWorker(t *testing.T) {
	manager := NewManager()
	t.Cleanup(manager.CloseAll)
	s := newTestSession("chat-provider-exit-worker", nil)
	s.owner = manager
	s.mu.Lock()
	s.onNoticePersist = func(*Session, []NoticeRecord) bool { return true }
	s.mu.Unlock()
	s.startNoticePersistence()
	s.mu.Lock()
	done := s.noticePersistDone
	s.mu.Unlock()
	manager.mu.Lock()
	manager.sessions[s.ID()] = s
	manager.generations[s.ID()] = s
	manager.mu.Unlock()

	s.providerExited(providerTermination{kind: providerTerminationIntentional})
	select {
	case <-done:
	default:
		t.Fatal("provider exit returned without stopping the notice persistence worker")
	}
	if manager.PersistIfGeneration(s, func() bool { return true }) {
		t.Fatal("provider-exited generation remained authoritative")
	}
}

func TestRetiredWorkerCannotOverwriteReplacementGeneration(t *testing.T) {
	manager := NewManager()
	t.Cleanup(manager.CloseAll)
	old := newTestSession("chat-generation", nil)
	old.owner = manager
	manager.mu.Lock()
	manager.sessions[old.ID()] = old
	manager.generations[old.ID()] = old
	delete(manager.sessions, old.ID())
	delete(manager.generations, old.ID())
	replacement := newTestSession(old.ID(), nil)
	manager.sessions[replacement.ID()] = replacement
	manager.generations[replacement.ID()] = replacement
	manager.mu.Unlock()

	value := "replacement"
	if manager.PersistIfGeneration(old, func() bool { value = "old"; return true }) {
		t.Fatal("retired worker was accepted as the current persistence generation")
	}
	if value != "replacement" {
		t.Fatalf("retired worker overwrote replacement value: %q", value)
	}
}

func TestNoticePersistenceRegistrationWindowRetriesAfterRouteActivation(t *testing.T) {
	manager := NewManager()
	t.Cleanup(manager.CloseAll)
	s := newTestSession("chat-opening-notice", nil)
	attempts := make(chan bool, 2)
	s.mu.Lock()
	s.onNoticePersist = func(source *Session, _ []NoticeRecord) bool {
		current := manager.Get(source.ID()) == source
		attempts <- current
		return current
	}
	s.mu.Unlock()
	s.startNoticePersistence()
	t.Cleanup(s.stopNoticePersistence)

	manager.mu.Lock()
	manager.pending[s.ID()] = true
	manager.mu.Unlock()
	dispatchEvent(s, "high_reasoning_warning", `{"type":"high_reasoning_warning","sessionId":"rpc-1"}`)
	s.drainNoticePersistence()
	if current := <-attempts; current {
		t.Fatal("pre-registration notice write was treated as successful")
	}
	if len(s.noticesPersisted) != 0 {
		t.Fatal("skipped pre-registration write advanced the success marker")
	}

	manager.mu.Lock()
	delete(manager.pending, s.ID())
	manager.sessions[s.ID()] = s
	manager.mu.Unlock()
	s.queueNoticePersistence()
	s.drainNoticePersistence()
	if current := <-attempts; !current {
		t.Fatal("registration flush did not persist against the authoritative route")
	}
	if len(s.noticesPersisted) != 1 {
		t.Fatalf("persisted marker length = %d, want 1 after registration flush", len(s.noticesPersisted))
	}
}

// A session created with a persisted notice seed must replay the seeded
// durable notices to its first attached client, oldest -> newest, exactly
// like an in-memory log (node-gated: StartSession wiring).
func TestSeedNoticesReplayToFirstClient(t *testing.T) {
	opts := managedMockOptions(t, "chat-notice-seed")
	base := time.Date(2026, 1, 2, 3, 4, 5, 123456789, time.UTC)
	opts.SeedNotices = []NoticeRecord{
		{Kind: "retry_fallback_applied", Payload: json.RawMessage(`{"from":"a","to":"b"}`), At: base},
		{Kind: "high_reasoning_warning", Payload: json.RawMessage(`{"modelId":"gpt-5.6-sol"}`), At: base.Add(time.Second)},
	}

	s, err := StartSession(context.Background(), opts)
	if err != nil {
		t.Fatalf("start session: %v", err)
	}
	t.Cleanup(func() {
		if err := s.Close(); err != nil {
			t.Errorf("close session: %v", err)
		}
	})

	w := newCollectWriter()
	s.Attach(w)

	frames := collectNoticeFrames(t, w.snapshot())
	if len(frames) != 2 {
		t.Fatalf("seeded replay notices = %d, want exactly 2; frames: %s", len(frames), w.typesString())
	}
	wantKinds := []string{"retry_fallback_applied", "high_reasoning_warning"}
	for i, frame := range frames {
		if frame.Kind != wantKinds[i] {
			t.Fatalf("replayed notice %d kind = %q, want %q (oldest first)", i, frame.Kind, wantKinds[i])
		}
		if frame.SessionID != "chat-notice-seed" {
			t.Fatalf("replayed notice %d sessionId = %q, want chat-notice-seed", i, frame.SessionID)
		}
		parseNoticeAt(t, frame.At)
	}
	var got, want any
	if err := json.Unmarshal(frames[0].Payload, &got); err != nil {
		t.Fatalf("replayed payload is not valid JSON: %v (%s)", err, frames[0].Payload)
	}
	if err := json.Unmarshal([]byte(`{"from":"a","to":"b"}`), &want); err != nil {
		t.Fatalf("fixture payload is not valid JSON: %v", err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("replayed payload = %s, want the seeded payload", frames[0].Payload)
	}
}

// Malformed persisted seed records (empty kind, zero receipt time) are
// dropped at seed time; the valid remainder seeds the log.
func TestSeedNoticesDropsMalformedRecords(t *testing.T) {
	s := newTestSession("chat-notice-seed-bad", nil)
	base := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	s.seedNotices([]NoticeRecord{
		{Kind: "", Payload: json.RawMessage(`{"malformed":"empty kind"}`), At: base},
		{Kind: "retry_fallback_applied", Payload: json.RawMessage(`{"ok":true}`), At: base},
		{Kind: "unknown_future_notice", Payload: json.RawMessage(`{"not":"durable"}`), At: base},
		{Kind: "high_reasoning_warning", Payload: json.RawMessage(`{"malformed":"zero time"}`)},
	})
	log := durableLog(s)
	if len(log) != 1 {
		t.Fatalf("seeded log = %+v, want exactly the 1 valid record", log)
	}
	if log[0].Kind != "retry_fallback_applied" {
		t.Fatalf("seeded log kind = %q, want retry_fallback_applied", log[0].Kind)
	}
}
