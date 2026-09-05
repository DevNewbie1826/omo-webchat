package wsbridge

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"

	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
)

func TestTransparentIdleRecoveryBridgeExhaustedQuery(t *testing.T) {
	for _, fence := range []string{"current", "rebound", "cancelled"} {
		t.Run(fence, func(t *testing.T) {
			h := newInPlaceBridgeHarnessWithHistory(t, "exhausted-query", 3)
			conn, frames := h.connect(t)
			attachAndAwaitHistory(t, conn, frames, "exhausted-query")
			writeClient(t, conn, map[string]any{"type": "ping"})
			frames.next(t, "pong")
			clearCollector(frames)
			server := h.soleServerConnection(t)
			ws, chat, generation, stale := server.bindingSnapshot()
			before := h.daemon.OpenCount()
			h.daemon.EvictSessionSilently(h.path)
			calls := 0
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			server.queryRecovering(ctx, recoveryBinding{workspaceID: ws, stale: queryBinding{chatID: chat, generation: generation, session: stale}}, recoverableQuery{command: "get_commands", run: func(ctx context.Context, s *session.Session) error {
				calls++
				if calls == 2 {
					if fence == "cancelled" {
						cancel()
					} else {
						h.daemon.FailNext(omorpc.CmdGetCommands, omorpc.ErrCodeUnknownSession)
					}
				}
				err := server.queryCommands(ctx, s)
				if calls == 2 {
					if fence == "rebound" {
						server.unbind()
					}
				}
				return err
			}})
			writeClient(t, conn, map[string]any{"type": "ping"})
			frames.next(t, "pong")
			if calls != 2 || h.daemon.OpenCount()-before != 1 {
				t.Fatalf("unbounded query: calls=%d opens=%d", calls, h.daemon.OpenCount()-before)
			}
			frames.mu.Lock()
			defer frames.mu.Unlock()
			failures := 0
			for _, raw := range frames.frames {
				var f map[string]any
				_ = json.Unmarshal(raw, &f)
				if f["type"] == "commands" {
					t.Fatalf("false success: %s", raw)
				}
				if f["type"] == "error" {
					failures++
					if f["code"] != "resume_failed" || f["command"] != "get_commands" {
						t.Fatalf("wrong failure: %s", raw)
					}
				}
			}
			wantFailures := 0
			if fence == "current" {
				wantFailures = 1
			}
			if failures != wantFailures {
				t.Fatalf("exhausted query failures=%d, want %d; frames=%s", failures, wantFailures, frames.frames)
			}
		})
	}
}

func TestTransparentIdleRecoveryBridgePostBindingLoss(t *testing.T) {
	h := newInPlaceBridgeHarnessWithHistory(t, "post-binding-loss", 4)
	conn, frames := h.connect(t)
	attachAndAwaitHistory(t, conn, frames, "post-binding-loss")
	beforeOpen := h.daemon.OpenCount()
	beforeState := h.daemon.RequestCount(omorpc.CmdGetState)
	release := h.daemon.BlockHandlerForPath(omorpc.CmdGetState, h.path)
	defer release()
	refresh, replay := h.connect(t)
	writeClient(t, refresh, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "post-binding-loss"})
	if !h.daemon.AwaitRequestCount(omorpc.CmdGetState, beforeState+1, 5*time.Second) {
		t.Fatal("validated binding did not reach state barrier")
	}
	h.daemon.EvictSessionSilently(h.path)
	release()
	writeClient(t, refresh, map[string]any{"type": "ping"})
	replay.next(t, "pong")
	assertTerminalHistory(t, replay, 4)
	assertOrderedHistoryIDs(t, replay, []string{"root", "entry-1", "entry-2", "entry-3"})
	assertNoBridgeErrors(t, replay)
	if h.daemon.OpenCount()-beforeOpen != 1 {
		t.Fatalf("opens=%d", h.daemon.OpenCount()-beforeOpen)
	}
	writeClient(t, refresh, map[string]any{"type": "chat.commands", "sessionId": "post-binding-loss"})
	replay.next(t, "commands")
}

func assertOrderedHistoryIDs(t *testing.T, frames *collector, want []string) {
	t.Helper()
	frames.mu.Lock()
	defer frames.mu.Unlock()
	var ids []string
	for _, raw := range frames.frames {
		var f struct {
			Type    string `json:"type"`
			Entries []struct {
				ID string `json:"id"`
			} `json:"entries"`
		}
		if err := json.Unmarshal(raw, &f); err != nil {
			t.Fatal(err)
		}
		if f.Type == "entries" {
			for _, e := range f.Entries {
				ids = append(ids, e.ID)
			}
		}
	}
	if !reflect.DeepEqual(ids, want) {
		t.Fatalf("ordered history IDs=%v, want %v", ids, want)
	}
}

func TestTransparentIdleRecoveryBridgeSavedConversation(t *testing.T) {
	for _, provenance := range []string{cursorstore.SessionProvenanceNative, cursorstore.SessionProvenanceAdopted} {
		for _, notified := range []bool{false, true} {
			for _, action := range []string{"refresh", "query"} {
				for _, failure := range []string{"open", "identity"} {
					t.Run(fmt.Sprintf("%s/notified=%v/%s/%s", provenance, notified, action, failure), func(t *testing.T) {
						const chat = "saved-conversation"
						h := newInPlaceBridgeHarnessWithHistory(t, chat, 3)
						rec, err := h.store.GetChat(chat)
						if err != nil {
							t.Fatal(err)
						}
						rec.SessionProvenance = provenance
						if provenance == cursorstore.SessionProvenanceAdopted {
							body, err := os.ReadFile(h.path)
							if err != nil {
								t.Fatal(err)
							}
							if err := os.MkdirAll(h.store.OwnedSessionDir(), 0700); err != nil {
								t.Fatal(err)
							}
							h.path = filepath.Join(h.store.OwnedSessionDir(), "saved.jsonl")
							if err := os.WriteFile(h.path, body, 0600); err != nil {
								t.Fatal(err)
							}
							if err := h.daemon.LoadSessionFile(h.path); err != nil {
								t.Fatal(err)
							}
							rec.SessionFile = h.path
						}
						if err := h.store.SaveChat(rec); err != nil {
							t.Fatal(err)
						}
						conn, frames := h.connect(t)
						attachAndAwaitHistory(t, conn, frames, chat)
						writeClient(t, conn, map[string]any{"type": "ping"})
						frames.next(t, "pong")
						clearCollector(frames)
						original, err := (*CursorStore)(h.store).CursorFor(context.Background(), chat)
						if err != nil {
							t.Fatal(err)
						}
						if notified {
							h.daemon.EvictSessionWithEvent(h.path, "session_closed")
							h.markSessionResumable(t)
						} else {
							h.daemon.EvictSessionSilently(h.path)
						}
						if failure == "open" {
							h.daemon.FailOpenPath(h.path, omorpc.ErrCodeSessionPathInUse, 3)
						} else {
							h.daemon.OverrideNextOpenIdentity("rejected-identity")
						}
						before := len(h.daemon.Requests())
						beforeOpen := h.daemon.OpenCount()
						if action == "refresh" {
							writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": chat})
						} else {
							writeClient(t, conn, map[string]any{"type": "chat.commands", "sessionId": chat})
						}
						writeClient(t, conn, map[string]any{"type": "ping"})
						frames.next(t, "pong")
						failures := 0
						frames.mu.Lock()
						for _, raw := range frames.frames {
							var f map[string]any
							_ = json.Unmarshal(raw, &f)
							if f["type"] == "ready" || f["type"] == "entries" || f["type"] == "commands" {
								t.Errorf("rejected identity published success: %s", raw)
							}
							if f["type"] == "error" {
								failures++
								if f["code"] != "session-active" && f["code"] != "resume_failed" && f["code"] != "start_failed" {
									t.Errorf("wrong failure: %s", raw)
								}
								if action == "query" && f["command"] != "get_commands" {
									t.Errorf("uncorrelated failure: %s", raw)
								}
							}
						}
						frames.mu.Unlock()
						if failures != 1 {
							t.Fatalf("failures=%d", failures)
						}
						wantOpens := 1
						if failure == "open" {
							wantOpens = 3
						}
						if got := h.daemon.OpenCount() - beforeOpen; got != wantOpens {
							t.Fatalf("opens=%d want %d", got, wantOpens)
						}
						for _, r := range h.daemon.Requests()[before:] {
							if r["type"] == omorpc.CmdOpenSession && (r["sessionPath"] != original.SessionFile || r["cwd"] != rec.CWD) {
								t.Fatalf("new conversation fallback: %v", r)
							}
						}
						got, err := (*CursorStore)(h.store).CursorFor(context.Background(), chat)
						if err != nil {
							t.Fatal(err)
						}
						if got != original {
							t.Fatalf("cursor changed: %+v -> %+v", original, got)
						}
					})
				}
			}
		}
	}
}

func TestTransparentIdleRecoveryBridgeActivationFailure(t *testing.T) {
	h := newInPlaceBridgeHarnessWithHistory(t, "activation-failure", 3)
	conn, frames := h.connect(t)
	attachAndAwaitHistory(t, conn, frames, "activation-failure")
	writeClient(t, conn, map[string]any{"type": "ping"})
	frames.next(t, "pong")
	clearCollector(frames)
	server := h.soleServerConnection(t)
	ws, chat, generation, stale := server.bindingSnapshot()
	binding := recoveryBinding{workspaceID: ws, stale: queryBinding{chatID: chat, generation: generation, session: stale}}
	server.stateMu.Lock()
	oldSub := server.sub
	server.stateMu.Unlock()
	sub := newSubscriber(server)
	sub.Deliver(session.Frame{Kind: session.FrameReady, SessionID: stale.ID()})
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	detached := false
	if server.bindRecovered(ctx, &binding, &stagedRecovery{session: stale, sub: sub, detach: func() { detached = true }}) {
		t.Fatal("expired activation succeeded")
	}
	server.stateMu.Lock()
	valid := server.queryCurrentLocked(binding.stale) && server.sub == oldSub
	server.stateMu.Unlock()
	if !valid || !detached {
		t.Fatal("activation failure did not restore the valid current claim")
	}
	server.queryRecovering(ctx, binding, recoverableQuery{command: "get_commands", run: func(context.Context, *session.Session) error { return session.ErrSessionResumable }})
	writeClient(t, conn, map[string]any{"type": "ping"})
	frames.next(t, "pong")
	failure := frames.next(t, "error")
	if failure["code"] != "resume_failed" || failure["command"] != "get_commands" {
		t.Fatalf("lost current activation failure: %v", failure)
	}
	assertNoBridgeErrors(t, frames)
}
