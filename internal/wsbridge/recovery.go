package wsbridge

import (
	"context"
	"errors"

	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
)

type recoveryBinding struct {
	workspaceID string
	stale       queryBinding
}

type stagedRecovery struct {
	session *session.Session
	started bool
	detach  func()
	sub     *subscriber
}

type recoverableQuery struct {
	command string
	run     func(context.Context, *session.Session) error
}

func (c *connection) queryRecovering(ctx context.Context, binding recoveryBinding, query recoverableQuery) {
	err := query.run(ctx, binding.stale.session)
	if !errors.Is(err, session.ErrSessionResumable) && !errors.Is(err, session.ErrSessionClosed) {
		return
	}
	recovered, recoverErr := c.recoverBindingInFlight(ctx, &binding)
	if recoverErr == nil {
		err = query.run(ctx, recovered)
		if !errors.Is(err, session.ErrSessionResumable) && !errors.Is(err, session.ErrSessionClosed) {
			return
		}
		recoverErr = err
	}
	if !errors.Is(ctx.Err(), context.Canceled) {
		info := resumeFailureInfo(recoverErr)
		frame, mapErr := mapError("error", binding.stale.chatID, session.Frame{Kind: session.FrameError, Command: query.command, Data: info})
		if mapErr == nil {
			_ = c.writeIfCurrent(binding.stale, frame)
		}
		return
	}
}

// prepareRecovery is shared by browser rebinding and headless work recovery.
// Both honor metadata generations and only reopen a retained durable cursor.
func (h *Handler) prepareRecovery(ctx context.Context, workspaceID, chatID string) (cursorstore.Chat, func() error, error) {
	var preparedGeneration uint64
	guarded := h.cfg.PrepareChatVersion != nil && h.cfg.ChatVersion != nil
	if guarded {
		var err error
		preparedGeneration, err = h.cfg.PrepareChatVersion(ctx, workspaceID, chatID)
		if err != nil {
			return cursorstore.Chat{}, nil, err
		}
	} else if h.cfg.PrepareChat != nil {
		if err := h.cfg.PrepareChat(ctx, workspaceID, chatID); err != nil {
			return cursorstore.Chat{}, nil, err
		}
	}
	rec, err := h.cfg.Store.GetChat(chatID)
	if err != nil {
		return cursorstore.Chat{}, nil, err
	}
	if rec.WorkspaceID != workspaceID || !cursorstore.IsLaunchableProvider(rec.Provider) {
		return cursorstore.Chat{}, nil, errors.New("chat metadata changed while resuming")
	}
	validate := func() error { return nil }
	if guarded {
		validate = func() error {
			if h.cfg.ChatVersion(chatID) != preparedGeneration {
				return ErrChatDeleted
			}
			return nil
		}
	}
	return rec, validate, nil
}

func (c *connection) recoverBindingInFlight(ctx context.Context, binding *recoveryBinding) (*session.Session, error) {
	rec, validate, err := c.bridge.prepareRecovery(ctx, binding.workspaceID, binding.stale.chatID)
	if err != nil {
		return nil, err
	}
	for attempt := 0; attempt < 2; attempt++ {
		staged := &stagedRecovery{sub: newSubscriber(c)}
		initialize := func(acquired *session.Session, started bool, detach func()) {
			staged.session, staged.started, staged.detach = acquired, started, detach
		}
		bind := func(acquired *session.Session) error {
			if staged.session != acquired || staged.detach == nil || !c.bindRecovered(ctx, binding, staged) {
				return errors.New("session binding changed while resuming")
			}
			return nil
		}
		resumed, _, detach, resumeErr := c.bridge.cfg.Manager.ResumeInitializedCheckedAndRunInFlight(
			ctx, chatRef{id: rec.ID, cwd: rec.CWD}, staged.sub, initialize, validate, bind, nil,
		)
		if resumeErr != nil && detach != nil {
			staged.sub.wrapDetach(detach)()
		}
		if !errors.Is(resumeErr, session.ErrSessionResumable) || attempt == 1 {
			return resumed, resumeErr
		}
	}
	return nil, session.ErrSessionResumable
}

func (c *connection) bindRecovered(ctx context.Context, binding *recoveryBinding, staged *stagedRecovery) bool {
	wrappedDetach := staged.sub.wrapDetach(staged.detach)
	c.stateMu.Lock()
	if c.closed.Load() || c.wsID != binding.workspaceID || c.chatID != binding.stale.chatID ||
		c.bindingGeneration != binding.stale.generation || c.sess != binding.stale.session {
		c.stateMu.Unlock()
		wrappedDetach()
		return false
	}
	oldSession, oldDetach, oldSub := c.sess, c.detach, c.sub
	c.invalidateTodoWatchLocked()
	c.sess, c.detach, c.sub = staged.session, wrappedDetach, staged.sub
	c.stateMu.Unlock()
	if !staged.sub.activate(ctx, !staged.started) {
		c.stateMu.Lock()
		if c.sess == staged.session && c.sub == staged.sub && c.bindingGeneration == binding.stale.generation {
			c.sess, c.detach, c.sub = oldSession, oldDetach, oldSub
		}
		c.stateMu.Unlock()
		wrappedDetach()
		return false
	}
	binding.stale.session = staged.session
	if oldDetach != nil {
		oldDetach()
	}
	c.bridge.publishQueueToConnection(c, staged.session)
	return true
}

// reconcileRecoveredSession rebinds every browser connection still bound to
// stale after the transport recovered. The manager invokes it while holding
// the chat's per-chat flight, so the transparent recovery below preserves its
// FIFO position and shares the single recovery open with any concurrent
// in-flight send recovery or user request. The recovery acquisition reopens
// the SAME durable session: the rebinding replay (ready + durable history) is
// the recovery-state surface the client observes, and a genuine resume
// failure surfaces through the existing error mapping without unbinding, so
// the next user operation still drives its own recovery.
func (h *Handler) reconcileRecoveredSession(chatID string, stale *session.Session) {
	if stale == nil {
		return
	}
	boundConnection := false
	h.conns.Range(func(_, value any) bool {
		c, ok := value.(*connection)
		if !ok {
			return true
		}
		c.stateMu.Lock()
		// Only a fully installed binding (live session-detach hook still in
		// place) is rebound automatically; a half-transitioned binding lets its
		// next user operation drive recovery through the query path.
		matches := !c.closed.Load() && c.chatID == chatID && c.sess == stale
		bound := matches && c.detach != nil
		wsID, generation := c.wsID, c.bindingGeneration
		c.stateMu.Unlock()
		// A half-installed binding is not headless work: its in-flight user
		// operation still owns the transition and must keep that FIFO fence.
		boundConnection = boundConnection || matches
		if !bound {
			return true
		}
		ctx, cancel := context.WithTimeout(h.cfg.Context, h.cfg.HistoryTimeout)
		defer cancel()
		binding := &recoveryBinding{workspaceID: wsID, stale: queryBinding{chatID: chatID, generation: generation, session: stale}}
		recovered, err := c.recoverBindingInFlight(ctx, binding)
		if err == nil {
			c.initializeBinding(ctx, chatID, recovered)
		} else if !errors.Is(ctx.Err(), context.Canceled) {
			h.cfg.Logger.Warn("reconciling recovered v2 chat session", "chat_id", chatID, "error", err)
			frame, mapErr := mapError("error", chatID, session.Frame{Kind: session.FrameError, Data: resumeFailureInfo(err)})
			if mapErr == nil {
				_ = c.writeIfCurrent(binding.stale, frame)
			}
		}
		return true
	})
	if boundConnection {
		return
	}
	// Accepted provider work outlives its browser. Re-establish its route in
	// this same per-chat FIFO even when there is no connection to rebind.
	ctx, cancel := context.WithTimeout(h.cfg.Context, h.cfg.HistoryTimeout)
	defer cancel()
	rec, err := h.cfg.Store.GetChat(chatID)
	if err == nil {
		var validate func() error
		rec, validate, err = h.prepareRecovery(ctx, rec.WorkspaceID, chatID)
		if err == nil {
			var recovered *session.Session
			recovered, _, _, err = h.cfg.Manager.ResumeInitializedCheckedAndRunInFlight(
				ctx, chatRef{id: rec.ID, cwd: rec.CWD}, nil, nil, validate, nil, nil,
			)
			if err == nil {
				_, err = recovered.QueryState(ctx)
				if err == nil {
					h.scheduleIdleDrain(chatID, recovered)
				}
			}
		}
	}
	if err != nil && !errors.Is(ctx.Err(), context.Canceled) {
		h.cfg.Logger.Warn("reconciling unbound work session", "chat_id", chatID, "error", err)
	}
}
