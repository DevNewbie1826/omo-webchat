package omorpc

import (
	"context"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type withheldReadErrorConn struct {
	net.Conn
	once     sync.Once
	observed chan struct{}
	release  chan struct{}
}

func (c *withheldReadErrorConn) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	if err != nil {
		c.once.Do(func() { close(c.observed) })
		<-c.release
	}
	return n, err
}

func TestEnsureConnectedAfterWaitsForNegotiatedSuccessorWithOldEOFWithheld(t *testing.T) {
	d := newMockDaemon(t)
	d.SetServerVersion("successor-version")
	cfg := normalizeConfig(Config{
		ReconnectInitial:     time.Millisecond,
		ReconnectMax:         time.Millisecond,
		ReconnectMaxAttempts: 4,
	})
	lifecycle, cancel := context.WithCancel(context.Background())
	oldClient, oldPeer := net.Pipe()
	oldRead := &withheldReadErrorConn{Conn: oldClient, observed: make(chan struct{}), release: make(chan struct{})}
	retiringEpoch := &connectionEpoch{number: 1, conn: oldRead, events: newEventStream(cfg.EventBuffer, new(atomic.Uint64)), negotiated: true}
	client := &Client{
		socketPath: d.SocketPath(), cfg: cfg, lifecycle: lifecycle, cancel: cancel,
		epoch: 1, current: retiringEpoch, pending: make(map[string]pendingRequest),
		info: &ProtocolInfo{ServerVersion: "retiring-version"}, writeGate: make(chan struct{}, 1),
	}
	client.writeGate <- struct{}{}
	client.wg.Add(1)
	go func() {
		defer client.wg.Done()
		client.readLoop(retiringEpoch)
	}()
	t.Cleanup(func() {
		close(oldRead.release)
		_ = client.Close()
	})
	retired := EpochToken{epoch: retiringEpoch}

	// The peer is gone, but its reader is deliberately parked before it can
	// publish EOF. This is the stale-current window that previously let a
	// restart accept the old negotiated epoch.
	_ = oldPeer.Close()
	select {
	case <-oldRead.observed:
	case <-time.After(testAwaitTimeout):
		t.Fatal("old transport reader did not reach the withheld EOF boundary")
	}
	releaseHandshake := d.BlockHandler(CmdGetProtocolInfo)
	baseProtocolRequests := len(requestIDs(d, CmdGetProtocolInfo))

	client.FenceEpoch(retired)
	result := make(chan error, 1)
	go func() { result <- client.EnsureConnectedAfter(context.Background(), retired) }()
	d.awaitRequestCount(t, CmdGetProtocolInfo, baseProtocolRequests+1, testAwaitTimeout)
	select {
	case err := <-result:
		t.Fatalf("replacement completed before successor negotiation: %v", err)
	default:
	}

	releaseHandshake()
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("EnsureConnectedAfter: %v", err)
		}
	case <-time.After(testAwaitTimeout):
		t.Fatal("replacement did not complete after successor negotiation")
	}
	if client.EpochCurrent(retired) {
		t.Fatal("retiring epoch remained current")
	}
	if got := client.ServerVersion(); got != "successor-version" {
		t.Fatalf("negotiated server version = %q, want successor-version", got)
	}
	response, err := client.Call(t.Context(), ListSessions{})
	if err != nil || response == nil || !response.Success {
		t.Fatalf("shared client RPC after replacement: response=%+v err=%v", response, err)
	}
}
