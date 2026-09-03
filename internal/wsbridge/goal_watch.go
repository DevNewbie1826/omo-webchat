package wsbridge

import (
	"context"
	"os"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
	"github.com/DevNewbie1826/omo-webchat/internal/wscontract"
)

// goalWatchInterval bounds the goal-file mtime watch. Every tick is one
// cheap Stat; the bounded read and the chat.goal push happen only when the
// file's size or mtime actually changed. No filesystem-event dependency is
// available, so an mtime stat ticker is the change signal — push-on-change,
// never a full-state poll on the wire.
const goalWatchInterval = 2 * time.Second

type goalFileStamp struct {
	size int64
	mod  time.Time
}

// startGoalWatch pushes chat.goal frames while this socket's chat is bound.
// The watcher reads the projected state once at bind (pushing only when a
// goal exists — the attach-time REST fetch already carries the initial
// state) and again whenever the goal document changes, until the socket
// unbinds or shuts down.
func (c *connection) startGoalWatch(chat cursorstore.Chat) {
	agentDir := session.CodingAgentDir()
	if _, ok := session.GoalStatePath(agentDir, chat.CWD, chat.DurableSessionID); !ok {
		return
	}
	ctx, cancel := context.WithCancel(c.ctx)
	c.stateMu.Lock()
	if c.closed.Load() || c.chatID != chat.ID || c.goalCancel != nil {
		c.stateMu.Unlock()
		cancel()
		return
	}
	c.goalCancel = cancel
	c.stateMu.Unlock()
	go c.runGoalWatch(ctx, chat.ID, agentDir, chat.CWD, chat.DurableSessionID)
}

func (c *connection) stopGoalWatch() {
	c.stateMu.Lock()
	cancel := c.goalCancel
	c.goalCancel = nil
	c.stateMu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (c *connection) runGoalWatch(ctx context.Context, chatID, agentDir, cwd, durableSessionID string) {
	ticker := time.NewTicker(goalWatchInterval)
	defer ticker.Stop()
	var last *session.GoalState
	pushed := false
	push := func() {
		goal, err := session.ReadGoalState(ctx, agentDir, cwd, durableSessionID)
		if err != nil {
			return
		}
		if pushed && session.EqualGoalState(goal, last) {
			return
		}
		if !pushed && goal == nil {
			// Bind-time no-goal state is already reported by the attach-time
			// REST fetch; stay silent until the document actually appears.
			return
		}
		last = goal
		pushed = true
		frame := wscontract.ChatGoalFrame{Type: "chat.goal", SessionID: chatID}
		if goal != nil {
			frame.Goal = goalToWire(goal)
		}
		if err := c.write(frame); err != nil {
			// The socket is gone; shutdown cancels the context shortly.
			c.stopGoalWatch()
		}
	}
	// Bind-time read: silently skip the no-goal case (the attach-time REST
	// fetch already reported it) so a goal-less chat costs one stat per tick
	// and nothing on the wire.
	push()
	var lastStamp goalFileStamp
	hadStamp := false
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			stamp, ok := goalStamp(ctx, agentDir, cwd, durableSessionID)
			if !ok && !hadStamp && !pushed {
				continue // goal-less chat: one stat per tick, nothing else
			}
			// Appear, disappear, and mtime/size changes all count as changes;
			// equal stamps reduce the tick to the Stat itself.
			if !ok != !hadStamp || (ok && hadStamp && stamp != lastStamp) {
				push()
			}
			lastStamp, hadStamp = stamp, ok
		}
	}
}

// goalStamp reports the goal document's current size/mtime signature, or
// ok=false when no readable regular file exists. The watcher treats a
// transition between "absent" and "present" as a change either way.
func goalStamp(ctx context.Context, agentDir, cwd, durableSessionID string) (goalFileStamp, bool) {
	if err := ctx.Err(); err != nil {
		return goalFileStamp{}, false
	}
	path, ok := session.GoalStatePath(agentDir, cwd, durableSessionID)
	if !ok {
		return goalFileStamp{}, false
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return goalFileStamp{}, false
	}
	return goalFileStamp{size: info.Size(), mod: info.ModTime()}, true
}

func goalToWire(goal *session.GoalState) *wscontract.ChatGoalState {
	wire := &wscontract.ChatGoalState{
		Objective: goal.Objective,
		Status:    goal.Status,
	}
	if goal.ObjectiveTruncated {
		truncated := goal.ObjectiveTruncated
		wire.ObjectiveTruncated = &truncated
	}
	if goal.BlockedReason != "" {
		wire.BlockedReason = &goal.BlockedReason
	}
	wire.CreatedAt = goal.CreatedAt
	wire.UpdatedAt = goal.UpdatedAt
	wire.CompletedAt = goal.CompletedAt
	return wire
}
