package api

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lxzan/gws"

	"github.com/DevNewbie1826/omo-webchat/internal/chat"
)

type blockingCloseConn struct {
	net.Conn
	observeWrites atomic.Bool
	writeEntered  chan struct{}
	writeOnce     sync.Once
	closeStarted  chan struct{}
	closeReturned chan struct{}
	allowClose    chan struct{}
	closeOnce     sync.Once
	releaseOnce   sync.Once
}

func (c *blockingCloseConn) Write(p []byte) (int, error) {
	if c.observeWrites.Load() {
		c.writeOnce.Do(func() { close(c.writeEntered) })
	}
	return c.Conn.Write(p)
}

func (c *blockingCloseConn) releaseClose() {
	c.releaseOnce.Do(func() { close(c.allowClose) })
}

func (c *blockingCloseConn) Close() error {
	first := false
	c.closeOnce.Do(func() { first = true })
	if !first {
		return c.Conn.Close()
	}
	err := c.Conn.Close()
	close(c.closeStarted)
	<-c.allowClose
	close(c.closeReturned)
	return err
}

func blockedProductionWriter(t *testing.T) (*connHandler, *blockingCloseConn) {
	t.Helper()
	serverNetConn, clientNetConn := net.Pipe()
	wrappedServerConn := &blockingCloseConn{
		Conn:          serverNetConn,
		writeEntered:  make(chan struct{}),
		closeStarted:  make(chan struct{}),
		closeReturned: make(chan struct{}),
		allowClose:    make(chan struct{}),
	}
	t.Cleanup(func() {
		wrappedServerConn.releaseClose()
		_ = clientNetConn.Close()
	})

	upgrader := gws.NewUpgrader(gws.BuiltinEventHandler{}, nil)
	type upgradeResult struct {
		conn *gws.Conn
		err  error
	}
	upgraded := make(chan upgradeResult, 1)
	go func() {
		reader := bufio.NewReader(wrappedServerConn)
		request, err := http.ReadRequest(reader)
		if err != nil {
			upgraded <- upgradeResult{err: err}
			return
		}
		conn, err := upgrader.UpgradeFromConn(wrappedServerConn, reader, request)
		upgraded <- upgradeResult{conn: conn, err: err}
	}()

	client, _, err := gws.NewClientFromConn(gws.BuiltinEventHandler{}, &gws.ClientOption{Addr: "ws://production-writer.test"}, clientNetConn)
	if err != nil {
		t.Fatalf("create WebSocket client: %v", err)
	}
	_ = client // Keeping the real peer open without a ReadLoop makes net.Pipe writes block.
	result := <-upgraded
	if result.err != nil {
		t.Fatalf("upgrade server WebSocket: %v", result.err)
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	return &connHandler{srv: &Server{logger: logger}, conn: result.conn}, wrappedServerConn
}

func TestConnHandlerCancellationReleasesBlockedProductionWriter(t *testing.T) {
	writer, wrappedServerConn := blockedProductionWriter(t)
	var canceller chat.FrameWriterCanceller = writer

	wrappedServerConn.observeWrites.Store(true)
	deliveryReturned := make(chan error, 1)
	go func() { deliveryReturned <- writer.WriteJSON([]byte(`{"type":"blocked"}`)) }()
	select {
	case <-wrappedServerConn.writeEntered:
	case <-time.After(time.Second):
		t.Fatal("production WriteJSON did not enter the blocked network write")
	}

	// The underlying Close intentionally remains blocked after releasing the
	// network write. Every cancellation call must still return immediately.
	const callers = 16
	cancelReturned := make(chan struct{}, callers)
	for i := 0; i < callers; i++ {
		go func() {
			_ = canceller.Close()
			cancelReturned <- struct{}{}
		}()
	}
	for i := 0; i < callers; i++ {
		select {
		case <-cancelReturned:
		case <-time.After(time.Second):
			t.Fatal("connHandler cancellation blocked its caller")
		}
	}
	select {
	case <-wrappedServerConn.closeStarted:
	case <-time.After(time.Second):
		t.Fatal("cancellation did not close the underlying network connection")
	}
	select {
	case err := <-deliveryReturned:
		if err == nil {
			t.Fatal("blocked production WriteJSON returned nil after cancellation")
		}
	case <-time.After(time.Second):
		t.Fatal("blocked production delivery goroutine was not released")
	}

	// Release and observe the asynchronous Close itself so the test leaves no
	// cancellation-shaped goroutine behind.
	wrappedServerConn.releaseClose()
	select {
	case <-wrappedServerConn.closeReturned:
	case <-time.After(time.Second):
		t.Fatal("asynchronous network-close goroutine did not exit")
	}
}

type replayFrameCollector struct {
	frames chan string
}

func (c *replayFrameCollector) WriteJSON(frame []byte) error {
	var envelope struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(frame, &envelope) == nil {
		c.frames <- envelope.Type
	}
	return nil
}

func (c *replayFrameCollector) waitFor(t *testing.T, want string) {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case got := <-c.frames:
			if got == want {
				return
			}
		case <-deadline:
			t.Fatalf("timed out waiting for %q frame", want)
		}
	}
}

func TestActivitySnapshotReplayCancellationReleasesManagerAndLifecycle(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skipf("node not in PATH: %v", err)
	}
	_, file, _, _ := runtime.Caller(0)
	script := filepath.Join(filepath.Dir(file), "..", "..", "test", "mock-pi", "mock-pi.mjs")
	if _, err := os.Stat(script); err != nil {
		t.Skipf("mock-pi not found: %v", err)
	}

	manager := chat.NewManager()
	t.Cleanup(manager.CloseAll)
	exited := make(chan struct{})
	var exitOnce sync.Once
	opts := chat.SessionOptions{
		ID:     "chat-blocked-replay",
		Binary: node,
		Args:   []string{script},
		Env:    append(os.Environ(), "MOCK_PI_EXT_EVENT=1"),
		OnExit: func(*chat.Session) { exitOnce.Do(func() { close(exited) }) },
	}
	collector := &replayFrameCollector{frames: make(chan string, 64)}
	session, started, detach, err := manager.AcquireAttach(context.Background(), opts, collector)
	if err != nil {
		t.Fatalf("start managed session: %v", err)
	}
	if !started {
		t.Fatal("first acquire did not start the session")
	}
	if err := session.SendPrompt("cache activity snapshots", nil); err != nil {
		t.Fatalf("send prompt: %v", err)
	}
	collector.waitFor(t, "run.done")
	detach()

	writer, blockedConn := blockedProductionWriter(t)
	blockedConn.observeWrites.Store(true)
	type attachResult struct {
		session *chat.Session
		err     error
	}
	attached := make(chan attachResult, 1)
	go func() {
		s, _, _, err := manager.AcquireAttach(context.Background(), opts, writer)
		attached <- attachResult{session: s, err: err}
	}()
	select {
	case <-blockedConn.writeEntered:
	case <-time.After(time.Second):
		t.Fatal("cached activity replay did not enter the blocked production writer")
	}

	// Attach has already registered and snapshotted this writer, but neither
	// manager nor lifecycle state may remain locked during its network write.
	gotSession := make(chan *chat.Session, 1)
	go func() { gotSession <- manager.Get(opts.ID) }()
	select {
	case got := <-gotSession:
		if got != session {
			t.Fatal("manager route changed while replay was blocked")
		}
	case <-time.After(time.Second):
		t.Fatal("manager lock remained held across snapshot replay")
	}
	lifecycleReturned := make(chan bool, 1)
	go func() { lifecycleReturned <- session.IsFinished() }()
	select {
	case <-lifecycleReturned:
	case <-time.After(time.Second):
		t.Fatal("lifecycle lock remained held across snapshot replay")
	}

	// A following routed response flows while the replay writer is wedged:
	// delivery no longer runs the network write inline, so the query completes
	// and its response frame merely queues behind the blocked replay FIFO.
	if err := session.QueryState(); err != nil {
		t.Fatalf("query state behind blocked replay: %v", err)
	}
	// Saturate the wedged subscriber's bounded FIFO (64 slots plus the frame
	// held inside the blocked WriteJSON): the overflow detaches exactly that
	// subscriber — its blocked writer is closed via the canceller — while the
	// session and route stay live (slow clients no longer tear sessions down).
	for i := 0; i < 70; i++ {
		if err := session.QueryState(); err != nil {
			t.Fatalf("query %d behind blocked replay: %v", i+1, err)
		}
	}
	select {
	case <-blockedConn.closeStarted:
	case <-time.After(8 * time.Second):
		t.Fatal("overflowed replay subscriber was not cancelled")
	}
	select {
	case result := <-attached:
		if result.err != nil {
			t.Fatalf("attach returned an error after cancellation: %v", result.err)
		}
		if result.session != session {
			t.Fatal("attach returned a different session")
		}
	case <-time.After(time.Second):
		t.Fatal("snapshot replay did not release the delivery barrier")
	}
	if got := manager.Get(opts.ID); got != session {
		t.Fatal("slow subscriber evicted the session")
	}
	if !session.ProcessAlive() {
		t.Fatal("slow subscriber tore down the live session")
	}
	blockedConn.releaseClose()
	select {
	case <-blockedConn.closeReturned:
	case <-time.After(time.Second):
		t.Fatal("asynchronous replay cancellation did not finish closing the connection")
	}
}
