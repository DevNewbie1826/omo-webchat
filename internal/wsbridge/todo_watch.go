package wsbridge

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/fileid"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
	"github.com/DevNewbie1826/omo-webchat/internal/wscontract"
)

const todoWatchInterval = 2 * time.Second

// Only the clock and acquisition boundary are replaceable in lifecycle tests.
type todoWatchOptions struct {
	ticks    <-chan time.Time
	read     func(context.Context, *session.Session) (session.TodoProjection, error)
	passDone func()
}

// One goroutine owns acquisitions for the entire socket, including rebinds.
// claim, dirty and cancel are protected by conn.stateMu; result state is local
// to run. A replacement cancels the old read, never starts a concurrent reader.
type todoWatch struct {
	conn    *connection
	wake    chan struct{}
	claim   queryBinding
	dirty   bool
	cancel  context.CancelFunc
	options todoWatchOptions
}

func (c *connection) invalidateTodoWatchLocked() {
	c.todoBindingID = ""
	if c.todo != nil {
		c.todo.claim = queryBinding{}
		if c.todo.cancel != nil {
			c.todo.cancel()
		}
	}
}

// Called only after the ready announcement has passed the socket writer.
func (c *connection) startTodoWatch(claim queryBinding) {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	if !c.queryCurrentLocked(claim) || claim.bindingID == "" {
		return
	}
	if c.todo == nil {
		w := &todoWatch{conn: c, wake: make(chan struct{}, 1)}
		if c.bridge.cfg.todoWatch != nil {
			w.options = *c.bridge.cfg.todoWatch
		}
		if w.options.read == nil {
			w.options.read = func(ctx context.Context, s *session.Session) (session.TodoProjection, error) {
				return s.ReadTodoProjection(ctx)
			}
		}
		c.todo = w
		go w.run()
	}
	if c.todo.claim == claim {
		return
	}
	if c.todo.cancel != nil {
		c.todo.cancel()
	}
	c.todo.claim, c.todo.dirty = claim, true
	select {
	case c.todo.wake <- struct{}{}:
	default:
	}
}

func (c *connection) markTodoDirty(claim queryBinding) {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	if c.todo != nil && c.queryCurrentLocked(claim) && c.todo.claim.session == claim.session {
		c.todo.dirty = true
	}
}

func todoInvalidation(f session.Frame) bool {
	switch f.Kind {
	case session.FrameRunDone, session.FrameCompactionDone:
		return true
	case session.FrameTool:
		phase := stringField(dataMap(f.Data), "phase")
		return phase == "end" || phase == "done"
	case session.FrameEntries:
		entries, ok := f.Data.(session.EntriesFrame)
		return ok && entries.Final
	default:
		return false
	}
}

type todoStamp struct {
	file    goalFileStamp
	present bool
}

func (s todoStamp) equal(other todoStamp) bool {
	return s.present == other.present && (!s.present || s.file.equal(other.file))
}

func statTodo(path string) (todoStamp, error) {
	info, err := fileid.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return todoStamp{}, nil
	}
	if err != nil {
		return todoStamp{}, err
	}
	if !info.Mode().IsRegular() {
		return todoStamp{}, errGoalStampTransient
	}
	stamp, present := goalStampFromInfo(info)
	return todoStamp{file: stamp, present: present}, nil
}

func (w *todoWatch) run() {
	timer := time.NewTimer(todoWatchInterval)
	defer timer.Stop()
	ticks := w.options.ticks
	if ticks == nil {
		ticks = timer.C
	}
	var previous queryBinding
	var signature []byte
	var stamp todoStamp
	var acknowledged bool
	var generation int64
	for {
		tick := false
		select {
		case <-w.conn.ctx.Done():
			return
		case <-w.wake:
		case <-ticks:
			tick = true
		}
		// Reset from each acquisition window, rather than polling after a fixed
		// sleep. Hints received during a read remain one dirty bit for the next tick.
		timer.Reset(todoWatchInterval)
		func() {
			if w.options.passDone != nil {
				defer w.options.passDone()
			}
			w.conn.stateMu.Lock()
			claim := w.claim
			w.conn.stateMu.Unlock()
			if claim.session == nil {
				return
			}
			initial := claim != previous
			if initial {
				previous, signature, acknowledged, generation = claim, nil, false, 0
			}
			observed, statErr := statTodo(claim.session.SessionFile())
			run := claim.session.RunSnapshot()
			w.conn.stateMu.Lock()
			if w.claim != claim || !w.conn.queryCurrentLocked(claim) || (!initial && (!tick || (!w.dirty && acknowledged && statErr == nil && observed.equal(stamp) && !run.Streaming && !run.Compacting))) {
				w.conn.stateMu.Unlock()
				return
			}
			ctx, cancel := context.WithTimeout(w.conn.ctx, todoWatchInterval)
			w.cancel, w.dirty = cancel, false
			w.conn.stateMu.Unlock()
			timer.Reset(todoWatchInterval)
			projection, err := w.options.read(ctx, claim.session)
			if err == nil {
				err = ctx.Err()
			}
			cancel()
			generation++
			frame := todoToWire(claim, projection, err)
			// Acquisitions correlate delivery; they do not make identical state new.
			encoded, marshalErr := json.Marshal(frame)
			if marshalErr != nil {
				w.conn.bridge.cfg.Logger.Error("encoding todo projection", "error", marshalErr)
				w.conn.shutdown()
				return
			}
			if err == nil && statErr == nil {
				stamp, acknowledged = observed, true
			} else {
				acknowledged = false
			}
			if bytes.Equal(signature, encoded) {
				return
			}
			frame.RequestGeneration = generation
			if err := w.conn.writeIfCurrent(claim, frame); err != nil {
				w.conn.bridge.cfg.Logger.Debug("writing todo projection", "error", err)
				w.conn.shutdown()
				return
			}
			signature = encoded
		}()
	}
}

func todoToWire(claim queryBinding, projection session.TodoProjection, err error) wscontract.ChatTodoFrame {
	frame := wscontract.ChatTodoFrame{Type: "chat.todo", SessionID: claim.chatID, DurableSessionID: claim.session.ID(), BindingID: claim.bindingID, Status: "ready"}
	if err != nil {
		code := session.TodoProjectionErrorCode(err)
		frame.Status, frame.Error = "unavailable", &code
		return frame
	}
	source := projection.Source
	frame.Source = &wscontract.TodoSource{LeafID: source.LeafID, EntryID: source.EntryID, Kind: source.Kind}
	if source.EntryIndex != nil {
		index := int64(*source.EntryIndex)
		frame.Source.EntryIndex = &index
	}
	var phases []wscontract.TodoPhase
	if projection.Phases != nil {
		phases = make([]wscontract.TodoPhase, len(projection.Phases))
		for i, phase := range projection.Phases {
			tasks := make([]wscontract.TodoTask, len(phase.Tasks))
			for j, task := range phase.Tasks {
				tasks[j] = wscontract.TodoTask{Content: task.Content, Status: task.Status}
			}
			phases[i] = wscontract.TodoPhase{Name: phase.Name, Tasks: tasks}
		}
	}
	frame.Phases = &phases
	return frame
}
