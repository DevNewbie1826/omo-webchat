package session

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// Fixtures mirror the observed engine contract; payloads are the public wire API.
func TestNoticeDerivationDispatch(t *testing.T) {
	cases := []struct {
		name   string
		events []string
		want   []string
	}{
		{"compaction", []string{`{"type":"compaction_end","accepted":true,"requestId":"c1","result":{"summary":"kept context","tokensBefore":42000,"usage":{"input":6000,"output":500,"cacheRead":200,"cacheWrite":100,"cost":{"total":0.125}}}}`}, []string{`{"kind":"compaction_summary","summary":"kept context","tokensBefore":42000}`, `{"kind":"compaction_cost","text":"Compaction: 6.8K tokens billed (~$0.13)"}`}},
		{"no usage", []string{`{"type":"compaction_end","accepted":true,"result":{"summary":"s","tokensBefore":999}}`}, []string{`{"kind":"compaction_summary","summary":"s","tokensBefore":999}`}},
		{"failed compaction", []string{`{"type":"compaction_end","errorMessage":"aborted"}`}, nil},
		{"rejected compaction", []string{`{"type":"compaction_end","accepted":false,"result":{"summary":"s","tokensBefore":1}}`}, nil},
		{"thinking singular", []string{`{"type":"message_end","message":{"role":"assistant","stopReason":"stop","diagnostics":[{"type":"anthropic_input_transformations","details":{"transformations":[{"type":"thinking_dropped","reason":"signature","path":"messages[0]"}]}}]}}`}, []string{`{"kind":"thinking_dropped","text":"Anthropic dropped thinking block: signature at messages[0]"}`}},
		{"thinking plural", []string{`{"type":"message_end","message":{"role":"assistant","diagnostics":[{"type":"anthropic_input_transformations","details":{"transformations":[{"type":"thinking_dropped"},{"type":"other"},{"type":"thinking_dropped","reason":"invalid"}]}}]}}`}, []string{`{"kind":"thinking_dropped","text":"Anthropic dropped 2 thinking blocks: unknown reason; invalid"}`}},
		{"aborted thinking", []string{`{"type":"message_end","message":{"role":"assistant","stopReason":"aborted","diagnostics":[{"type":"anthropic_input_transformations","details":{"transformations":[{"type":"thinking_dropped"}]}}]}}`}, nil},
		{"healthy continuity", []string{`{"type":"message_end","message":{"role":"assistant","diagnostics":[{"type":"claude_sdk_oauth_session_continuity","details":{"kind":"resumed"}}]}}`}, nil},
		{"continuity first even error", []string{`{"type":"message_end","message":{"role":"assistant","stopReason":"error","diagnostics":[{"type":"claude_sdk_oauth_session_continuity","details":{"kind":"flatten","reason":"expired","payloadBytes":1536,"collapsedDirectives":2}},{"type":"claude_sdk_oauth_resume_fallback","details":{}}]}}`}, []string{`{"kind":"continuity_notice","text":"Session continuity lost - resent the full conversation (expired) - sent 1.5KB, 2 duplicate ultrawork blocks collapsed"}`}},
		{"resume fallback", []string{`{"type":"message_end","message":{"role":"assistant","diagnostics":[{"type":"claude_sdk_oauth_resume_fallback","details":{"payloadBytes":1048576}}]}}`}, []string{`{"kind":"continuity_notice","text":"Session continuity lost - resume failed, resent the full conversation - sent 1.0MB"}`}},
		{"disabled once", []string{`{"type":"message_end","message":{"role":"assistant","timestamp":1,"diagnostics":[{"type":"claude_sdk_oauth_session_continuity","details":{"kind":"disabled"}}]}}`, `{"type":"message_end","message":{"role":"assistant","timestamp":2,"diagnostics":[{"type":"claude_sdk_oauth_session_continuity","details":{"kind":"disabled"}},{"type":"claude_sdk_oauth_resume_fallback"}]}}`}, []string{`{"kind":"continuity_notice","text":"Session continuity disabled (resumeMode: off) - resending the conversation each turn"}`}},
		{"extension", []string{`{"type":"extension_error","sessionId":"route","extensionPath":"plugin.ts","error":"exact error","event":"tool_call"}`}, []string{`{"kind":"extension_error","extensionPath":"plugin.ts","error":"exact error","event":"tool_call"}`}},
		{"extension optional", []string{`{"type":"extension_error","extensionPath":"plugin.ts","error":"exact error"}`}, []string{`{"kind":"extension_error","extensionPath":"plugin.ts","error":"exact error"}`}},
		{"warning entry dedupe", []string{`{"type":"entry_appended","entry":{"type":"model_change_rejected","id":"w1","detail":"Use a larger context","reason":"context-budget"}}`, `{"type":"entry_appended","entry":{"type":"model_change_rejected","id":"w1","detail":"Use a larger context","reason":"context-budget"}}`, `{"type":"entry_appended","entry":{"type":"model_change_rejected","id":"w2","reason":"auth"}}`}, []string{`{"kind":"engine_warning","text":"Use a larger context"}`, `{"kind":"engine_warning","text":"auth"}`}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s, sub := acquireDrained(t, "derive-"+tc.name)
			dir := persistDerivedNotices(t, s)
			for _, event := range tc.events {
				var raw map[string]any
				if err := json.Unmarshal([]byte(event), &raw); err != nil {
					t.Fatal(err)
				}
				injectEvent(t, s, raw)
			}
			assertDerivedPayloads(t, publishCompactionMarker(t, s, sub), tc.want)
			replay := s.manager.noticeReplay(s.chatID)
			assertDerivedPayloads(t, replay, tc.want)
			late := &synchronousApprovalRecorder{recorder: newRecorder(32)}
			detach := s.Attach(late)
			defer detach()
			assertDerivedPayloads(t, drainSync(late.recorder), tc.want)
			assertDerivedRestart(t, s, dir)
		})
	}
}

func assertDerivedPayloads(t *testing.T, frames []Frame, want []string) {
	t.Helper()
	var got []map[string]any
	for _, f := range frames {
		if f.Kind != FrameNotice {
			continue
		}
		p := cloneAnyMap(f.Data.(map[string]any))
		if stringValue(p["nid"]) == "" || stringValue(p["at"]) == "" {
			t.Fatalf("unstamped payload: %v", p)
		}
		delete(p, "nid")
		delete(p, "at")
		got = append(got, p)
	}
	var expected []map[string]any
	for _, text := range want {
		var p map[string]any
		if err := json.Unmarshal([]byte(text), &p); err != nil {
			t.Fatal(err)
		}
		expected = append(expected, p)
	}
	if !reflect.DeepEqual(got, expected) {
		t.Fatalf("payloads = %#v, want %#v", got, expected)
	}
}

func cacheMessage(ts int, model string, input, read, write, paid, readCost float64) map[string]any {
	return map[string]any{"type": "message_end", "message": map[string]any{"role": "assistant", "provider": "p", "model": model, "timestamp": ts, "stopReason": "stop", "usage": map[string]any{"input": input, "output": 1, "cacheRead": read, "cacheWrite": write, "cost": map[string]any{"input": paid, "cacheWrite": 0, "cacheRead": readCost}}}}
}

func TestNoticeDerivationCache(t *testing.T) {
	cases := []struct {
		name          string
		prev, current map[string]any
		reset         string
		want          string
	}{
		{"plain", cacheMessage(1, "m", 0, 30000, 0, 0, 0.03), cacheMessage(2, "m", 30000, 0, 0, 0.3, 0), "", "Cache miss: 30K tokens re-billed(~$0.30)"},
		{"model before idle", cacheMessage(1, "m", 0, 30000, 0, 0, 0), cacheMessage(600001, "other", 30000, 0, 0, 0, 0), "", "Cache miss after model switch: 30K tokens re-billed"},
		{"idle boundary", cacheMessage(1, "m", 0, 30000, 0, 0, 0), cacheMessage(300001, "m", 30000, 0, 0, 0, 0), "", "Cache miss after 5m idle: 30K tokens re-billed"},
		{"sub threshold", cacheMessage(1, "m", 0, 19999, 0, 0, 0), cacheMessage(2, "m", 19999, 0, 0, 0.099, 0), "", ""},
		{"noise", cacheMessage(1, "m", 0, 1024, 0, 0, 0), cacheMessage(2, "m", 1024, 0, 0, 1, 0), "", ""},
		{"cost boundary", cacheMessage(1, "m", 0, 2000, 0, 0, 0), cacheMessage(2, "m", 2000, 0, 0, 0.1, 0), "", "Cache miss: 2K tokens re-billed(~$0.10)"},
		{"token boundary", cacheMessage(1, "m", 0, 20000, 0, 0, 0), cacheMessage(2, "m", 20000, 0, 0, 0, 0), "", "Cache miss: 20K tokens re-billed"},
		{"no cache ever", cacheMessage(1, "m", 30000, 0, 0, 0, 0), cacheMessage(2, "m", 30000, 0, 0, 1, 0), "", ""},
		{"zero prompt", cacheMessage(1, "m", 0, 30000, 0, 0, 0), cacheMessage(2, "m", 0, 0, 0, 0, 0), "", ""},
		{"minimum prompt", cacheMessage(1, "m", 0, 10000, 0, 0, 0), cacheMessage(2, "m", 30000, 0, 0, 0, 0), "", ""},
		{"read rate", cacheMessage(1, "m", 0, 40000, 0, 0, 0), cacheMessage(2, "m", 20000, 20000, 0, 0.4, 0.1), "", "Cache miss: 20K tokens re-billed(~$0.30)"},
		{"write tokens", cacheMessage(1, "m", 0, 0, 30000, 0, 0), cacheMessage(2, "m", 0, 0, 30000, 0.3, 0), "", "Cache miss: 30K tokens re-billed(~$0.30)"},
		{"compaction reset", cacheMessage(1, "m", 0, 30000, 0, 0, 0), cacheMessage(2, "m", 30000, 0, 0, 1, 0), "compaction", ""},
		{"branch reset", cacheMessage(1, "m", 0, 30000, 0, 0, 0), cacheMessage(2, "m", 30000, 0, 0, 1, 0), "branch_summary", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s, sub := acquireDrained(t, "cache-"+tc.name)
			dir := persistDerivedNotices(t, s)
			injectEvent(t, s, tc.prev)
			if tc.reset != "" {
				injectEvent(t, s, map[string]any{"type": "entry_appended", "entry": map[string]any{"type": tc.reset, "id": "reset"}})
			}
			injectEvent(t, s, tc.current)
			injectEvent(t, s, tc.current)
			var want []string
			if tc.want != "" {
				b, _ := json.Marshal(map[string]any{"kind": "cache_miss", "text": tc.want})
				want = []string{string(b)}
			}
			assertDerivedPayloads(t, publishCompactionMarker(t, s, sub), want)
			assertDerivedRestart(t, s, dir)
		})
	}
}

func TestNoticeDerivationHydration(t *testing.T) {
	for _, n := range []int{0, 1, 2, entriesPageMaxCount + 1} {
		t.Run(fmt.Sprint(n), func(t *testing.T) {
			cwd := t.TempDir()
			path := filepath.Join(cwd, "history.jsonl")
			body := fmt.Sprintf("{\"type\":\"session\",\"id\":\"durable\",\"version\":3,\"cwd\":%q}\n", cwd)
			body += "{\"type\":\"message\",\"id\":\"root\",\"parentId\":null,\"message\":{\"role\":\"user\",\"content\":\"hello\"}}\n"
			parent := "root"
			for i := 0; i < n; i++ {
				if i == 1 {
					parent = "root" // Count compactions outside the selected branch too.
				}
				id := fmt.Sprintf("c%d", i)
				body += fmt.Sprintf("{\"type\":\"compaction\",\"id\":%q,\"parentId\":%q,\"summary\":\"s\",\"tokensBefore\":100,\"firstKeptEntryId\":\"root\"}\n", id, parent)
				parent = id
			}
			body += fmt.Sprintf("{\"type\":\"model_change_rejected\",\"id\":\"warning\",\"parentId\":%q,\"reason\":\"auth\",\"detail\":\"Authenticate first\"}\n", parent)
			if err := os.WriteFile(path, []byte(body), 0600); err != nil {
				t.Fatal(err)
			}
			d := newDaemon(t)
			if err := d.LoadSessionFile(path); err != nil {
				t.Fatal(err)
			}
			store := newMemStore()
			store.cursors["history"] = Cursor{SessionFile: path, DurableSessionID: "durable", InPlace: true}
			mgr := testManager(t, dial(t, d), store, 64)
			mgr.cfg.NoticeDir = t.TempDir()
			sub := newRecorder(64)
			s, _, detach := acquire(t, mgr, testChat{id: "history", cwd: cwd}, sub)
			defer detach()
			sub.await(t, FrameEntries)
			want := []string{`{"kind":"engine_warning","text":"Authenticate first"}`}
			if n > 0 {
				unit := "times"
				if n == 1 {
					unit = "time"
				}
				want = append(want, fmt.Sprintf(`{"kind":"compaction_history","text":"Session compacted %d %s"}`, n, unit))
			}
			assertDerivedPayloads(t, mgr.noticeReplay(s.chatID), want)
			if err := s.hydrateEntriesValidated(context.Background(), path, nil, nil); err != nil {
				t.Fatal(err)
			}
			assertDerivedPayloads(t, mgr.noticeReplay(s.chatID), want)
			assertDerivedRestart(t, s, mgr.cfg.NoticeDir)
		})
	}
}
