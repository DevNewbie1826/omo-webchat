package session

import (
	"context"
	"fmt"
	"reflect"
	"testing"
)

func persistDerivedNotices(t *testing.T, s *Session) string {
	t.Helper()
	dir := t.TempDir()
	journal := s.manager.noticeJournal(s.chatID)
	journal.mu.Lock()
	journal.dir = dir
	journal.mu.Unlock()
	return dir
}

func assertDerivedRestart(t *testing.T, s *Session, dir string) {
	t.Helper()
	restarted := NewManager(Config{NoticeDir: dir})
	t.Cleanup(func() {
		if err := restarted.CloseAll(context.Background()); err != nil {
			t.Error(err)
		}
	})
	want := s.manager.noticeReplay(s.chatID)
	got := restarted.noticeReplay(s.chatID)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("restart replay = %#v, want %#v", got, want)
	}
	// Rebuilding the same persisted entries must not append new identities.
	rebuilt := &Session{manager: restarted, chatID: s.chatID, durableID: s.durableID}
	journal := restarted.noticeJournal(s.chatID)
	journal.mu.Lock()
	keys := make([]string, 0, len(journal.derivations))
	for key := range journal.derivations {
		keys = append(keys, key)
	}
	journal.mu.Unlock()
	for _, key := range keys {
		rebuilt.publishNoticeOnceLocked(key, "engine_warning", "duplicate")
	}
	if after := restarted.noticeReplay(s.chatID); !reflect.DeepEqual(after, want) {
		t.Fatalf("restart rederived notices: %#v", after)
	}
}

func TestNoticeDerivationBillingFormat(t *testing.T) {
	for _, tc := range []struct {
		tokens float64
		cost   float64
		text   string
	}{
		{999, 0.009, "999 tokens billed"},
		{6800, 0.01, "6.8K tokens billed (~$0.01)"},
		{546000, 0, "546K tokens billed"},
		{1000000, 0, "1M tokens billed"},
		{1500000, 0, "1.5M tokens billed"},
		{2000000000, 0, "2B tokens billed"},
		{1250, 0.125, "1.3K tokens billed (~$0.13)"},
		{10500, 2.675, "11K tokens billed (~$2.67)"},
	} {
		t.Run(tc.text, func(t *testing.T) {
			s, sub := acquireDrained(t, fmt.Sprint(tc.tokens))
			injectEvent(t, s, map[string]any{"type": "compaction_end", "accepted": true, "result": map[string]any{"summary": "s", "tokensBefore": 1, "usage": map[string]any{"input": tc.tokens, "cost": map[string]any{"total": tc.cost}}}})
			assertDerivedPayloads(t, publishCompactionMarker(t, s, sub), []string{`{"kind":"compaction_summary","summary":"s","tokensBefore":1}`, fmt.Sprintf(`{"kind":"compaction_cost","text":"Compaction: %s"}`, tc.text)})
		})
	}
}

func TestNoticeDerivationCacheStickyAndDuplicate(t *testing.T) {
	s, sub := acquireDrained(t, "cache-sticky")
	first := cacheMessage(1, "m", 0, 30000, 0, 0, 0)
	second := cacheMessage(2, "m", 30000, 0, 0, 0, 0)
	third := cacheMessage(3, "m", 30000, 0, 0, 0, 0)
	injectEvent(t, s, first)
	injectEvent(t, s, second)
	injectEvent(t, s, third)
	injectEvent(t, s, first)
	injectEvent(t, s, third)
	assertDerivedPayloads(t, publishCompactionMarker(t, s, sub), []string{`{"kind":"cache_miss","text":"Cache miss: 30K tokens re-billed"}`, `{"kind":"cache_miss","text":"Cache miss: 30K tokens re-billed"}`})
}

func TestNoticeDerivationContinuityByteBoundaries(t *testing.T) {
	for _, tc := range []struct {
		size float64
		text string
	}{{999, "999B"}, {1024, "1.0KB"}, {1280, "1.3KB"}, {1048576, "1.0MB"}} {
		t.Run(tc.text, func(t *testing.T) {
			s, sub := acquireDrained(t, tc.text)
			message := map[string]any{"role": "assistant", "stopReason": "aborted", "diagnostics": []any{map[string]any{"type": "claude_sdk_oauth_session_continuity", "details": map[string]any{"kind": "flatten", "payloadBytes": tc.size}}, map[string]any{"type": "anthropic_input_transformations", "details": map[string]any{"transformations": []any{map[string]any{"type": "thinking_dropped"}}}}}}
			event := map[string]any{"type": "message_end", "message": message}
			injectEvent(t, s, event)
			injectEvent(t, s, event)
			assertDerivedPayloads(t, publishCompactionMarker(t, s, sub), []string{fmt.Sprintf(`{"kind":"continuity_notice","text":"Session continuity lost - resent the full conversation - sent %s"}`, tc.text)})
		})
	}
}
