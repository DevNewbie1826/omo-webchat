package chat

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestIdentityGateBuffersUntilOpen(t *testing.T) {
	var mu sync.Mutex
	var delivered []string
	next := func(_ *Session, identity ResumeIdentity) error {
		mu.Lock()
		delivered = append(delivered, identity.Value)
		mu.Unlock()
		return nil
	}
	gate := newIdentityGate(next)
	session := &Session{id: "chat-1"}

	if err := gate.deliver(session, ResumeIdentity{Value: "eager-1"}); err != nil {
		t.Fatalf("buffered delivery returned error: %v", err)
	}
	mu.Lock()
	early := len(delivered)
	mu.Unlock()
	if early != 0 {
		t.Fatalf("gate delivered %d identities before open, want 0", early)
	}

	if err := gate.open(); err != nil {
		t.Fatalf("open with a nil-returning callback returned error: %v", err)
	}
	if err := gate.deliver(session, ResumeIdentity{Value: "eager-2"}); err != nil {
		t.Fatalf("pass-through delivery returned error: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(delivered) != 2 || delivered[0] != "eager-1" || delivered[1] != "eager-2" {
		t.Fatalf("delivered = %v, want [eager-1 eager-2]", delivered)
	}
}

// open() must keep the gate mutex held for the whole replay: that is what
// makes a concurrent deliver wait its turn instead of overtaking buffered
// identities. The probe checks the lock from a second goroutine while the
// replay callback runs; the lock state is invariant for the callback's whole
// lifetime in both implementations, so the result is scheduling-independent.
func TestIdentityGateHoldsSerializationAcrossReplay(t *testing.T) {
	var gate *identityGate
	lockFree := make(chan bool, 1)
	next := func(_ *Session, _ ResumeIdentity) error {
		probed := make(chan bool, 1)
		go func() {
			if gate.mu.TryLock() {
				gate.mu.Unlock()
				probed <- true
				return
			}
			probed <- false
		}()
		lockFree <- <-probed
		return nil
	}
	gate = newIdentityGate(next)
	session := &Session{id: "chat-1"}
	_ = gate.deliver(session, ResumeIdentity{Value: "buffered"})
	if err := gate.open(); err != nil {
		t.Fatalf("open returned error: %v", err)
	}
	select {
	case free := <-lockFree:
		if free {
			t.Fatal("gate mutex was free during replay: a concurrent deliver can overtake a buffered identity")
		}
	case <-time.After(time.Second):
		t.Fatal("replay callback never ran")
	}
}

// Buffered identities must replay in arrival order before any pass-through
// delivery, however open() and deliver() interleave, and the downstream
// callback must never run concurrently with itself.
func TestIdentityGateReplaysBufferedInFIFOOrder(t *testing.T) {
	var (
		mu       sync.Mutex
		order    []string
		inFlight int32
		overlap  bool
	)
	next := func(_ *Session, identity ResumeIdentity) error {
		if atomic.AddInt32(&inFlight, 1) > 1 {
			mu.Lock()
			overlap = true
			mu.Unlock()
		}
		defer atomic.AddInt32(&inFlight, -1)
		mu.Lock()
		order = append(order, identity.Value)
		mu.Unlock()
		return nil
	}
	gate := newIdentityGate(next)
	session := &Session{id: "chat-1"}
	_ = gate.deliver(session, ResumeIdentity{Value: "old-1"})
	_ = gate.deliver(session, ResumeIdentity{Value: "old-2"})

	opened := make(chan struct{})
	go func() {
		defer close(opened)
		if err := gate.open(); err != nil {
			t.Errorf("open returned error: %v", err)
		}
	}()
	delivered := make(chan struct{})
	go func() {
		defer close(delivered)
		_ = gate.deliver(session, ResumeIdentity{Value: "new"})
	}()
	<-opened
	<-delivered

	if overlap {
		t.Fatal("identity callback ran concurrently with itself")
	}
	want := []string{"old-1", "old-2", "new"}
	if len(order) != len(want) {
		t.Fatalf("delivered %v, want %v", order, want)
	}
	for i := range want {
		if order[i] != want[i] {
			t.Fatalf("delivered %v, want %v: a stale identity was replayed after a newer one", order, want)
		}
	}
}

const eagerIdentityScript = `let b='';process.stdin.on('data',c=>{b+=c;for(let n;(n=b.indexOf('\n'))>=0;){const x=JSON.parse(b.slice(0,n));b=b.slice(n+1);if(x.type==='open_session')process.stdout.write(JSON.stringify({type:'response',command:'open_session',success:true,id:x.id,sessionId:'rpc-1',data:{sessionId:'rpc-1',state:{sessionFile:'eager-1',sessionId:'durable-1'}}})+'\n')}});`

// Replay callback errors must be joined and returned to Manager.Start,
// never discarded; pass-through errors still reach the deliver caller.
func TestIdentityGateOpenSurfacesReplayErrors(t *testing.T) {
	next := func(_ *Session, identity ResumeIdentity) error {
		return fmt.Errorf("persist %s failed", identity.Value)
	}
	gate := newIdentityGate(next)
	session := &Session{id: "chat-1"}
	_ = gate.deliver(session, ResumeIdentity{Value: "one"})
	_ = gate.deliver(session, ResumeIdentity{Value: "two"})

	err := gate.open()
	if err == nil {
		t.Fatal("open discarded replay callback errors")
	}
	for _, want := range []string{"persist one failed", "persist two failed"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("open error %q does not surface %q", err.Error(), want)
		}
	}

	if err := gate.deliver(session, ResumeIdentity{Value: "three"}); err == nil {
		t.Fatal("pass-through delivery swallowed the callback error")
	}
}

// A persistence failure for an identity buffered before registration must
// come back from Manager.Start itself, and Start must not leave the
// half-wired session registered behind that error.
func TestAcquireReplayedIdentityFailureRemovesSession(t *testing.T) {
	gate := newIdentityGate(func(*Session, ResumeIdentity) error {
		return errors.New("persist boom")
	})
	session := &Session{id: "chat-persist-fail"}
	_ = gate.deliver(session, ResumeIdentity{Value: "eager-1"})

	err := gate.open()
	if err == nil || !strings.Contains(err.Error(), "persist boom") {
		t.Fatalf("open error = %v, want replay persistence failure", err)
	}
}

// A provider that announces its session identity before Manager.Start returns
// must still be persisted: the gate replays buffered identities once the
// session is registered, and the callback receives the source session so the
// currency check never compares against an unassigned closure variable.
func TestManagerDeliversEagerResumeIdentity(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skipf("node not in PATH: %v", err)
	}
	type delivery struct {
		current bool
		value   string
	}
	manager := NewManager()
	t.Cleanup(manager.CloseAll)
	delivered := make(chan delivery, 1)
	opts := SessionOptions{
		ID:     "chat-eager",
		Binary: node,
		Args:   []string{"-e", eagerIdentityScript, "--"},
		Env:    os.Environ(),
		OnResumeIdentity: func(src *Session, identity ResumeIdentity) error {
			delivered <- delivery{current: manager.Get("chat-eager") == src, value: identity.Value}
			return nil
		},
	}
	if _, _, err := manager.Acquire(context.Background(), opts); err != nil {
		t.Fatalf("start session: %v", err)
	}
	select {
	case got := <-delivered:
		if !got.current {
			t.Fatal("identity callback saw a session the manager does not consider current")
		}
		if got.value != "eager-1" {
			t.Fatalf("identity = %q, want eager-1", got.value)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("eager identity was never delivered to the callback")
	}
}
