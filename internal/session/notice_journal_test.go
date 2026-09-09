package session

import (
	"context"
	"fmt"
	"reflect"
	"testing"
	"time"
)

func noticeIdentity(t *testing.T, f Frame) (kind, nid, at string) {
	t.Helper()
	payload, ok := f.Data.(map[string]any)
	if !ok {
		t.Fatalf("notice data = %T, want map[string]any", f.Data)
	}
	kind, _ = payload["kind"].(string)
	nid, _ = payload["nid"].(string)
	at, _ = payload["at"].(string)
	return kind, nid, at
}

// Every attach to a chat replays the journaled notices with the identity that
// was stamped once at publish time.
func TestNoticeJournalReplaysStableIdentityOnEveryAttach(t *testing.T) {
	d := newDaemon(t)
	mgr := testManager(t, dial(t, d), newMemStore(), 16)
	chat := testChat{id: "notice-journal", cwd: t.TempDir()}
	first := newRecorder(64)
	s, _, detach := acquire(t, mgr, chat, first)
	defer detach()
	_, ready := first.await(t, FrameReady)
	_ = ready

	d.EmitSession(s.SessionFile(), map[string]any{"type": "high_reasoning_warning", "modelId": "gpt-5.6-sol"})
	_, live := first.await(t, FrameNotice)
	kind, nid, at := noticeIdentity(t, live)
	if kind != "high_reasoning_warning" {
		t.Fatalf("live notice kind = %q", kind)
	}
	if nid == "" || at == "" {
		t.Fatalf("live notice missing journal identity: nid=%q at=%q", nid, at)
	}
	detach()

	second := newRecorder(64)
	_, _, detachSecond := acquire(t, mgr, chat, second)
	defer detachSecond()
	_, replayed := second.await(t, FrameNotice)
	replayKind, replayNid, replayAt := noticeIdentity(t, replayed)
	if replayKind != kind || replayNid != nid || replayAt != at {
		t.Fatalf("replayed identity changed: live=(%q,%q,%q) replay=(%q,%q,%q)", kind, nid, at, replayKind, replayNid, replayAt)
	}
	if got := mgr.journalLen(chat.id); got != 1 {
		t.Fatalf("journal holds %d records after one publish and one replay, want 1", got)
	}
	detachSecond()

	third := newRecorder(64)
	_, _, detachThird := acquire(t, mgr, chat, third)
	defer detachThird()
	_, again := third.await(t, FrameNotice)
	againKind, againNid, againAt := noticeIdentity(t, again)
	if againKind != kind || againNid != nid || againAt != at {
		t.Fatalf("third attach identity changed: live=(%q,%q,%q) again=(%q,%q,%q)", kind, nid, at, againKind, againNid, againAt)
	}
	if got := mgr.journalLen(chat.id); got != 1 {
		t.Fatalf("replays duplicated journal records: %d, want 1", got)
	}
}

// One logical publish journals exactly one record even with several
// subscribers fanned out on the session broadcaster.
func TestNoticeJournalRecordsOneEntryPerPublishAcrossSubscribers(t *testing.T) {
	d := newDaemon(t)
	mgr := testManager(t, dial(t, d), newMemStore(), 16)
	chat := testChat{id: "notice-fanout", cwd: t.TempDir()}
	paneA := newRecorder(64)
	s, _, detachA := acquire(t, mgr, chat, paneA)
	defer detachA()
	paneA.await(t, FrameReady)
	paneB := newRecorder(64)
	detachB := s.Attach(paneB)
	defer detachB()

	d.EmitSession(s.SessionFile(), map[string]any{"type": "auto_retry_start", "attempt": 1})
	_, a := paneA.await(t, FrameNotice)
	_, b := paneB.await(t, FrameNotice)
	_, nidA, atA := noticeIdentity(t, a)
	_, nidB, atB := noticeIdentity(t, b)
	if nidA == "" || nidA != nidB || atA != atB {
		t.Fatalf("fanout identity diverged: A=(%q,%q) B=(%q,%q)", nidA, atA, nidB, atB)
	}
	if got := mgr.journalLen(chat.id); got != 1 {
		t.Fatalf("journal holds %d records after one fanout publish, want 1", got)
	}
}

// Journal store: nid sequencing, provider-supplied at preservation, ring cap
// eviction, stable replay snapshots, and chat-scoped isolation.
func TestNoticeJournalStoreSequencesCapsAndReplaysStably(t *testing.T) {
	mgr := NewManager(Config{})
	t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })

	engineAt := "2026-09-09T01:02:03.000000004Z"
	first := mgr.RecordNotice("chat-a", map[string]any{"kind": "high_reasoning_warning", "at": engineAt})
	firstPayload, ok := first.Data.(map[string]any)
	if !ok {
		t.Fatalf("RecordNotice data = %T", first.Data)
	}
	if firstPayload["nid"] != "chat-a:1" || firstPayload["at"] != engineAt {
		t.Fatalf("engine-supplied at not preserved and sequenced nid missing: %+v", firstPayload)
	}
	second := mgr.RecordNotice("chat-a", map[string]any{"kind": "auto_retry_start"})
	if secondPayload := second.Data.(map[string]any); secondPayload["nid"] != "chat-a:2" || secondPayload["at"] == "" {
		t.Fatalf("second notice not stamped: %+v", secondPayload)
	}
	if other := mgr.RecordNotice("chat-b", map[string]any{"kind": "auto_retry_start"}); other.Data.(map[string]any)["nid"] != "chat-b:1" {
		t.Fatalf("journal sequence is not chat-scoped: %+v", other.Data)
	}

	const extra = NoticeJournalCapacity + 5
	for i := 0; i < extra; i++ {
		mgr.RecordNotice("chat-a", map[string]any{"kind": "extension_notify", "seq": i})
	}
	replay := mgr.noticeReplay("chat-a")
	if len(replay) != NoticeJournalCapacity {
		t.Fatalf("ring holds %d notices, want cap %d", len(replay), NoticeJournalCapacity)
	}
	head, _ := replay[0].Data.(map[string]any)
	tail, _ := replay[NoticeJournalCapacity-1].Data.(map[string]any)
	if head["nid"] != "chat-a:8" {
		t.Fatalf("oldest notices were not evicted first: head=%v", head["nid"])
	}
	if tail["nid"] != fmt.Sprintf("chat-a:%d", 2+extra) {
		t.Fatalf("newest notice was evicted: tail=%v", tail["nid"])
	}
	again := mgr.noticeReplay("chat-a")
	if !reflect.DeepEqual(replay, again) {
		t.Fatal("replay snapshots are not stable")
	}

	mgr.RetireIdentity("chat-a")
	if got := mgr.noticeReplay("chat-a"); len(got) != 0 {
		t.Fatalf("RetireIdentity left %d journaled notices", len(got))
	}
}

// The journal outlives idle provider eviction: the replacement session
// replays notices journaled by its evicted predecessor.
func TestNoticeJournalSurvivesIdleEviction(t *testing.T) {
	d := newDaemon(t)
	mgr := NewManager(Config{Client: dial(t, d), Store: newMemStore(), QueueSize: 64, IdleAfter: 25 * time.Millisecond, CloseTimeout: time.Second})
	t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })
	chat := testChat{id: "notice-eviction", cwd: t.TempDir()}
	pane := newRecorder(64)
	s, _, detach := acquire(t, mgr, chat, pane)
	pane.await(t, FrameReady)
	d.EmitSession(s.SessionFile(), map[string]any{"type": "high_reasoning_warning", "modelId": "m"})
	_, live := pane.await(t, FrameNotice)
	_, nid, at := noticeIdentity(t, live)
	if nid == "" || at == "" {
		t.Fatalf("notice not stamped before eviction: nid=%q at=%q", nid, at)
	}
	// Subscribe before detaching so the idle timer's close completion is the
	// synchronization point, rather than elapsed time or a polled route.
	closeComplete := make(chan bool, 1)
	go func() { closeComplete <- d.AwaitCloseCount(1, testTimeout) }()
	detach()
	if !<-closeComplete {
		t.Fatal("idle eviction did not complete session close")
	}

	pane2 := newRecorder(64)
	s2, _, detach2 := acquire(t, mgr, chat, pane2)
	defer detach2()
	if s2 == s {
		t.Fatal("acquire after eviction returned the evicted session")
	}
	_, replayed := pane2.await(t, FrameNotice)
	_, replayNid, replayAt := noticeIdentity(t, replayed)
	if replayNid != nid || replayAt != at {
		t.Fatalf("journal identity did not survive eviction: live=(%q,%q) replay=(%q,%q)", nid, at, replayNid, replayAt)
	}
}
