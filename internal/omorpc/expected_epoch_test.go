package omorpc

import (
	"context"
	"errors"
	"testing"
)

func TestClientExpectedEpochCallsRejectTransitionWithoutWriting(t *testing.T) {
	d := newMockDaemon(t)
	c := dialForTest(t, d, Config{})
	expected, events := c.CurrentEpoch()
	if !c.EpochCurrent(expected) {
		t.Fatal("captured epoch was not current")
	}

	d.DropConnections()
	awaitChannelClosed(t, events, testAwaitTimeout)
	if _, err := c.Call(context.Background(), ListSessions{}); err != nil {
		t.Fatalf("reconnect call: %v", err)
	}
	if c.EpochCurrent(expected) {
		t.Fatal("reconnect retained the old epoch")
	}

	requestCount := func(command string) int {
		d.mu.Lock()
		defer d.mu.Unlock()
		var count int
		for _, request := range d.requests {
			if request["type"] == command {
				count++
			}
		}
		return count
	}
	before := requestCount(CmdCloseSession)

	resp, responseEpoch, err := c.CallInEpochToken(context.Background(), expected, CloseSession{SessionID: "rpc-1"})
	if !errors.Is(err, ErrEpochMismatch) || !errors.Is(err, ErrDisconnected) {
		t.Fatalf("token-bound call after transition = %v, want ErrEpochMismatch + ErrDisconnected", err)
	}
	if resp != nil || responseEpoch != (EpochToken{}) {
		t.Fatalf("rejected token-bound call returned response=%+v epoch=%+v", resp, responseEpoch)
	}

	completed := make(chan callResult, 1)
	resp, err = c.CallRetainedInEpoch(context.Background(), expected, CloseSession{SessionID: "rpc-1"}, func(resp *Response, epoch EpochToken, err error) {
		completed <- callResult{response: resp, epoch: epoch, err: err}
	})
	if !errors.Is(err, ErrEpochMismatch) || !errors.Is(err, ErrDisconnected) {
		t.Fatalf("retained token-bound call after transition = %v, want ErrEpochMismatch + ErrDisconnected", err)
	}
	got := <-completed
	if !errors.Is(got.err, ErrEpochMismatch) || got.response != nil || got.epoch != (EpochToken{}) {
		t.Fatalf("retained rejection completion = %+v", got)
	}
	if resp != nil {
		t.Fatalf("rejected retained token-bound call response = %+v", resp)
	}
	if after := requestCount(CmdCloseSession); after != before {
		t.Fatalf("stale expected-token calls wrote %d close request(s)", after-before)
	}
}
