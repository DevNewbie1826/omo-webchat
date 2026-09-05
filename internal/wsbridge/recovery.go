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
	recovered, recoverErr := c.recoverBindingInFlight(ctx, binding)
	if recoverErr != nil {
		info := resumeFailureInfo(recoverErr)
		frame, mapErr := mapError("error", binding.stale.chatID, session.Frame{Kind: session.FrameError, Command: query.command, Data: info})
		if mapErr == nil {
			_ = c.writeIfCurrent(binding.stale, frame)
		}
		return
	}
	_ = query.run(ctx, recovered)
}

func (c *connection) recoverBindingInFlight(ctx context.Context, binding recoveryBinding) (*session.Session, error) {
	var preparedGeneration uint64
	guarded := c.bridge.cfg.PrepareChatVersion != nil && c.bridge.cfg.ChatVersion != nil
	if guarded {
		var err error
		preparedGeneration, err = c.bridge.cfg.PrepareChatVersion(ctx, binding.workspaceID, binding.stale.chatID)
		if err != nil {
			return nil, err
		}
	} else if c.bridge.cfg.PrepareChat != nil {
		if err := c.bridge.cfg.PrepareChat(ctx, binding.workspaceID, binding.stale.chatID); err != nil {
			return nil, err
		}
	}
	rec, err := c.bridge.cfg.Store.GetChat(binding.stale.chatID)
	if err != nil {
		return nil, err
	}
	if rec.WorkspaceID != binding.workspaceID || !cursorstore.IsLaunchableProvider(rec.Provider) {
		return nil, errors.New("chat metadata changed while resuming")
	}
	validate := func() error { return nil }
	if guarded {
		validate = func() error {
			if c.bridge.cfg.ChatVersion(binding.stale.chatID) != preparedGeneration {
				return ErrChatDeleted
			}
			return nil
		}
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
		if !errors.Is(resumeErr, session.ErrSessionResumable) || attempt == 1 {
			return resumed, resumeErr
		}
		if detach != nil {
			detach()
		}
		staged.sub.DiscardHydrationAttempt()
	}
	return nil, session.ErrSessionResumable
}

func (c *connection) bindRecovered(ctx context.Context, binding recoveryBinding, staged *stagedRecovery) bool {
	wrappedDetach := staged.sub.wrapDetach(staged.detach)
	c.stateMu.Lock()
	if c.closed.Load() || c.wsID != binding.workspaceID || c.chatID != binding.stale.chatID ||
		c.bindingGeneration != binding.stale.generation || c.sess != binding.stale.session {
		c.stateMu.Unlock()
		wrappedDetach()
		return false
	}
	oldDetach := c.detach
	c.sess, c.detach, c.sub = staged.session, wrappedDetach, staged.sub
	c.stateMu.Unlock()
	if !staged.sub.activate(ctx, !staged.started) {
		wrappedDetach()
		return false
	}
	if oldDetach != nil {
		oldDetach()
	}
	if err := c.bridge.cfg.Store.TouchLastUsed(binding.stale.chatID); err != nil {
		c.bridge.cfg.Logger.Warn("touching v2 chat last-used time", "chat_id", binding.stale.chatID, "error", err)
	}
	c.bridge.publishQueueToConnection(c, staged.session)
	return true
}
