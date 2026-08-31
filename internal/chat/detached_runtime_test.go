package chat

import (
	"context"
	"testing"
	"time"
)

func TestSessionDetachKeepsProcessAlive(t *testing.T) {
	manager := NewManager()
	t.Cleanup(manager.CloseAll)
	session, started, err := manager.Acquire(context.Background(), managedMockOptions(t, "chat-detached"))
	if err != nil {
		t.Fatalf("acquire session: %v", err)
	}
	if !started {
		t.Fatal("first acquire did not start the session")
	}
	writer := newCollectWriter()
	detach := session.Attach(writer)
	detach()
	detach()

	reused, started, err := manager.Acquire(context.Background(), managedMockOptions(t, "chat-detached"))
	if err != nil {
		t.Fatalf("reacquire detached session: %v", err)
	}
	if started {
		t.Fatal("detached session was replaced instead of reused")
	}
	if reused != session {
		t.Fatalf("reacquired session = %p, want %p", reused, session)
	}
	if err := session.QueryState(); err != nil {
		t.Fatalf("detached process no longer accepts commands: %v", err)
	}
}

func TestManagerAcquiresExistingSessionBeforeSweeper(t *testing.T) {
	manager := NewManager()
	manager.idleFor = 10 * time.Millisecond
	manager.now = time.Now
	session := &Session{id: "chat-idle", runDone: true, finishedAt: time.Now(), frames: newBroadcaster()}
	manager.sessions[session.ID()] = session
	reacquired, started, detach, err := manager.AcquireAttach(context.Background(), SessionOptions{ID: session.ID(), Binary: "unused"}, nil)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	if started || reacquired != session {
		t.Fatalf("acquire = (%p, %v), want existing %p", reacquired, started, session)
	}
	detach()
	manager.now = func() time.Time { return time.Now().Add(time.Hour) }
	manager.sweepOnce()
	if got := manager.Get(session.ID()); got != nil {
		t.Fatalf("sweeper did not reap idle finished session: %p", got)
	}
}

func TestManagerReapSkipsAttachedFinishedSession(t *testing.T) {
	manager := NewManager()
	session := &Session{id: "chat-attached-finished", runDone: true, finishedAt: time.Now().Add(-time.Hour), frames: newBroadcaster()}
	manager.sessions[session.ID()] = session
	session.Attach(discardFrameWriter{})
	if manager.ReapFinished(session.ID(), session) {
		t.Fatal("attached finished session was reaped despite live socket")
	}
	if got := manager.Get(session.ID()); got != session {
		t.Fatalf("attached session removed by reap: %p", got)
	}
}

func TestManagerSweepsIdleFinishedSessionWithoutReopen(t *testing.T) {
	manager := NewManager()
	session := &Session{id: "chat-swept", runDone: true, finishedAt: time.Now().Add(-time.Hour), frames: newBroadcaster()}
	manager.sessions[session.ID()] = session
	manager.sweepOnce()
	if got := manager.Get(session.ID()); got != nil {
		t.Fatalf("idle finished session remained registered after sweep: %p", got)
	}
	if session.ProcessAlive() {
		t.Fatal("idle finished session process remained alive after sweep")
	}
}

func TestManagerFinishedSessionStaysReusableBeforeIdleTimeout(t *testing.T) {
	manager := NewManager()
	session := &Session{id: "chat-attached", runDone: true, finishedAt: time.Now(), frames: newBroadcaster()}
	manager.sessions[session.ID()] = session
	reacquired, started, err := manager.Acquire(context.Background(), SessionOptions{ID: session.ID(), Binary: "unused"})
	if err != nil {
		t.Fatalf("reacquire attached finished session: %v", err)
	}
	if started || reacquired != session {
		t.Fatalf("reacquire = (%p, %v), want attached session %p", reacquired, started, session)
	}
}

func TestManagerReapFinishedStillGuardsExplicitCleanup(t *testing.T) {
	manager := NewManager()
	session := &Session{id: "chat-explicit", runDone: true, finishedAt: time.Now().Add(-time.Hour), frames: newBroadcaster()}
	manager.sessions[session.ID()] = session
	if !manager.ReapFinished(session.ID(), session) {
		t.Fatal("explicit reap did not close the finished session")
	}
	if got := manager.Get(session.ID()); got != nil {
		t.Fatalf("reaped session remained registered: %p", got)
	}
}

func TestManagerActiveSessionIsNotReaped(t *testing.T) {
	manager := NewManager()
	session := &Session{id: "chat-active", promptInFlight: true, frames: newBroadcaster()}
	manager.sessions[session.ID()] = session

	if manager.ReapFinished(session.ID(), session) {
		t.Fatal("active session was reaped")
	}
	if got := manager.Get(session.ID()); got != session {
		t.Fatalf("active session removed: current=%p, want %p", got, session)
	}
}
