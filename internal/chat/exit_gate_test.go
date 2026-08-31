package chat

import (
	"context"
	"os/exec"
	"testing"
	"time"
)

func TestExitGateBuffersUntilOpen(t *testing.T) {
	var fired []*Session
	gate := newExitGate(func(s *Session) {
		fired = append(fired, s)
	})
	session := &Session{id: "chat-1"}

	gate.fire(session)
	if len(fired) != 0 {
		t.Fatalf("exit callback ran %d times before open, want 0", len(fired))
	}

	gate.open()
	if len(fired) != 1 {
		t.Fatalf("open replayed %d callbacks, want exactly 1", len(fired))
	}
	if fired[0] != session {
		t.Fatalf("replay ran for session %p, want %p", fired[0], session)
	}
}

// The exact audit sequence: EOF fires before registration, registration
// happens, then the gate replays. The eviction must see the live map entry
// and remove exactly the exited session.
func TestExitGateReplayEvictsExactRegisteredSession(t *testing.T) {
	if _, err := exec.LookPath("sleep"); err != nil {
		t.Skipf("sleep not in PATH: %v", err)
	}
	manager := NewManager()
	t.Cleanup(manager.CloseAll)
	session, err := StartSession(context.Background(), sleepOpts("chat-gate"))
	if err != nil {
		t.Fatalf("start session: %v", err)
	}
	t.Cleanup(func() {
		if err := session.Close(); err != nil {
			t.Errorf("close session: %v", err)
		}
	})

	hooked := 0
	gate := newExitGate(func(source *Session) {
		manager.StopIfCurrent(source.ID(), source)
		hooked++
	})

	gate.fire(session) // EOF before registration: buffered, nothing may run
	if hooked != 0 {
		t.Fatalf("exit callback ran before open: hooked=%d", hooked)
	}

	manager.mu.Lock()
	manager.sessions["chat-gate"] = session
	manager.mu.Unlock()

	gate.open()

	if hooked != 1 {
		t.Fatalf("exit callback ran %d times after open, want 1", hooked)
	}
	if current := manager.Get("chat-gate"); current != nil {
		t.Fatalf("dead session %p remained registered after gated exit replay", current)
	}
}

// A buffered exit for a session that was replaced before replay must miss:
// the eviction matches the exact session pointer, never the map slot.
func TestExitGateReplaySparesReplacement(t *testing.T) {
	if _, err := exec.LookPath("sleep"); err != nil {
		t.Skipf("sleep not in PATH: %v", err)
	}
	manager := NewManager()
	t.Cleanup(manager.CloseAll)
	stale, err := StartSession(context.Background(), sleepOpts("chat-swap"))
	if err != nil {
		t.Fatalf("start stale session: %v", err)
	}
	t.Cleanup(func() {
		if err := stale.Close(); err != nil {
			t.Errorf("close stale session: %v", err)
		}
	})
	replacement, err := StartSession(context.Background(), sleepOpts("chat-swap"))
	if err != nil {
		t.Fatalf("start replacement session: %v", err)
	}
	t.Cleanup(func() {
		if err := replacement.Close(); err != nil {
			t.Errorf("close replacement session: %v", err)
		}
	})

	hookedFor := make(chan *Session, 1)
	gate := newExitGate(func(source *Session) {
		manager.StopIfCurrent(source.ID(), source)
		hookedFor <- source
	})

	gate.fire(stale)
	manager.mu.Lock()
	manager.sessions["chat-swap"] = replacement
	manager.mu.Unlock()
	gate.open()

	select {
	case got := <-hookedFor:
		if got != stale {
			t.Fatalf("exit hook ran for session %p, want the exited session %p", got, stale)
		}
	case <-time.After(time.Second):
		t.Fatal("buffered exit was not replayed on open")
	}
	if current := manager.Get("chat-swap"); current != replacement {
		t.Fatalf("exit replay removed the replacement: current=%p, want %p", current, replacement)
	}
}

// A provider that dies during Start must never stay registered, whatever the
// scheduling of its EOF against registration: the exit gate buffers the
// early notification and replays the eviction once the map entry exists.
func TestManagerStartNeverKeepsDeadSession(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skipf("node not in PATH: %v", err)
	}
	manager := NewManager()
	t.Cleanup(manager.CloseAll)
	exited := make(chan struct{})
	opts := SessionOptions{
		ID:              "chat-dead",
		Binary:          node,
		Args:            []string{"-e", `let b='';process.stdin.on('data',c=>{b+=c;const n=b.indexOf('\n');if(n<0)return;const x=JSON.parse(b.slice(0,n));process.stdout.write(JSON.stringify({type:'response',command:'open_session',success:true,id:x.id,sessionId:'rpc-1',data:{sessionId:'rpc-1',state:{sessionId:'durable-1'}}})+'\n',()=>process.exit(0))})`, "--"},
		OnExit:          func(*Session) { close(exited) },
		ProviderContext: context.Background(),
	}
	if _, _, err := manager.Acquire(context.Background(), opts); err != nil {
		t.Fatalf("start session: %v", err)
	}
	select {
	case <-exited:
	case <-time.After(3 * time.Second):
		t.Fatal("exit hook never ran for a provider that died during startup")
	}
	if current := manager.Get("chat-dead"); current != nil {
		t.Fatalf("dead session %p still registered after unexpected EOF", current)
	}
}
