package session

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

// Real provider route-loss responses and caller/transport failures must not
// become external-write quarantine merely because history validation failed.
func TestDurableHistoryRPCFailurePreservesRecoveryPolicy(t *testing.T) {
	for _, recovery := range []bool{false, true} {
		for _, failure := range []string{omorpc.ErrCodeUnknownSession, omorpc.ErrCodeSessionClosing, "cancel", "transport"} {
			t.Run(fmt.Sprintf("recovery=%v/%s", recovery, failure), func(t *testing.T) {
				s, d := queueHistorySession(t, queueEntry("root", "", "user", "initial")+queueEntry("accepted", "root", "user", "queued"), true)
				release := d.BlockHandler(omorpc.CmdGetEntries)
				defer release()
				if failure == omorpc.ErrCodeUnknownSession || failure == omorpc.ErrCodeSessionClosing {
					d.FailNext(omorpc.CmdGetEntries, failure)
				}
				ctx, cancel := context.WithTimeout(t.Context(), testTimeout)
				defer cancel()
				type result struct {
					leaf    string
					matched bool
					err     error
				}
				done := make(chan result, 1)
				go func() {
					var got result
					if recovery {
						got.matched, got.err = s.DurableUserMessageAfter(ctx, "root", "queued")
					} else {
						got.leaf, got.err = s.DurableHistoryLeaf(ctx)
					}
					done <- got
				}()
				if !d.AwaitRequestCount(omorpc.CmdGetEntries, 1, testTimeout) {
					t.Fatal("history query did not reach gate")
				}
				switch failure {
				case "cancel":
					cancel()
				case "transport":
					d.DropConnections()
				default:
					release()
				}
				var got result
				select {
				case got = <-done:
				case <-time.After(testTimeout):
					t.Fatal("history failure did not settle")
				}
				if got.err == nil || got.leaf != "" || got.matched {
					t.Fatalf("failed authority yielded result: %+v", got)
				}
				want := ErrSessionResumable
				if failure == "cancel" {
					want = context.Canceled
				}
				if failure == "transport" {
					want = omorpc.ErrDisconnected
				}
				if !errors.Is(got.err, want) {
					t.Fatalf("error=%v want=%v", got.err, want)
				}
				s.lifecycleMu.Lock()
				quarantine, resumable := s.quarantineErr, s.resumable
				s.lifecycleMu.Unlock()
				if quarantine != nil {
					t.Fatalf("%s became external-write quarantine: %v", failure, quarantine)
				}
				if resumable != (failure != "cancel") {
					t.Fatalf("%s resumable=%v", failure, resumable)
				}
				if d.RequestCount(omorpc.CmdGetEntries) != 1 || d.RequestCount(omorpc.CmdPrompt) != 0 {
					t.Fatal("failure retried history or sent a prompt")
				}
			})
		}
	}
}
