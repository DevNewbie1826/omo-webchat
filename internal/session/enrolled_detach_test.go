package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func TestEnrolledDetach(t *testing.T) {
	for _, path := range []string{"idle_evict", "stop", "close_all", "drift_recovery"} {
		t.Run(path, func(t *testing.T) {
			// Given an external retained owner plus one webchat attachment.
			h := newEnrolledHarness(t)
			s, _, detach := h.attach()
			detach()
			// When this lifecycle path releases the webchat view.
			switch path {
			case "idle_evict":
				h.m.evict(s)
			case "stop":
				mustOK(t, h.m.StopContext(t.Context(), h.chat.id))
			case "close_all":
				mustOK(t, h.m.CloseAll(t.Context()))
			case "drift_recovery":
				s.lifecycleMu.Lock()
				s.quarantineErr = &ExternalWriteError{Reason: "controlled external drift"}
				s.lifecycleMu.Unlock()
				recovered, _, release, err := h.m.AcquireInitializedWithRecovery(t.Context(), h.chat, nil, nil)
				mustOK(t, err)
				defer release()
				if recovered == s || recovered.client == h.main {
					t.Fatal("drift recovery did not replace the dedicated binding")
				}
				mustOK(t, h.m.StopContext(t.Context(), h.chat.id))
			}
			// Then no explicit end was sent and the owner remains attached/live.
			h.assertDetached()
		})
	}

	t.Run("attach_open_error", func(t *testing.T) {
		h := newEnrolledHarness(t)
		before := h.d.RequestCount(omorpc.CmdOpenSession)
		h.d.FailNext(omorpc.CmdOpenSession, omorpc.ErrCodeOpenFailed)
		_, _, _, err := h.m.Acquire(t.Context(), h.chat, nil)
		var typed *ErrEnrolledAttach
		if !errors.As(err, &typed) {
			t.Fatalf("open failure=%v, want typed ErrEnrolledAttach", err)
		}
		if got := h.d.RequestCount(omorpc.CmdOpenSession) - before; got != 1 {
			t.Fatalf("failed dedicated attach issued %d opens, want 1 and no owned main fallback", got)
		}
		h.assertDetached()
	})

	t.Run("attach_timeout", func(t *testing.T) {
		h := newEnrolledHarness(t)
		before := h.d.RequestCount(omorpc.CmdOpenSession)
		held, release := make(chan struct{}), make(chan struct{})
		unblock := sync.OnceFunc(func() { close(release) })
		defer unblock()
		p := newEnrolledWireProxy(t, h.d.SocketPath(), func(frame map[string]any) {
			if enrolledOpenData(frame) != nil {
				close(held)
				<-release
			}
		})
		h.m.cfg.DialAttach = func(ctx context.Context) (*omorpc.Client, error) {
			c, err := omorpc.DialWithConfig(ctx, p.path, omorpc.Config{NoReconnect: true, EventBuffer: 1024})
			if c != nil {
				t.Cleanup(func() { _ = c.Close() })
			}
			return c, err
		}
		ctx := &enrolledExpiryContext{Context: t.Context(), expired: make(chan struct{})}
		expire := sync.OnceFunc(func() { close(ctx.expired) })
		defer expire()
		done := make(chan enrolledAcquireResult, 1)
		go func() {
			s, _, detach, err := h.m.Acquire(ctx, h.chat, nil)
			done <- enrolledAcquireResult{s: s, detach: detach, err: err}
		}()
		select {
		case <-held:
		case <-time.After(testTimeout):
			t.Fatal("attach timeout did not reach the held-response barrier")
		}
		if h.d.Attachments(h.opened.State.SessionFile) != 2 {
			t.Fatal("timeout barrier did not hold an applied external attachment")
		}
		expire()
		got := awaitEnrolledAcquire(t, done)
		var typed *ErrEnrolledAttach
		if !errors.As(got.err, &typed) || !errors.Is(got.err, context.DeadlineExceeded) {
			t.Fatalf("attach timeout=%v, want typed deadline", got.err)
		}
		if got := h.d.RequestCount(omorpc.CmdOpenSession) - before; got != 1 {
			t.Fatalf("timeout issued %d opens, want 1 and no main fallback", got)
		}
		// The SAME success is released only after Acquire has returned. Join
		// the proxy stream's end so the assertions include this late result.
		unblock()
		select {
		case <-p.streamClosed:
		case <-time.After(testTimeout):
			t.Fatal("late timed-out response did not finish on the closed connection")
		}
		h.assertDetached()
		t.Log("applied attach held -> deadline -> typed error -> late response released -> closed stream -> owner baseline")
	})

	t.Run("attach_mismatch", func(t *testing.T) {
		for _, kind := range []string{"route", "durable", "path", "malformed"} {
			t.Run(kind, func(t *testing.T) {
				h := newEnrolledHarness(t)
				p := newEnrolledWireProxy(t, h.d.SocketPath(), func(frame map[string]any) {
					if data := enrolledOpenData(frame); data != nil {
						switch kind {
						case "route":
							data["sessionId"] = "wrong-route"
						case "durable":
							data["state"].(map[string]any)["sessionId"] = "wrong-durable"
						case "path":
							data["state"].(map[string]any)["sessionFile"] = "/wrong/path.jsonl"
						case "malformed":
							data["state"] = "not-a-state"
						}
					}
				})
				h.m.cfg.DialAttach = func(ctx context.Context) (*omorpc.Client, error) {
					c, err := omorpc.DialWithConfig(ctx, p.path, omorpc.Config{NoReconnect: true, EventBuffer: 1024})
					if c != nil {
						t.Cleanup(func() { _ = c.Close() })
					}
					return c, err
				}
				before := h.d.RequestCount(omorpc.CmdOpenSession)
				_, _, _, err := h.m.Acquire(t.Context(), h.chat, nil)
				var typed *ErrEnrolledAttach
				if !errors.As(err, &typed) {
					t.Fatalf("mismatch accepted: %v", err)
				}
				if got := h.d.RequestCount(omorpc.CmdOpenSession) - before; got != 1 {
					t.Fatalf("mismatch caused %d opens, want no main fallback", got)
				}
				h.assertDetached()
			})
		}
	})

	t.Run("main_attached_fallback", func(t *testing.T) {
		h := newEnrolledHarness(t)
		cur := h.store.stored(h.chat.id)
		cur.AutoEnrolled = false // Ordinary main resume lands on an external live file.
		mustOK(t, h.store.SaveCursor(t.Context(), h.chat.id, cur))
		s, _, detach, err := h.m.Acquire(t.Context(), h.chat, nil)
		mustOK(t, err)
		defer detach()
		if !s.mainAttached || !s.enrolledAttached || s.client != h.main || s.attachClient != nil {
			t.Fatal("attached:true main result adopted as owned")
		}
		mustOK(t, h.m.StopContext(t.Context(), h.chat.id))
		epoch := s.epoch
		h.m.discardRouting(h.chat.id, s.routingID, epoch)
		h.m.mu.Lock()
		h.m.rememberRetiringLocked(h.chat.id, retiringRoute{route: s.routingID, epoch: epoch})
		h.m.mu.Unlock()
		mustOK(t, h.m.drainRetiring(t.Context(), h.chat.id))
		h.m.reconcileStaleRoutes(h.chat.id, s.sessionFile)
		if got := h.d.RequestCount(omorpc.CmdCloseSession); got != 0 {
			t.Fatalf("main residual closed by retiring family: %d close_session", got)
		}
		// D12: main residual releases only when MAIN ends, never by per-chat close.
		mustOK(t, h.main.Close())
		h.assertDetached()
	})
}

func TestEnrolledDetachResidualSaturation(t *testing.T) {
	h := newEnrolledHarness(t)
	cur := h.store.stored(h.chat.id)
	cur.AutoEnrolled = false // Main resume attaches to the external retained file.
	mustOK(t, h.store.SaveCursor(t.Context(), h.chat.id, cur))
	epoch, _ := h.main.CurrentEpoch()
	// Seed only the reachable residual precondition; the target attachment
	// below is acquired through the actual Unix RPC connection.
	const priorResiduals = 1025
	h.m.mu.Lock()
	for i := 0; i < priorResiduals; i++ {
		h.m.mainAttachedResiduals[retiringRoute{route: fmt.Sprintf("prior-residual-%d", i), epoch: epoch}] = struct{}{}
	}
	h.m.mu.Unlock()
	s, _, detach, err := h.m.Acquire(t.Context(), h.chat, nil)
	mustOK(t, err)
	defer detach()
	if !s.mainAttached || !s.enrolledAttached || s.client != h.main || h.d.Attachments(s.sessionFile) != 2 {
		t.Fatal("fixture did not acquire an actual main attached:true result")
	}
	mustOK(t, h.owner.Close())
	if !h.d.AwaitAttachments(s.sessionFile, 1, testTimeout) {
		t.Fatal("owner disconnect did not leave main as the last attachment")
	}

	// Local stop removes byRoute protection; native recovery must still
	// preserve the held main attachment even beyond the retiring-route cap.
	mustOK(t, h.m.StopContext(t.Context(), h.chat.id))
	h.m.reconcileStaleRoutes("native-recovery", s.sessionFile)
	closes := h.d.RequestCount(omorpc.CmdCloseSession)
	_, stateErr := h.main.Call(t.Context(), omorpc.GetState{SessionID: s.routingID})
	t.Logf("prior residuals=%d; protected=%v; close_session=%d; attachments=%d; retained state error=%v",
		priorResiduals, h.m.mainAttached(s.routingID, epoch), closes, h.d.Attachments(s.sessionFile), stateErr)
	if closes != 0 {
		t.Fatalf("residual saturation sent %d close_session requests, want 0", closes)
	}
	if stateErr != nil {
		t.Fatalf("external retained session ended at residual saturation: %v", stateErr)
	}
	mustOK(t, h.main.Close())
	if !h.d.AwaitAttachments(s.sessionFile, 0, testTimeout) {
		t.Fatal("main disconnect did not release the residual attachment")
	}
	t.Log("cleanup: main and owner disconnected; zero remaining host attachments")
}

func TestEnrolledDetachLateMainAttached(t *testing.T) {
	h := newEnrolledHarness(t)
	resp, epoch, err := h.main.CallInEpoch(t.Context(), omorpc.OpenSession{CWD: h.chat.cwd, SessionPath: h.opened.State.SessionFile})
	mustOK(t, err)
	var data omorpc.OpenSessionData
	mustOK(t, json.Unmarshal(resp.Data, &data))
	if !data.Attached {
		t.Fatal("late result fixture is not attached:true")
	}
	marker := make(chan struct{})
	h.m.mu.Lock()
	h.m.pendingOpen[h.chat.id] = marker
	h.m.mu.Unlock()
	h.m.openSlots <- struct{}{}
	completion := make(chan openResult, 1)
	completion <- openResult{response: resp, epoch: epoch}
	h.m.awaitDetachedCompletion(h.chat.id, h.opened.State.SessionFile, marker, completion, true)
	if !h.m.mainAttached(data.SessionID, epoch) {
		t.Fatal("late attached main result was not remembered as a residual")
	}
	if got := h.d.RequestCount(omorpc.CmdCloseSession); got != 0 {
		t.Fatalf("late attached main result discarded via %d close_session", got)
	}
	// The remembered residual must survive a later local stop and native
	// recovery: neither may close the externally retained main route.
	mustOK(t, h.m.StopContext(t.Context(), h.chat.id))
	h.m.reconcileStaleRoutes("native-recovery", h.opened.State.SessionFile)
	if got := h.d.RequestCount(omorpc.CmdCloseSession); got != 0 {
		t.Fatalf("native recovery closed the late main residual via %d close_session", got)
	}
	if _, err := h.main.Call(t.Context(), omorpc.GetState{SessionID: data.SessionID}); err != nil {
		t.Fatalf("external retained session ended after recovery: %v", err)
	}
	mustOK(t, h.main.Close())
	h.assertDetached()
}

func TestEnrolledDetachLateDedicatedResult(t *testing.T) {
	h := newEnrolledHarness(t)
	entered, release := make(chan struct{}), make(chan struct{})
	unblock := sync.OnceFunc(func() { close(release) })
	defer unblock()
	p := newEnrolledWireProxy(t, h.d.SocketPath(), func(frame map[string]any) {
		if enrolledOpenData(frame) != nil {
			close(entered)
			<-release
		}
	})
	h.m.cfg.DialAttach = func(ctx context.Context) (*omorpc.Client, error) {
		c, err := omorpc.DialWithConfig(ctx, p.path, omorpc.Config{NoReconnect: true})
		if c != nil {
			t.Cleanup(func() { _ = c.Close() })
		}
		return c, err
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan enrolledAcquireResult, 1)
	go func() {
		s, _, detach, err := h.m.Acquire(ctx, h.chat, nil)
		done <- enrolledAcquireResult{s: s, detach: detach, err: err}
	}()
	select {
	case <-entered:
	case <-time.After(testTimeout):
		t.Fatal("dedicated response did not reach late-result barrier")
	}
	cancel()
	got := awaitEnrolledAcquire(t, done)
	var typed *ErrEnrolledAttach
	if !errors.As(got.err, &typed) || !errors.Is(got.err, context.Canceled) {
		t.Fatalf("late canceled attach=%v", got.err)
	}
	unblock()
	h.assertDetached()
}

// D12”: an auto-enrolled main open must not reconcile ownership before its
// held attached:true result arrives. Fence release proves the real recovery
// decision ran; the open response remains behind an explicit wire barrier.
func TestEnrolledDetachLateMainAttachedBeforeResponse(t *testing.T) {
	h := newEnrolledHarness(t)
	mustOK(t, h.m.CloseAll(t.Context()))
	cur := h.store.stored(h.chat.id)
	cur.AutoEnrolled = true
	mustOK(t, h.store.SaveCursor(t.Context(), h.chat.id, cur))
	held := make(chan []byte, 1)
	var holding atomic.Bool
	var discoveryDone atomic.Bool
	holding.Store(true)
	p := newEnrolledWireProxy(t, h.d.SocketPath(), func(frame map[string]any) {
		if frame["command"] == omorpc.CmdListSessions && frame["success"] == true && discoveryDone.CompareAndSwap(false, true) {
			// The external session becomes visible after the discovery snapshot.
			// This makes the enrolled acquisition take its ordinary main-open path.
			frame["data"].(map[string]any)["sessions"] = []any{}
		}
		if enrolledOpenData(frame) != nil && holding.Load() {
			raw, err := json.Marshal(frame)
			if err != nil {
				return
			}
			held <- raw
			// Keep draining this connection's other replies (list_sessions),
			// but withhold THIS correlation's success from omorpc.
			frame["id"] = "held-" + frame["id"].(string)
		}
	})
	main, err := omorpc.Dial(t.Context(), p.path)
	mustOK(t, err)
	t.Cleanup(func() { _ = main.Close() })
	h.main = main
	h.m = NewManager(Config{Client: main, Store: h.store, CloseTimeout: 20 * time.Millisecond, OpenRecoveryAfter: time.Hour})
	h.m.cfg.OpenRecoveryAfter = 50 * time.Millisecond
	t.Cleanup(func() { _ = h.m.CloseAll(context.Background()) })
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan enrolledAcquireResult, 1)
	go func() {
		s, _, detach, err := h.m.Acquire(ctx, h.chat, nil)
		done <- enrolledAcquireResult{s: s, detach: detach, err: err}
	}()
	var response []byte
	select {
	case response = <-held:
	case <-time.After(testTimeout):
		t.Fatal("main open did not reach held-response barrier")
	}
	defer func() {
		holding.Store(false)
		h.d.WriteRaw(append(response, '\n'))
	}()
	var wire struct {
		Data omorpc.OpenSessionData `json:"data"`
	}
	mustOK(t, json.Unmarshal(response, &wire))
	if !wire.Data.Attached || wire.Data.SessionID != h.opened.SessionID || h.d.Attachments(cur.SessionFile) != 2 {
		t.Fatal("fixture did not withhold an external attached:true result")
	}
	// Observe the real recovery boundary: the pending fence closes only
	// AFTER its pre-response reconciliation decision has run.
	marker := openFenceMarker(h.m, h.chat.id)
	if marker == nil {
		t.Fatal("pending enrolled open has no recovery fence")
	}
	cancel()
	got := awaitEnrolledAcquire(t, done)
	if !errors.Is(got.err, context.Canceled) {
		t.Fatalf("canceled main acquire=%v", got.err)
	}
	mainEpoch, _ := main.CurrentEpoch()
	if h.m.mainAttached(h.opened.SessionID, mainEpoch) {
		t.Fatal("fixture accidentally delivered the held attached:true result")
	}
	select {
	case <-marker:
	case <-time.After(testTimeout):
		t.Fatal("enrolled pending-open recovery did not release its fence")
	}
	closeRequests := h.d.RequestCount(omorpc.CmdCloseSession)
	t.Logf("held response attached=%v route=%s; before delivery recovery close_session=%d; attachments=%d",
		wire.Data.Attached, wire.Data.SessionID, closeRequests, h.d.Attachments(cur.SessionFile))
	if closeRequests != 0 {
		t.Fatalf("D12/IS3 violation: recovery sent %d close_session before the external attached:true response arrived", closeRequests)
	}
}
