package wsbridge

import (
	"context"
	"encoding/json"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
	"github.com/lxzan/gws"
)

// These tests exercise one socket's recovery lifecycle through the real
// broadcaster. Neither the recovery request nor delivery cancellation is
// invoked by the tests.
type subscriberBehaviorLog struct {
	mu   sync.Mutex
	body strings.Builder
}

func (l *subscriberBehaviorLog) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.body.Write(p)
}

func (l *subscriberBehaviorLog) has(t *testing.T, key, value string) bool {
	t.Helper()
	l.mu.Lock()
	body := l.body.String()
	l.mu.Unlock()
	for _, line := range strings.Split(strings.TrimSpace(body), "\n") {
		if line == "" {
			continue
		}
		var record map[string]any
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Fatal(err)
		}
		if record[key] == value {
			return true
		}
	}
	return false
}

type subscriberBehaviorFixture struct {
	h        *inPlaceBridgeHarness
	conn     *gws.Conn
	frames   *collector
	server   *connection
	log      *subscriberBehaviorLog
	chatID   string
	now      atomic.Int64
	bursts   int
	sequence int
}

func newSubscriberBehaviorFixture(t *testing.T, chatID string) *subscriberBehaviorFixture {
	t.Helper()
	f := &subscriberBehaviorFixture{h: newInPlaceBridgeHarnessWithHistory(t, chatID, 10), chatID: chatID, log: &subscriberBehaviorLog{}}
	f.now.Store(time.Date(2026, 9, 27, 0, 0, 0, 0, time.UTC).UnixNano())
	f.h.bridge.cfg.Now = func() time.Time { return time.Unix(0, f.now.Load()) }
	f.h.bridge.cfg.Logger = slog.New(slog.NewJSONHandler(f.log, nil))
	// Todo acquisition also calls get_entries. Keep this unrelated watcher
	// from consuming hydration fault injection or inflating hydrate counts.
	f.h.bridge.cfg.todoWatch = &todoWatchOptions{
		ticks: make(chan time.Time),
		read: func(context.Context, *session.Session) (session.TodoProjection, error) {
			return session.TodoProjection{}, nil
		},
	}
	return f
}

func (f *subscriberBehaviorFixture) connect(t *testing.T) {
	t.Helper()
	// h.connect sends v2; negotiate v3 on the same underlying harness instead.
	f.frames = &collector{notify: make(chan struct{}, 64), closed: make(chan struct{})}
	conn, _, err := gws.NewClient(f.frames, &gws.ClientOption{Addr: "ws" + strings.TrimPrefix(f.h.server.URL, "http")})
	if err != nil {
		t.Fatal(err)
	}
	f.conn = conn
	go conn.ReadLoop()
	t.Cleanup(func() {
		if err := conn.NetConn().Close(); err != nil {
			// The server normally closes exhausted sockets first.
			t.Logf("closing test socket: %v", err)
		}
	})
	f.frames.next(t, "hello")
	writeClient(t, conn, map[string]any{"type": "hello", "version": 3})
	f.server = f.h.soleServerConnection(t)
}

func (f *subscriberBehaviorFixture) create(t *testing.T) {
	t.Helper()
	writeClient(t, f.conn, map[string]any{
		"type": "chat.create", "wsId": "ws-1", "chatId": f.chatID,
		"resume": map[string]any{"sessionId": "", "firstEntryId": "", "lastEntryId": "", "historyComplete": false},
	})
	f.awaitHistory(t)
}

func (f *subscriberBehaviorFixture) awaitHistory(t *testing.T) []map[string]any {
	t.Helper()
	f.frames.next(t, "ready")
	var pages []map[string]any
	for {
		page := f.frames.next(t, "entries")
		pages = append(pages, page)
		if page["final"] == true {
			break
		}
	}
	// The terminal page reaching the client does not join server-side history
	// completion. Fence the create worker before advancing the injected clock
	// or starting the next burst.
	awaitCommandFence(t, f.conn, f.frames)
	return pages
}

func (f *subscriberBehaviorFixture) ingestNotices(t *testing.T, count int) {
	t.Helper()
	sess, ok := f.h.manager.Get(f.chatID)
	if !ok {
		t.Fatal("session was not published")
	}
	observer := &overflowNoticeObserver{frames: make(chan session.Frame, 1024)}
	detach := sess.Attach(observer)
	defer detach()
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	for range count {
		f.sequence++
		f.h.daemon.EmitSession(f.h.path, map[string]any{"type": "extension_notify", "seq": f.sequence})
		for {
			select {
			case frame := <-observer.frames:
				data, ok := frame.Data.(map[string]any)
				if frame.Kind == session.FrameNotice && ok && data["seq"] == json.Number(strconv.Itoa(f.sequence)) {
					goto observed
				}
			case <-timer.C:
				t.Fatalf("notice %d was not ingested", f.sequence)
			}
		}
	observed:
	}
}

func (f *subscriberBehaviorFixture) overflow(t *testing.T) {
	t.Helper()
	f.server.outboundMu.Lock()
	unlock := sync.OnceFunc(f.server.outboundMu.Unlock)
	defer unlock()
	// A recovered subscription sizes its queue for the retained transfer.
	// Grow each burst past that queue, while staying below the 256-frame
	// transfer limit even for all seven bursts in the reset cases.
	f.ingestNotices(t, 80+24*f.bursts)
	f.bursts++
	unlock()
}

func (f *subscriberBehaviorFixture) awaitClosed(t *testing.T) {
	t.Helper()
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	select {
	case <-f.server.ctx.Done():
	case <-timer.C:
		t.Fatal("failed recovery did not cancel the connection")
	}
	select {
	case <-f.frames.closed:
	case <-timer.C:
		t.Fatal("failed recovery did not close the actual websocket")
	}
	if !f.log.has(t, "reason", "subscriber_recovery_exhausted") {
		t.Fatal("closed recovery did not log reason=subscriber_recovery_exhausted")
	}
}

func TestSubscriberRecoveryBudgetAndResets(t *testing.T) {
	for _, reset := range []string{"exhausted", "healthy-window", "explicit-create"} {
		t.Run(reset, func(t *testing.T) {
			// Given: a live v3 socket with three successful automatic recoveries.
			f := newSubscriberBehaviorFixture(t, "budget-"+reset)
			f.connect(t)
			f.create(t)
			baseline := f.h.daemon.RequestCount(omorpc.CmdGetEntries)
			recoverThree := func() {
				t.Helper()
				for attempt := 1; attempt <= 3; attempt++ {
					f.overflow(t)
					f.awaitHistory(t)
					if got := f.h.daemon.RequestCount(omorpc.CmdGetEntries); got != baseline+attempt {
						t.Fatalf("recovery %d performed %d hydrations, want %d", attempt, got-baseline, attempt)
					}
				}
			}
			recoverThree()

			// When: only a healthy interval or an explicit client create resets
			// the budget; automatic create must not reset its own counter.
			switch reset {
			case "healthy-window":
				f.now.Add(int64(121 * time.Second))
			case "explicit-create":
				f.create(t)
			}
			if reset != "exhausted" {
				baseline = f.h.daemon.RequestCount(omorpc.CmdGetEntries)
				recoverThree()
			}
			before := f.h.daemon.RequestCount(omorpc.CmdGetEntries)
			f.overflow(t)

			// Then: the fourth failure closes, without a fourth hydration.
			failure := f.frames.next(t, "error")
			if failure["code"] != "subscriber_overflow" {
				t.Fatalf("exhaustion error = %#v", failure)
			}
			f.awaitClosed(t)
			if got := f.h.daemon.RequestCount(omorpc.CmdGetEntries); got != before {
				t.Fatalf("exhausted recovery hydrated again: before=%d after=%d", before, got)
			}
		})
	}
}

func TestSubscriberRecoveryResumesOnlyDeliveredTerminalHistory(t *testing.T) {
	for _, terminalDelivered := range []bool{false, true} {
		name := "before-terminal"
		if terminalDelivered {
			name = "after-terminal"
		}
		t.Run(name, func(t *testing.T) {
			// Given: either complete history or a hydration held before it can
			// deliver any terminal page.
			f := newSubscriberBehaviorFixture(t, "resume-"+name)
			f.connect(t)
			if terminalDelivered {
				f.create(t)
			} else {
				release := f.h.daemon.BlockHandler(omorpc.CmdGetEntries)
				defer release()
				writeClient(t, f.conn, map[string]any{
					"type": "chat.create", "wsId": "ws-1", "chatId": f.chatID, "recovery": true,
					"resume": map[string]any{"sessionId": "", "firstEntryId": "", "lastEntryId": "", "historyComplete": false},
				})
				if !f.h.daemon.AwaitRequestCount(omorpc.CmdGetEntries, 1, 5*time.Second) {
					t.Fatal("initial hydration did not enter the history barrier")
				}
				f.overflow(t)
				release()
			}

			// When: real broadcaster pressure forces history to be reattached.
			if terminalDelivered {
				f.overflow(t)
			}
			pages := f.awaitHistory(t)

			// Then: accepted continuity echoes the delivered range and omits
			// its entries. Without a terminal, recovery must send fresh history.
			count := 0
			for _, page := range pages {
				count += len(wirePageIDs(t, page))
				if terminalDelivered {
					resume, ok := page["resume"].(map[string]any)
					if !ok || resume["sessionId"] != "durable-"+f.chatID || resume["firstEntryId"] != "root" || resume["lastEntryId"] != "entry-9" || resume["historyComplete"] != true {
						t.Fatalf("lost delivered resume range: %#v", page)
					}
				} else if page["resume"] != nil {
					t.Fatalf("undelivered history was claimed by resume: %#v", page)
				}
			}
			want := 10
			if terminalDelivered {
				want = 0
			}
			if count != want {
				t.Fatalf("recovery delivered %d entries, want %d", count, want)
			}
			if got := f.h.daemon.RequestCount(omorpc.CmdGetEntries); got != 2 {
				t.Fatalf("overflow did not perform exactly one replacement hydration: %d", got)
			}
		})
	}
}

func TestSubscriberRecoveryTerminalFailuresCloseAndLog(t *testing.T) {
	for _, cause := range []string{"saturated-transfer", "hydrate-failure"} {
		t.Run(cause, func(t *testing.T) {
			// Given: an attached socket and either a real saturated transfer
			// or a provider error on the replacement history request.
			f := newSubscriberBehaviorFixture(t, "terminal-"+cause)
			f.connect(t)
			f.create(t)
			before := f.h.daemon.RequestCount(omorpc.CmdGetEntries)
			if cause == "hydrate-failure" {
				f.h.daemon.FailNext(omorpc.CmdGetEntries, "QA_RECOVERY_HYDRATE_FAILED")
				f.overflow(t)
			} else {
				f.server.outboundMu.Lock()
				unlock := sync.OnceFunc(f.server.outboundMu.Unlock)
				defer unlock()
				f.ingestNotices(t, session.SubscriberOverflowTransferCapacity+2)
				unlock()
			}

			// Then: transport closure, not merely an error frame, is the
			// terminal outcome and records the stable exhaustion diagnostic.
			f.frames.next(t, "error")
			f.awaitClosed(t)
			want := before
			if cause == "hydrate-failure" {
				want++
			}
			if got := f.h.daemon.RequestCount(omorpc.CmdGetEntries); got != want {
				t.Fatalf("terminal recovery history requests = %d, want %d", got, want)
			}
		})
	}
}
