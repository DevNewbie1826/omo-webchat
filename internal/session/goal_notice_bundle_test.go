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

var goalActivationNotifyCases = []struct {
	name, message, notifyType string
	shown                     bool
}{
	{"activation", "Goal active\nObjective: finish task", "info", false},
	{"prefix", "Goal active", "info", false},
	{"tps", "TPS 42", "turn_stats", true},
	{"memory", "Memory usage 42 MB", "info", true},
	{"warning", "Budget nearly exhausted", "warning", true},
	{"non_prefix", "Status: Goal active", "info", true},
	{"prefix_warning", "Goal active count is inconsistent; manual intervention required", "warning", true},
	{"prefix_error", "Goal active checkpoint could not be saved", "error", true},
	{"word_collision", "Goal actively recovering from memory pressure", "info", true},
	{"heading_warning", "Goal active", "warning", true},
	{"heading_error", "Goal active", "error", true},
	{"multiline_warning", "Goal active\nObjective: finish task", "warning", true},
	{"multiline_error", "Goal active\nObjective: finish task", "error", true},
}

func TestDispatchGoalActivationNotifyStaysSilent(t *testing.T) {
	for _, tc := range goalActivationNotifyCases {
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

func TestGoalActivationNotifyReplayBoundaries(t *testing.T) {
	for _, tc := range goalActivationNotifyCases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			mgr := NewManager(Config{NoticeDir: dir})
			const chatID = "goal-boundary-replay"
			before := mgr.RecordNotice(chatID, map[string]any{"kind": "engine_notify", "message": "before"})
			candidate := mgr.RecordNotice(chatID, map[string]any{"kind": "engine_notify", "message": tc.message, "notifyType": tc.notifyType})
			after := mgr.RecordNotice(chatID, map[string]any{"kind": "engine_notify", "message": "after"})
			want := []Frame{before, after}
			if tc.shown {
				want = []Frame{before, candidate, after}
			}
			stored := readPersistedNotices(t, dir, chatID)
			for name, source := range map[string]*Manager{"memory": mgr, "disk": NewManager(Config{NoticeDir: dir})} {
				t.Run(name, func(t *testing.T) {
					s, _ := acquireDrained(t, chatID)
					s.manager = source
					late := &synchronousApprovalRecorder{recorder: newRecorder(16)}
					detach := s.Attach(late)
					frames := dropAttachReady(drainSync(late.recorder))
					detach()
					if !reflect.DeepEqual(frames, want) {
						t.Errorf("attach replay = %+v, want unchanged frames %+v", frames, want)
					}
					if seq := source.noticeJournal(chatID).seq; seq != stored.Seq {
						t.Errorf("replay sequence = %d, want %d", seq, stored.Seq)
					}
					if got := readPersistedNotices(t, dir, chatID); !reflect.DeepEqual(got, stored) {
						t.Error("attach changed persisted journal")
					}
				})
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
