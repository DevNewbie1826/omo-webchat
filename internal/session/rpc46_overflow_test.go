package session

import (
	"context"
	"fmt"
	"testing"
)

const rpc46OverflowError = "QA_OVERFLOW_RECOVERY_EXHAUSTED"

func TestRPC46OverflowStandaloneDiagnostic(t *testing.T) {
	for _, id := range []string{"", "new-terminal", "auto-1"} {
		for _, successor := range []string{"none", "unpaired-manual", "paired-manual"} {
			t.Run(id+"/"+successor, func(t *testing.T) {
				d := newDaemon(t)
				mgr := testManager(t, dial(t, d), newMemStore(), 64)
				sub := newRecorder(64)
				s, _, _ := acquire(t, mgr, testChat{id: "overflow", cwd: t.TempDir()}, sub)
				sub.next(t)
				injectEvent(t, s, map[string]any{"type": "agent_start"})
				sub.await(t, FrameRunStarted)
				injectEvent(t, s, map[string]any{"type": "compaction_start", "reason": "overflow", "requestId": "auto-1"})
				sub.await(t, FrameCompactionStart)
				injectEvent(t, s, map[string]any{"type": "compaction_end", "reason": "overflow", "requestId": "auto-1", "willRetry": true})
				sub.await(t, FrameCompactionDone)
				injectEvent(t, s, map[string]any{"type": "message_delta", "delta": "continued attempt"})
				sub.await(t, FrameMessageDelta)

				var result chan error
				var release func()
				var manualID string
				if successor != "none" {
					injectEvent(t, s, map[string]any{"type": "agent_settled", "reason": "end_turn"})
					sub.await(t, FrameRunDone)
					release = d.BlockHandler("compact")
					defer release()
					result = make(chan error, 1)
					go func() { result <- s.Compact(context.Background()) }()
					if !d.AwaitRequestCount("compact", 1, testTimeout) {
						t.Fatal("manual successor did not reach provider")
					}
					_, start := sub.await(t, FrameCompactionStart)
					manualID = start.RequestID
					if successor == "paired-manual" {
						injectEvent(t, s, map[string]any{"type": "compaction_start", "reason": "manual", "requestId": "manual-provider"})
					}
				}
				before := s.RunSnapshot()
				injectEvent(t, s, map[string]any{"type": "compaction_end", "reason": "overflow", "requestId": id, "willRetry": false, "errorMessage": rpc46OverflowError})
				frames := publishCompactionMarker(t, s, sub)
				got := counts(frames)
				if got[FrameNotice] != 1 {
					t.Errorf("explicit terminal overflow diagnostic: got %d notices, want 1; frames=%+v", got[FrameNotice], frames)
				}
				if got[FrameCompactionDone] != 0 || got[FrameRunDone] != 0 {
					t.Errorf("standalone diagnostic synthesized lifecycle completion: %+v", frames)
				}
				for _, frame := range frames {
					if frame.Kind == FrameNotice {
						data := frame.Data.(map[string]any)
						if data["kind"] != "compaction_error" || data["message"] != rpc46OverflowError || data["reason"] != "overflow" || data["willRetry"] != false || data["requestId"] != id {
							t.Errorf("diagnostic payload lost RPC detail: %+v", data)
						}
					}
				}
				if after := s.RunSnapshot(); after != before {
					t.Errorf("standalone diagnostic changed ownership: before=%+v after=%+v", before, after)
				}
				if release != nil {
					release()
					awaitCompactionCall(t, result)
					// A mismatched terminal must not consume the manual RPC's completion.
					if got[FrameCompactionDone] == 0 {
						_, done := sub.await(t, FrameCompactionDone)
						if done.RequestID != manualID {
							t.Errorf("manual completion id=%q, want %q", done.RequestID, manualID)
						}
					}
				}
			})
		}
	}
}

func TestRPC46OverflowMatchedErrorHasOnePresentation(t *testing.T) {
	d := newDaemon(t)
	mgr := testManager(t, dial(t, d), newMemStore(), 64)
	sub := newRecorder(32)
	s, _, _ := acquire(t, mgr, testChat{id: "matched-overflow", cwd: t.TempDir()}, sub)
	sub.next(t)
	injectEvent(t, s, map[string]any{"type": "agent_start"})
	sub.await(t, FrameRunStarted)
	injectEvent(t, s, map[string]any{"type": "compaction_start", "reason": "overflow", "requestId": "auto-1"})
	sub.await(t, FrameCompactionStart)
	injectEvent(t, s, map[string]any{"type": "compaction_end", "reason": "overflow", "requestId": "auto-1", "willRetry": false, "errorMessage": rpc46OverflowError})
	frames := publishCompactionMarker(t, s, sub)
	got := counts(frames)
	if got[FrameCompactionDone] != 1 || got[FrameNotice] != 0 || got[FrameRunDone] != 0 {
		t.Fatalf("matched error duplicated or lost: %+v", frames)
	}
	for _, f := range frames {
		if f.Kind == FrameCompactionDone && f.Data.(CompactionInfo).Error != rpc46OverflowError {
			t.Fatalf("matched diagnostic lost: %+v", f)
		}
	}
	if !s.RunSnapshot().Streaming || s.RunSnapshot().Compacting {
		t.Fatal("matched compaction error settled provider run or retained compaction")
	}
}

func TestRPC46OverflowUnmatchedSuccessIsSilent(t *testing.T) {
	d := newDaemon(t)
	mgr := testManager(t, dial(t, d), newMemStore(), 64)
	sub := newRecorder(32)
	s, _, _ := acquire(t, mgr, testChat{id: "silent-overflow", cwd: t.TempDir()}, sub)
	sub.next(t)
	injectEvent(t, s, map[string]any{"type": "compaction_end", "reason": "overflow", "willRetry": false})
	if frames := publishCompactionMarker(t, s, sub); len(frames) != 0 {
		t.Fatalf("unmatched success emitted frames: %+v", frames)
	}
}

// Both initial presentation paths must survive replay while ownership moves to
// a held manual successor, including a provider start during that manual RPC.
func TestRPC46OverflowDiagnosticReplay(t *testing.T) {
	for _, first := range []string{"matched", "standalone"} {
		for _, id := range []string{"", "new-terminal", "auto-1"} {
			for _, successor := range []string{"none", "unpaired-manual", "paired-manual"} {
				t.Run(first+"/"+id+"/"+successor, func(t *testing.T) {
					d := newDaemon(t)
					mgr := testManager(t, dial(t, d), newMemStore(), 64)
					sub := newRecorder(64)
					s, _, _ := acquire(t, mgr, testChat{id: "replay", cwd: t.TempDir()}, sub)
					sub.next(t)
					startID := id
					if first == "standalone" {
						startID = "auto-1"
					}
					injectEvent(t, s, map[string]any{"type": "compaction_start", "reason": "overflow", "requestId": startID})
					sub.await(t, FrameCompactionStart)
					if first == "standalone" {
						injectEvent(t, s, map[string]any{"type": "compaction_end", "reason": "overflow", "requestId": startID, "willRetry": true})
						sub.await(t, FrameCompactionDone)
					}
					terminal := map[string]any{"type": "compaction_end", "reason": "overflow", "willRetry": false, "errorMessage": rpc46OverflowError}
					if id != "" {
						terminal["requestId"] = id
					}
					injectEvent(t, s, terminal)
					initial := publishCompactionMarker(t, s, sub)
					want := FrameNotice
					if first == "matched" {
						want = FrameCompactionDone
					}
					if len(initial) != 1 || initial[0].Kind != want {
						t.Fatalf("first presentation: %+v, want %s", initial, want)
					}
					if want == FrameCompactionDone && initial[0].Data.(CompactionInfo).Error != rpc46OverflowError {
						t.Fatalf("matched error lost: %+v", initial)
					}
					if want == FrameNotice && initial[0].Data.(map[string]any)["message"] != rpc46OverflowError {
						t.Fatalf("standalone error lost: %+v", initial)
					}
					var release func()
					var result chan error
					var manualID string
					if successor != "none" {
						release = d.BlockHandler("compact")
						defer release()
						result = make(chan error, 1)
						go func() { result <- s.Compact(context.Background()) }()
						if !d.AwaitRequestCount("compact", 1, testTimeout) {
							t.Fatal("manual successor did not reach provider")
						}
						_, start := sub.await(t, FrameCompactionStart)
						manualID = start.RequestID
						if successor == "paired-manual" {
							injectEvent(t, s, map[string]any{"type": "compaction_start", "reason": "manual", "requestId": "manual-provider"})
						}
					}
					injectEvent(t, s, map[string]any{"type": "agent_start"})
					sub.await(t, FrameRunStarted)
					for replay := 0; replay < 2; replay++ {
						before := s.RunSnapshot()
						injectEvent(t, s, terminal)
						if frames := publishCompactionMarker(t, s, sub); len(frames) != 0 {
							t.Errorf("replay %d added a presentation or completion: %+v", replay, frames)
						}
						if after := s.RunSnapshot(); after != before {
							t.Errorf("replay changed ownership: before=%+v after=%+v", before, after)
						}
					}
					injectEvent(t, s, map[string]any{"type": "agent_settled", "reason": "end_turn"})
					sub.await(t, FrameRunDone)
					if s.RunSnapshot().Compacting != (successor != "none") {
						t.Error("settlement changed manual ownership")
					}
					injectEvent(t, s, terminal)
					if frames := publishCompactionMarker(t, s, sub); len(frames) != 0 {
						t.Errorf("replay after settlement added frames: %+v", frames)
					}
					if release != nil {
						release()
						awaitCompactionCall(t, result)
						_, done := sub.await(t, FrameCompactionDone)
						if done.RequestID != manualID {
							t.Errorf("manual completion id=%q, want %q", done.RequestID, manualID)
						}
					}
				})
			}
		}
	}
}

func TestRPC46OverflowUnmatchedContract(t *testing.T) {
	for _, tc := range []struct {
		name, field string
		value       any
	}{
		{"missing-reason", "reason", nil},
		{"manual", "reason", "manual"},
		{"threshold", "reason", "threshold"},
		{"missing-willRetry", "willRetry", nil},
		{"retrying", "willRetry", true},
		{"string-willRetry", "willRetry", "false"},
		{"number-willRetry", "willRetry", 0},
		{"object-willRetry", "willRetry", map[string]any{}},
		{"alias", "type", "compaction_done"},
		{"success", "errorMessage", nil},
		{"empty-error", "errorMessage", ""},
		{"malformed-error", "errorMessage", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := newDaemon(t)
			mgr := testManager(t, dial(t, d), newMemStore(), 64)
			sub := newRecorder(32)
			s, _, _ := acquire(t, mgr, testChat{id: "contract", cwd: t.TempDir()}, sub)
			sub.next(t)
			terminal := map[string]any{"type": "compaction_end", "reason": "overflow", "willRetry": false, "errorMessage": rpc46OverflowError}
			terminal[tc.field] = tc.value
			if tc.value == nil {
				delete(terminal, tc.field)
			}
			before := s.RunSnapshot()
			injectEvent(t, s, terminal)
			if frames := publishCompactionMarker(t, s, sub); len(frames) != 0 {
				t.Errorf("out-of-contract unmatched event emitted frames: %+v", frames)
			}
			if s.RunSnapshot() != before {
				t.Error("unmatched event changed ownership")
			}
		})
	}
}

func TestRPC46OverflowNewRecoveryCycleSameDiagnostic(t *testing.T) {
	for _, idKind := range []string{"absent", "completed", "new"} {
		t.Run(idKind, func(t *testing.T) {
			d := newDaemon(t)
			mgr := testManager(t, dial(t, d), newMemStore(), 64)
			sub := newRecorder(32)
			s, _, _ := acquire(t, mgr, testChat{id: "new-cycle", cwd: t.TempDir()}, sub)
			sub.next(t)
			for _, cycleID := range []string{"auto-1", "auto-2"} {
				id := ""
				switch idKind {
				case "completed":
					id = cycleID // Reuse this cycle's successful retry-end ID, not a prior failure's ID.
				case "new":
					id = "terminal-" + cycleID
				}
				injectEvent(t, s, map[string]any{"type": "compaction_start", "reason": "overflow", "requestId": cycleID})
				sub.await(t, FrameCompactionStart)
				injectEvent(t, s, map[string]any{"type": "compaction_end", "reason": "overflow", "requestId": cycleID, "willRetry": true})
				sub.await(t, FrameCompactionDone)
				terminal := map[string]any{"type": "compaction_end", "reason": "overflow", "requestId": id, "willRetry": false, "errorMessage": rpc46OverflowError}
				injectEvent(t, s, terminal)
				frames := publishCompactionMarker(t, s, sub)
				if len(frames) != 1 || frames[0].Kind != FrameNotice || frames[0].Data.(map[string]any)["message"] != rpc46OverflowError {
					t.Fatalf("new cycle %s suppressed or changed diagnostic: %+v", cycleID, frames)
				}
				injectEvent(t, s, terminal)
				if frames := publishCompactionMarker(t, s, sub); len(frames) != 0 {
					t.Errorf("cycle %s replay emitted frames: %+v", cycleID, frames)
				}
			}
		})
	}
}

func TestRPC46OverflowDiagnosticWindowIsBounded(t *testing.T) {
	d := newDaemon(t)
	mgr := testManager(t, dial(t, d), newMemStore(), 64)
	sub := newRecorder(32)
	s, _, _ := acquire(t, mgr, testChat{id: "bounded", cwd: t.TempDir()}, sub)
	sub.next(t)
	terminal := func(id int) map[string]any {
		return map[string]any{"type": "compaction_end", "reason": "overflow", "requestId": fmt.Sprintf("terminal-%d", id), "willRetry": false, "errorMessage": rpc46OverflowError}
	}
	for id := 0; id <= maxCompletedCompactions; id++ {
		injectEvent(t, s, terminal(id))
		if frames := publishCompactionMarker(t, s, sub); len(frames) != 1 || frames[0].Kind != FrameNotice {
			t.Fatalf("distinct terminal %d suppressed: %+v", id, frames)
		}
	}
	injectEvent(t, s, terminal(maxCompletedCompactions))
	if frames := publishCompactionMarker(t, s, sub); len(frames) != 0 {
		t.Errorf("recent replay emitted frames: %+v", frames)
	}
	// The oldest terminal falls outside the bounded presentation window.
	injectEvent(t, s, terminal(0))
	if frames := publishCompactionMarker(t, s, sub); len(frames) != 1 || frames[0].Kind != FrameNotice {
		t.Errorf("oldest diagnostic retained beyond bounded window: %+v", frames)
	}
}

func TestRPC46OverflowMatchedLegacyContract(t *testing.T) {
	for _, eventType := range []string{"compaction_end", "compaction_done"} {
		for _, reason := range []string{"", "threshold", "overflow"} {
			t.Run(eventType+"/"+reason, func(t *testing.T) {
				d := newDaemon(t)
				mgr := testManager(t, dial(t, d), newMemStore(), 64)
				sub := newRecorder(32)
				s, _, _ := acquire(t, mgr, testChat{id: "legacy", cwd: t.TempDir()}, sub)
				sub.next(t)
				injectEvent(t, s, map[string]any{"type": "compaction_start", "reason": "threshold", "requestId": "legacy"})
				sub.await(t, FrameCompactionStart)
				// Legacy matching does not require willRetry or a reason.
				terminal := map[string]any{"type": eventType, "requestId": "legacy", "errorMessage": rpc46OverflowError}
				if reason != "" {
					terminal["reason"] = reason
				}
				injectEvent(t, s, terminal)
				frames := publishCompactionMarker(t, s, sub)
				if len(frames) != 1 || frames[0].Kind != FrameCompactionDone || frames[0].Data.(CompactionInfo).Error != rpc46OverflowError {
					t.Fatalf("matched legacy failure changed: %+v", frames)
				}
			})
		}
	}
}

func TestRPC46OverflowPriorDiagnosticSurvivesNewAutomaticCycle(t *testing.T) {
	for _, first := range []string{"matched", "standalone"} {
		t.Run(first, func(t *testing.T) {
			d := newDaemon(t)
			mgr := testManager(t, dial(t, d), newMemStore(), 64)
			sub := newRecorder(32)
			s, _, _ := acquire(t, mgr, testChat{id: "prior-cycle", cwd: t.TempDir()}, sub)
			sub.next(t)
			injectEvent(t, s, map[string]any{"type": "agent_start"})
			sub.await(t, FrameRunStarted)
			injectEvent(t, s, map[string]any{"type": "compaction_start", "reason": "overflow", "requestId": "failed-1"})
			sub.await(t, FrameCompactionStart)
			if first == "standalone" {
				injectEvent(t, s, map[string]any{"type": "compaction_end", "reason": "overflow", "requestId": "failed-1", "willRetry": true})
				sub.await(t, FrameCompactionDone)
			}
			prior := map[string]any{"type": "compaction_end", "reason": "overflow", "requestId": "failed-1", "willRetry": false, "errorMessage": rpc46OverflowError}
			injectEvent(t, s, prior)
			initial := publishCompactionMarker(t, s, sub)
			want := FrameCompactionDone
			if first == "standalone" {
				want = FrameNotice
			}
			if len(initial) != 1 || initial[0].Kind != want {
				t.Fatalf("first failure presentation: %+v, want %s", initial, want)
			}
			injectEvent(t, s, map[string]any{"type": "compaction_start", "reason": "overflow", "requestId": "new-auto-2"})
			sub.await(t, FrameCompactionStart)
			before := s.RunSnapshot()
			if !before.Streaming || !before.Compacting {
				t.Fatalf("new automatic owner was not active: %+v", before)
			}
			injectEvent(t, s, prior)
			if frames := publishCompactionMarker(t, s, sub); len(frames) != 0 {
				t.Errorf("prior named failure replay during new automatic cycle emitted frames: %+v", frames)
			}
			if after := s.RunSnapshot(); after != before {
				t.Errorf("prior replay changed current owner: before=%+v after=%+v", before, after)
			}
			// Identical text with the current owner's new ID remains a new error.
			injectEvent(t, s, map[string]any{"type": "compaction_end", "reason": "overflow", "requestId": "new-auto-2", "willRetry": false, "errorMessage": rpc46OverflowError})
			current := publishCompactionMarker(t, s, sub)
			if len(current) != 1 || current[0].Kind != FrameCompactionDone || current[0].RequestID != "new-auto-2" || current[0].Data.(CompactionInfo).Error != rpc46OverflowError {
				t.Fatalf("new owner lost its correlated failure: %+v", current)
			}
			if after := s.RunSnapshot(); !after.Streaming || after.Compacting {
				t.Errorf("current completion changed provider run ownership: %+v", after)
			}
		})
	}
}
