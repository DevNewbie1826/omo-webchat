package session

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func TestEnrolledProviderLossCommands(t *testing.T) {
	commands := []struct {
		name string
		wire string
		call func(context.Context, *Session) error
	}{
		{"get_state", omorpc.CmdGetState, func(ctx context.Context, s *Session) error {
			_, err := s.QueryState(ctx)
			return err
		}},
		{"models", omorpc.CmdGetAvailableModels, func(ctx context.Context, s *Session) error {
			_, err := s.Models(ctx)
			return err
		}},
		{"commands", omorpc.CmdGetCommands, func(ctx context.Context, s *Session) error {
			_, err := s.Commands(ctx)
			return err
		}},
		{"stats", omorpc.CmdGetSessionStats, func(ctx context.Context, s *Session) error {
			_, err := s.Stats(ctx)
			return err
		}},
		{"media", omorpc.CmdGetMedia, func(ctx context.Context, s *Session) error {
			_, err := s.GetMedia(ctx, "missing-tool", 0)
			return err
		}},
		{"entries", omorpc.CmdGetEntries, func(ctx context.Context, s *Session) error {
			_, err := s.fetchEntriesAfter(ctx, "")
			return err
		}},
		{"prompt", omorpc.CmdPrompt, func(ctx context.Context, s *Session) error {
			return s.SendPrompt(ctx, "provider-loss-guard", nil)
		}},
	}
	for _, code := range []string{omorpc.ErrCodeUnknownSession, omorpc.ErrCodeSessionClosing} {
		for _, command := range commands {
			t.Run(command.name+"/"+code, func(t *testing.T) {
				// Given a real dedicated Unix-RPC attachment and a stable
				// negative acknowledgement, without closing its transport.
				h := newEnrolledHarness(t)
				s, _, _ := h.attach()
				before := h.d.RequestCount(command.wire)
				h.d.FailNext(command.wire, code)

				// When the Session command receives the provider error.
				err := command.call(t.Context(), s)

				// Then classification retains the cause and releases only C.
				var stable *omorpc.StableError
				if !errors.Is(err, ErrSessionResumable) || !errors.As(err, &stable) || stable.Code != code {
					t.Fatalf("command=%s route-loss error=%v, want resumable + %s", command.wire, err, code)
				}
				if h.d.RequestCount(command.wire) != before+1 {
					t.Fatal("guard did not exercise exactly one real Unix-RPC command")
				}
				t.Logf("Unix RPC %s -> success:false error:%s", command.wire, code)
				assertEnrolledProviderLossReleased(t, h, s)
			})
		}
	}
}

func TestEnrolledProviderLossEvents(t *testing.T) {
	for _, kind := range []string{"session_closed", "session_unloaded", "close_session_response"} {
		t.Run(kind, func(t *testing.T) {
			// Given a dedicated pump, subscribe to its exact epoch end
			// before sending the lifecycle record through the real socket.
			h := newEnrolledHarness(t)
			s, _, _ := h.attach()
			lost := make(chan struct{})
			var once sync.Once
			s.client.SetEpochChangeObserver(func(prev, next omorpc.EpochToken) {
				if prev == s.epoch && next == (omorpc.EpochToken{}) {
					once.Do(func() { close(lost) })
				}
			})
			record := map[string]any{"type": kind}
			if kind == "close_session_response" {
				record = map[string]any{"type": "response", "command": omorpc.CmdCloseSession, "success": true}
			}

			// When the pump ingests provider route loss (the fake owner
			// remains live so detach and subsequent reattach are observable).
			h.d.EmitSession(s.sessionFile, record)
			select {
			case <-lost:
			case <-time.After(testTimeout):
				t.Fatalf("provider %s did not release the dedicated epoch", kind)
			}

			// Then registry/socket cleanup and lazy reattach both work.
			t.Logf("Unix RPC event %v -> dedicated epoch ended", record)
			assertEnrolledProviderLossReleased(t, h, s)
		})
	}
}

func assertEnrolledProviderLossReleased(t *testing.T, h *enrolledHarness, stale *Session) {
	t.Helper()
	h.m.mu.Lock()
	registered := len(h.m.attachClients)
	h.m.mu.Unlock()
	if registered != 0 {
		t.Fatalf("dedicated registration=%d after provider loss, want 0", registered)
	}
	stale.lifecycleMu.Lock()
	holdsClient := stale.attachClient != nil
	closed, idleArmed := stale.closed, stale.idleTimer != nil
	stale.lifecycleMu.Unlock()
	if holdsClient || stale.client.EpochCurrent(stale.epoch) || closed || idleArmed || !stale.Resumable() {
		t.Fatalf("provider loss: holds_client=%v epoch_live=%v closed=%v idle_armed=%v resumable=%v",
			holdsClient, stale.client.EpochCurrent(stale.epoch), closed, idleArmed, stale.Resumable())
	}
	h.assertDetached()
	mainEpoch, _ := h.main.CurrentEpoch()
	h.m.mu.Lock()
	_, mainInvalidated := h.m.invalidatedEpochs[mainEpoch]
	h.m.mu.Unlock()
	if mainInvalidated || !h.m.epochCurrent(mainEpoch) {
		t.Fatal("single-route loss invalidated the shared MAIN epoch")
	}
	t.Log("provider loss: registration=0; old client closed; attachments=1; close_session=0; resumable=true; MAIN live")

	// Lazy Acquire must attach again to the same durable owner session.
	fresh, r, detach := h.attach()
	if fresh == stale || fresh.epoch == stale.epoch || fresh.routingID != stale.routingID || fresh.ID() != stale.ID() {
		t.Fatal("following Acquire did not reattach the same durable route under a new dedicated epoch")
	}
	h.stream(r, "after-provider-loss")
	t.Log("following Acquire: new dedicated epoch; same route/durable identity; attachments=2; live stream received")
	detach()
	mustOK(t, fresh.Close())
	h.assertDetached()
	t.Log("cleanup: released replacement attachment; owner baseline=1; fixture manager/clients/socket removed by test cleanups")
}

func TestEnrolledProviderLossNondefinitiveKeepsAttachment(t *testing.T) {
	h := newEnrolledHarness(t)
	s, r, detach := h.attach()
	h.d.FailNext(omorpc.CmdGetState, "provider_busy")
	_, err := s.QueryState(t.Context())
	if err == nil || errors.Is(err, ErrSessionResumable) || s.Resumable() {
		t.Fatalf("nondefinitive provider error incorrectly invalidated Session: %v", err)
	}
	if !h.m.epochCurrent(s.epoch) || h.d.Attachments(s.sessionFile) != 2 {
		t.Fatal("nondefinitive error released a live dedicated attachment")
	}
	h.stream(r, "after-nondefinitive-error")
	detach()
	mustOK(t, s.Close())
	h.assertDetached()
}
