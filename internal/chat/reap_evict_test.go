package chat

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"sync"
	"testing"
	"time"
)

func startExitProcess(t *testing.T, code int) *Process {
	t.Helper()
	shell, err := exec.LookPath("sh")
	if err != nil {
		t.Skipf("sh not in PATH: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	proc, err := Start(ctx, ProcessOptions{Binary: shell, Args: []string{"-c", fmt.Sprintf("exit %d", code)}})
	if err != nil {
		t.Fatalf("start process: %v", err)
	}
	events := make(chan Event)
	go proc.Events(events)
	for range events {
	}
	return proc
}

func exitCodeOf(err error) int {
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitCode()
	}
	return -1000
}

// Every close path (pump EOF reap, Session.Close, Manager.Stop) converges on
// Process.Close. cmd.Wait must run exactly once: the second caller gets the
// cached result, never "Wait was already called".
func TestProcessCloseReapsExactlyOnce(t *testing.T) {
	proc := startExitProcess(t, 3)
	first := proc.Close()
	if exitCodeOf(first) != 3 {
		t.Fatalf("first close error = %v, want exit status 3", first)
	}
	second := proc.Close()
	if exitCodeOf(second) != 3 {
		t.Fatalf("second close error = %v, want cached exit status 3", second)
	}
}

func TestProcessConcurrentCloseReapsExactlyOnce(t *testing.T) {
	proc := startExitProcess(t, 4)
	start := make(chan struct{})
	var wg sync.WaitGroup
	errs := make(chan error, 12)
	for range 12 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			errs <- proc.Close()
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		if exitCodeOf(err) != 4 {
			t.Fatalf("concurrent close error = %v, want cached exit status 4", err)
		}
	}
}

// When the provider process dies on its own, the manager entry for exactly
// that session must disappear so a reconnect starts fresh instead of routing
// commands to a corpse.
func TestManagerEvictsSessionOnUnexpectedEOF(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skipf("node not in PATH: %v", err)
	}
	manager := NewManager()
	t.Cleanup(manager.CloseAll)
	exited := make(chan *Session, 1)
	opts := SessionOptions{
		ID:     "chat-eof",
		Binary: node,
		Args:   []string{"-e", `let b='';process.stdin.on('data',c=>{b+=c;const n=b.indexOf('\n');if(n<0)return;const x=JSON.parse(b.slice(0,n));process.stdout.write(JSON.stringify({type:'response',command:'open_session',success:true,id:x.id,sessionId:'rpc-1',data:{sessionId:'rpc-1',state:{sessionId:'durable-1'}}})+'\n',()=>setImmediate(()=>process.exit(0)))})`, "--"},
		OnExit: func(s *Session) { exited <- s },
	}
	session, _, err := manager.Acquire(context.Background(), opts)
	if err != nil {
		t.Fatalf("start session: %v", err)
	}
	select {
	case got := <-exited:
		if got != session {
			t.Fatalf("exit hook session = %p, want %p", got, session)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("unexpected EOF did not fire the exit hook")
	}
	if current := manager.Get("chat-eof"); current != nil {
		t.Fatalf("manager still serves evicted session %p", current)
	}
}

// Closing one routed logical session must not evict or finish another session
// served by the same shared provider process.
func TestManagerCloseSessionSparesOtherRoutedSessions(t *testing.T) {
	manager := NewManager()
	t.Cleanup(manager.CloseAll)

	first, _, err := manager.Acquire(context.Background(), managedMockOptions(t, "chat-x"))
	if err != nil {
		t.Fatalf("start first: %v", err)
	}
	second, _, err := manager.Acquire(context.Background(), managedMockOptions(t, "chat-x"))
	if err != nil {
		t.Fatalf("start second: %v", err)
	}
	if second != first {
		t.Fatalf("acquire replaced the live session: first=%p second=%p", first, second)
	}
	keeper, _, err := manager.Acquire(context.Background(), managedMockOptions(t, "chat-z"))
	if err != nil {
		t.Fatalf("start keeper: %v", err)
	}

	// Closing one logical session is a close_session RPC, not provider EOF.
	// The other routed session must remain live and usable.
	manager.Stop("chat-x")
	if current := manager.Get("chat-z"); current != keeper {
		t.Fatalf("closing chat-x evicted chat-z: %p, want %p", current, keeper)
	}
	if err := keeper.QueryState(); err != nil {
		t.Fatalf("keeper no longer accepts commands: %v", err)
	}
}
