package session

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestDispatchGoalCustomNoticesStaySilent(t *testing.T) {
	for _, kind := range []string{"goal-cache-warmup", "omo-loop:tick", "omo-cache-keepalive", "omo-rule-activation"} {
		t.Run(kind, func(t *testing.T) {
			s, sub := acquireDrained(t, "goal-custom-"+kind)
			for _, value := range []json.Number{"1", "1e400"} {
				injectEvent(t, s, map[string]any{"type": "entry_appended", "entry": map[string]any{"type": "custom", "customType": kind, "data": map[string]any{"value": value}}})
			}
			if frames := dropAttachReady(publishCompactionMarker(t, s, sub)); len(frames) != 0 {
				t.Fatalf("goal custom entry published frames: %+v", frames)
			}
			if n := s.manager.journalLen(s.chatID); n != 0 {
				t.Fatalf("goal custom entries journaled: %d", n)
			}
		})
	}
}

func TestDispatchGoalActivationNotifyStaysSilent(t *testing.T) {
	for _, tc := range []struct {
		name, message, notifyType string
		shown                     bool
	}{
		{"activation", "Goal active\nObjective: finish task", "info", false},
		{"prefix", "Goal active", "info", false},
		{"tps", "TPS 42", "turn_stats", true},
		{"memory", "Memory usage 42 MB", "info", true},
		{"warning", "Budget nearly exhausted", "warning", true},
		{"non_prefix", "Status: Goal active", "info", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, sub := acquireDrained(t, "goal-notify-"+tc.name)
			injectEvent(t, s, map[string]any{"type": "extension_ui_request", "method": "notify", "message": tc.message, "notifyType": tc.notifyType})
			frames := dropAttachReady(publishCompactionMarker(t, s, sub))
			if !tc.shown {
				if len(frames) != 0 || s.manager.journalLen(s.chatID) != 0 || s.pendingApproval != nil {
					t.Fatalf("goal activation published or retained: frames=%+v journal=%d approval=%+v", frames, s.manager.journalLen(s.chatID), s.pendingApproval)
				}
				return
			}
			if len(frames) != 1 || frames[0].Kind != FrameNotice {
				t.Fatalf("notify frames = %+v, want one notice", frames)
			}
			data := frames[0].Data.(map[string]any)
			if data["kind"] != "engine_notify" || data["message"] != tc.message || data["notifyType"] != tc.notifyType {
				t.Fatalf("notify payload changed: %+v", data)
			}
		})
	}
}

func TestGoalNoticeJournalReplayFiltersRecordedRows(t *testing.T) {
	for _, kind := range []string{"goal-cache-warmup", "omo-loop:tick", "omo-cache-keepalive", "omo-rule-activation"} {
		t.Run(kind, func(t *testing.T) {
			dir := t.TempDir()
			mgr := NewManager(Config{NoticeDir: dir})
			mgr.RecordNotice("goal-replay", map[string]any{"kind": kind})
			mgr.RecordNotice("goal-replay", map[string]any{"kind": "engine_notify", "message": "Goal active\nObjective: finish task"})
			tps := mgr.RecordNotice("goal-replay", map[string]any{"kind": "engine_notify", "message": "TPS 42"})
			if file := readPersistedNotices(t, dir, "goal-replay"); len(file.Entries) != 3 {
				t.Fatalf("recorded entries = %d, want 3", len(file.Entries))
			}
			for _, source := range []*Manager{mgr, NewManager(Config{NoticeDir: dir})} {
				s, _ := acquireDrained(t, "goal-replay")
				s.manager = source
				late := &synchronousApprovalRecorder{recorder: newRecorder(16)}
				detach := s.Attach(late)
				frames := dropAttachReady(drainSync(late.recorder))
				detach()
				if !reflect.DeepEqual(frames, []Frame{tps}) {
					t.Fatalf("attach replay = %+v, want only TPS notice %+v", frames, tps)
				}
			}
		})
	}
}
