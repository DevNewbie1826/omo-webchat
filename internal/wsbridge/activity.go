package wsbridge

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"

	"github.com/DevNewbie1826/omo-webchat/internal/session"
	"github.com/DevNewbie1826/omo-webchat/internal/wscontract"
)

const activityQueueSize = 64

// ActivitySource is the narrow manager-cache seam used by the bridge.
// SubscribeActivity registers the filtered observer and returns its initial
// snapshot in one transaction. overflow reports loss at the source hand-off.
type ActivitySource interface {
	SubscribeActivity(bool, []string, func(session.Summary, bool)) ([]session.Summary, func())
}

func (c *connection) subscribeActivity(frame *wscontract.SessionsSubscribeFrame) {
	allLive, ids, err := activityFilter(frame)
	if err != nil {
		c.sendError("bad_frame", err.Error(), "sessions.subscribe", "")
		return
	}

	c.activityMu.Lock()
	if c.closed.Load() {
		c.activityMu.Unlock()
		return
	}
	if c.activity != nil {
		c.activity.stop()
		c.activity = nil
	}
	if frame.Mode == "none" {
		c.activityMu.Unlock()
		c.sendAck("sessions.subscribe", "")
		return
	}

	source := c.bridge.cfg.ActivitySource
	if source == nil {
		source, _ = any(c.bridge.cfg.Manager).(ActivitySource)
	}
	if source == nil {
		c.activityMu.Unlock()
		c.sendError("provider_error", "activity subscriptions are unavailable", "sessions.subscribe", "")
		return
	}
	pump := newActivityPump(c)
	initial, unsubscribe := source.SubscribeActivity(allLive, ids, func(summary session.Summary, overflow bool) {
		pump.enqueue(summary, overflow)
	})
	activity := &activitySubscription{pump: pump, unsubscribe: unsubscribe}
	c.activity = activity
	pump.start(initial)
	c.activityMu.Unlock()
	c.sendAck("sessions.subscribe", "")
}

func activityFilter(frame *wscontract.SessionsSubscribeFrame) (bool, []string, error) {
	switch frame.Mode {
	case "all_live":
		if len(frame.SessionIds) != 0 {
			return false, nil, fmt.Errorf("all_live mode does not accept sessionIds")
		}
		return true, nil, nil
	case "explicit":
		if len(frame.SessionIds) == 0 {
			return false, nil, fmt.Errorf("explicit mode requires sessionIds")
		}
		if len(frame.SessionIds) > 256 {
			return false, nil, fmt.Errorf("explicit mode accepts at most 256 sessionIds")
		}
		seen := make(map[string]struct{}, len(frame.SessionIds))
		ids := make([]string, len(frame.SessionIds))
		for i, id := range frame.SessionIds {
			if id == "" {
				return false, nil, fmt.Errorf("sessionIds must not contain empty values")
			}
			if _, exists := seen[id]; exists {
				return false, nil, fmt.Errorf("sessionIds must not contain duplicates")
			}
			seen[id] = struct{}{}
			ids[i] = id
		}
		return false, ids, nil
	case "none":
		if len(frame.SessionIds) != 0 {
			return false, nil, fmt.Errorf("none mode does not accept sessionIds")
		}
		return false, nil, nil
	default:
		return false, nil, fmt.Errorf("unknown activity subscription mode")
	}
}

type activitySubscription struct {
	pump        *activityPump
	unsubscribe func()
	once        sync.Once
}

func (s *activitySubscription) stop() {
	if s == nil {
		return
	}
	s.once.Do(func() {
		if s.unsubscribe != nil {
			s.unsubscribe()
		}
		s.pump.stop()
	})
}

type queuedActivity struct {
	summary  session.Summary
	overflow bool
}

// activityPump is intentionally independent from subscriber. Activity overview
// pressure drops the oldest overview update and never detaches or delays chat
// replay delivery on the same socket.
type activityPump struct {
	conn   *connection
	ctx    context.Context
	cancel context.CancelFunc

	mu      sync.Mutex
	sendMu  sync.Mutex
	queue   []queuedActivity
	active  bool
	stopped bool
	notify  chan struct{}
}

func newActivityPump(c *connection) *activityPump {
	ctx, cancel := context.WithCancel(c.ctx)
	return &activityPump{conn: c, ctx: ctx, cancel: cancel, notify: make(chan struct{}, 1)}
}

func (p *activityPump) enqueue(summary session.Summary, upstreamOverflow bool) {
	if summary.ChatID == "" || p.ctx.Err() != nil {
		return
	}
	summary = cloneActivitySummary(summary)
	p.mu.Lock()
	if p.stopped {
		p.mu.Unlock()
		return
	}
	overflow := upstreamOverflow
	if len(p.queue) >= activityQueueSize {
		p.queue = p.queue[1:]
		overflow = true
	}
	p.queue = append(p.queue, queuedActivity{summary: summary, overflow: overflow})
	active := p.active
	p.mu.Unlock()
	if active {
		select {
		case p.notify <- struct{}{}:
		default:
		}
	}
}

func (p *activityPump) start(initial []session.Summary) {
	// The source callback may run before SubscribeActivity returns. Prepending
	// the transaction snapshot keeps initial state ahead of those live updates.
	p.mu.Lock()
	pending := p.queue
	p.queue = nil
	for _, summary := range initial {
		p.appendLocked(cloneActivitySummary(summary))
	}
	for _, item := range pending {
		p.appendLockedItem(item)
	}
	p.active = true
	p.mu.Unlock()
	go p.run()
	select {
	case p.notify <- struct{}{}:
	default:
	}
}

func (p *activityPump) appendLocked(summary session.Summary) {
	p.appendLockedItem(queuedActivity{summary: summary})
}

func (p *activityPump) appendLockedItem(item queuedActivity) {
	if item.summary.ChatID == "" {
		return
	}
	if len(p.queue) >= activityQueueSize {
		p.queue = p.queue[1:]
		item.overflow = true
	}
	p.queue = append(p.queue, item)
}

func (p *activityPump) stop() {
	p.mu.Lock()
	p.stopped = true
	p.active = false
	p.queue = nil
	p.mu.Unlock()
	p.cancel()
	// Serialize with the final possible write so a sessions.subscribe ack sent
	// after stop is an exact boundary: no old activity frame can follow it.
	p.sendMu.Lock()
	p.sendMu.Unlock()
}

func (p *activityPump) run() {
	for {
		select {
		case <-p.ctx.Done():
			return
		case <-p.notify:
			for {
				p.mu.Lock()
				if len(p.queue) == 0 {
					p.mu.Unlock()
					break
				}
				item := p.queue[0]
				p.queue = p.queue[1:]
				p.mu.Unlock()
				frame := activityFrame(item.summary, item.overflow)
				p.sendMu.Lock()
				p.mu.Lock()
				stopped := p.stopped
				p.mu.Unlock()
				if stopped {
					p.sendMu.Unlock()
					return
				}
				err := p.conn.writeActivity(frame)
				p.sendMu.Unlock()
				if err != nil {
					p.conn.shutdown()
					return
				}
			}
		}
	}
}

func cloneActivitySummary(summary session.Summary) session.Summary {
	summary.ActivityPair.Task = append(json.RawMessage(nil), summary.ActivityPair.Task...)
	summary.ActivityPair.Dag = append(json.RawMessage(nil), summary.ActivityPair.Dag...)
	if summary.TaskDigest != nil {
		copyDigest := *summary.TaskDigest
		copyDigest.Tasks = append([]session.TaskDigestEntry(nil), summary.TaskDigest.Tasks...)
		summary.TaskDigest = &copyDigest
	}
	if summary.DagDigest != nil {
		copyDigest := *summary.DagDigest
		copyDigest.Runs = make([]session.RunDigestEntry, len(summary.DagDigest.Runs))
		for i, run := range summary.DagDigest.Runs {
			copyDigest.Runs[i] = run
			copyDigest.Runs[i].RunningTaskIDs = append([]string(nil), run.RunningTaskIDs...)
		}
		summary.DagDigest = &copyDigest
	}
	return summary
}

func activityFrame(summary session.Summary, overflow bool) wscontract.SessionsActivityFrame {
	frame := wscontract.SessionsActivityFrame{
		Type: "sessions.activity", SessionID: summary.ChatID, Overflow: overflow,
		Snapshots: make([]wscontract.ActivitySnapshot, 0, 2),
	}
	if len(summary.ActivityPair.Task) > 0 || summary.TaskOversized {
		frame.Snapshots = append(frame.Snapshots, wscontract.ActivitySnapshot{
			Name: "omo.task.updated", Data: summary.ActivityPair.Task, Oversized: summary.TaskOversized,
		})
	}
	if len(summary.ActivityPair.Dag) > 0 || summary.DagOversized {
		frame.Snapshots = append(frame.Snapshots, wscontract.ActivitySnapshot{
			Name: "omo.dag.updated", Data: summary.ActivityPair.Dag, Oversized: summary.DagOversized,
		})
	}
	if digest := summary.TaskDigest; digest != nil {
		tasks := make([]wscontract.TaskDigestEntry, len(digest.Tasks))
		for i, task := range digest.Tasks {
			tasks[i] = wscontract.TaskDigestEntry{TaskID: task.TaskID, Status: task.Status}
			if task.UpdatedAt != "" {
				tasks[i].UpdatedAt = &task.UpdatedAt
			}
		}
		frame.TaskDigest = &wscontract.TaskDigest{Tasks: tasks, Truncated: digest.Truncated}
		if digest.ReceivedAt != "" {
			frame.TaskDigest.ReceivedAt = &digest.ReceivedAt
		}
	}
	if digest := summary.DagDigest; digest != nil {
		runs := make([]wscontract.RunDigestEntry, len(digest.Runs))
		for i, run := range digest.Runs {
			runs[i] = wscontract.RunDigestEntry{RunID: run.RunID, Status: run.Status, RunningTaskIds: append([]string(nil), run.RunningTaskIDs...)}
		}
		frame.DagDigest = &wscontract.DagDigest{Runs: runs, Truncated: digest.Truncated}
		if digest.ReceivedAt != "" {
			frame.DagDigest.ReceivedAt = &digest.ReceivedAt
		}
	}
	return frame
}
