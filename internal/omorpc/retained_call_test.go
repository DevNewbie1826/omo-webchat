package omorpc

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

type triggeredDeadline struct {
	context.Context
	done chan struct{}
	once sync.Once
}

func newTriggeredDeadline() *triggeredDeadline {
	return &triggeredDeadline{Context: context.Background(), done: make(chan struct{})}
}

func (c *triggeredDeadline) Done() <-chan struct{} { return c.done }
func (c *triggeredDeadline) Err() error {
	select {
	case <-c.done:
		return context.DeadlineExceeded
	default:
		return nil
	}
}
func (c *triggeredDeadline) expire() { c.once.Do(func() { close(c.done) }) }

func TestClientRetainedCallDeliversLateOutcome(t *testing.T) {
	for _, tc := range []struct {
		name     string
		failCode string
	}{
		{name: "success"},
		{name: "rejection", failCode: ErrCodeUnknownSession},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := newMockDaemon(t)
			release := d.BlockHandler(CmdListSessions)
			defer release()
			if tc.failCode != "" {
				d.FailNext(CmdListSessions, tc.failCode)
			}
			c := dialForTest(t, d, Config{})
			ctx := newTriggeredDeadline()
			returned := make(chan error, 1)
			completed := make(chan callResult, 1)
			go func() {
				_, err := c.CallRetained(ctx, ListSessions{}, func(resp *Response, epoch EpochToken, err error) {
					completed <- callResult{response: resp, epoch: epoch, err: err}
				})
				returned <- err
			}()
			d.awaitRequest(t, CmdListSessions, testAwaitTimeout)
			ctx.expire()
			select {
			case err := <-returned:
				if !errors.Is(err, ErrWrittenUnanswered) || !errors.Is(err, context.DeadlineExceeded) {
					t.Fatalf("CallRetained deadline = %v, want ErrWrittenUnanswered + DeadlineExceeded", err)
				}
			case <-time.After(testAwaitTimeout):
				t.Fatal("CallRetained did not return at its deadline")
			}
			select {
			case got := <-completed:
				t.Fatalf("completion ran before correlated response: %+v", got)
			default:
			}

			release()
			select {
			case got := <-completed:
				if got.epoch.epoch == nil || got.response == nil {
					t.Fatalf("late completion lost response epoch: %+v", got)
				}
				if tc.failCode == "" {
					if got.err != nil || !got.response.Success {
						t.Fatalf("late success = %+v", got)
					}
				} else {
					var stable *StableError
					if !errors.As(got.err, &stable) || stable.Code != tc.failCode {
						t.Fatalf("late rejection = %v, want %s", got.err, tc.failCode)
					}
				}
			case <-time.After(testAwaitTimeout):
				t.Fatal("late correlated response did not run completion")
			}
		})
	}
}

func TestClientRetainedCallsAllSettleOnEpochDeath(t *testing.T) {
	d := newMockDaemon(t)
	releaseList := d.BlockHandler(CmdListSessions)
	releaseOpen := d.BlockHandler(CmdOpenSession)
	defer releaseList()
	defer releaseOpen()
	c := dialForTest(t, d, Config{})

	completed := make(chan error, 2)
	returned := make(chan error, 2)
	for _, cmd := range []Command{ListSessions{}, OpenSession{CWD: t.TempDir()}} {
		go func(cmd Command) {
			_, err := c.CallRetained(context.Background(), cmd, func(_ *Response, _ EpochToken, err error) {
				completed <- err
			})
			returned <- err
		}(cmd)
	}
	d.awaitRequest(t, CmdListSessions, testAwaitTimeout)
	d.awaitRequest(t, CmdOpenSession, testAwaitTimeout)
	d.DropConnections()
	for range 2 {
		select {
		case err := <-completed:
			if !errors.Is(err, ErrDisconnected) {
				t.Fatalf("epoch-death completion = %v, want ErrDisconnected", err)
			}
		case <-time.After(testAwaitTimeout):
			t.Fatal("epoch death did not settle every retained call")
		}
		select {
		case err := <-returned:
			if !errors.Is(err, ErrDisconnected) {
				t.Fatalf("epoch-death return = %v, want ErrDisconnected", err)
			}
		case <-time.After(testAwaitTimeout):
			t.Fatal("epoch death did not release every retained caller")
		}
	}
}
