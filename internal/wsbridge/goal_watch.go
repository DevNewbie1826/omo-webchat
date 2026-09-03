package wsbridge

import (
	"context"
	"errors"
	"os"
	"syscall"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
	"github.com/DevNewbie1826/omo-webchat/internal/wscontract"
)

// goalWatchInterval bounds the goal-file metadata watch. Every tick is one
// cheap Lstat; the bounded read happens only when existence, identity, size,
// or mtime changes. No filesystem-event dependency is available, so the
// metadata ticker is the change signal - never a full-state poll on the wire.
const goalWatchInterval = 2 * time.Second

type goalFileStamp struct {
	device uint64
	inode  uint64
	size   int64
	mod    time.Time
}

type goalWatchState struct {
	last         *session.GoalState
	lastStamp    goalFileStamp
	hadStamp     bool
	acknowledged bool
}

func (s *goalWatchState) needsRead(stamp goalFileStamp, present bool) bool {
	return !s.acknowledged || present != s.hadStamp || (present && stamp != s.lastStamp)
}

func (s *goalWatchState) accept(goal *session.GoalState, info os.FileInfo) bool {
	changed := !s.acknowledged || !session.EqualGoalState(goal, s.last)
	s.last = goal
	s.lastStamp, s.hadStamp = goalStampFromInfo(info)
	s.acknowledged = true
	return changed
}

func (s *goalWatchState) refresh(read func() (*session.GoalState, os.FileInfo, error)) (*session.GoalState, bool) {
	goal, info, err := read()
	if err != nil {
		return nil, false
	}
	return goal, s.accept(goal, info)
}

// startGoalWatch pushes chat.goal frames while this socket's chat is bound.
// The watcher sends an explicit initial snapshot (including goal:null) and
// then reads again whenever the goal document's existence or identity changes,
// until the socket unbinds or shuts down.
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
	var state goalWatchState
	readAndPush := func() {
		goal, push := state.refresh(func() (*session.GoalState, os.FileInfo, error) {
			return session.ReadGoalStateSnapshot(ctx, agentDir, cwd, durableSessionID)
		})
		if !push {
			return // transient reads are retried without clearing or acknowledging
		}
		frame := wscontract.ChatGoalFrame{Type: "chat.goal", SessionID: chatID}
		if goal != nil {
			frame.Goal = goalToWire(goal)
		}
		if err := c.write(frame); err != nil {
			// The socket is gone; shutdown cancels the context shortly.
			c.stopGoalWatch()
		}
	}
	readAndPush()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			stamp, present, err := goalStamp(ctx, agentDir, cwd, durableSessionID)
			if err == nil && state.needsRead(stamp, present) {
				readAndPush()
			}
		}
	}
}

// goalStamp reports the goal document's current identity/size/mtime signature.
// Absence is distinct from a transient stat or file-type error.
func goalStamp(ctx context.Context, agentDir, cwd, durableSessionID string) (goalFileStamp, bool, error) {
	if err := ctx.Err(); err != nil {
		return goalFileStamp{}, false, err
	}
	path, ok := session.GoalStatePath(agentDir, cwd, durableSessionID)
	if !ok {
		return goalFileStamp{}, false, nil
	}
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return goalFileStamp{}, false, nil
	}
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return goalFileStamp{}, false, errGoalStampTransient
	}
	stamp, _ := goalStampFromInfo(info)
	return stamp, true, nil
}

var errGoalStampTransient = errors.New("goal file identity unavailable")

func goalStampFromInfo(info os.FileInfo) (goalFileStamp, bool) {
	if info == nil {
		return goalFileStamp{}, false
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return goalFileStamp{}, false
	}
	return goalFileStamp{
		device: uint64(stat.Dev),
		inode:  uint64(stat.Ino),
		size:   info.Size(),
		mod:    info.ModTime(),
	}, true
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
