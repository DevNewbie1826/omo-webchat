package session

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/coldhistory"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func TestDurableHistoryRewriteDuringScan(t *testing.T) {
	s, d := queueHistorySession(t, queueEntry("root", "", "user", "initial")+queueEntry("end", "root", "assistant", "final"), true)
	body, err := os.ReadFile(s.SessionFile())
	if err != nil {
		t.Fatal(err)
	}
	matched := false
	ctx, cancel := context.WithTimeout(t.Context(), testTimeout)
	defer cancel()
	// This callback runs inside the real bounded scanner. Mutate synchronously
	// after its first parsed record, without replacing disk or RPC authority.
	err = s.inspectQueueHistory(ctx, func(json.RawMessage) bool {
		if !matched {
			matched = true
			if err := os.WriteFile(s.SessionFile(), []byte(strings.Replace(string(body), "initial", "changed", 1)), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		return false
	}, func(*coldhistory.FileOrder, string) error {
		t.Fatal("rewritten snapshot reached result inspection")
		return nil
	})
	var drift *ExternalWriteError
	if !matched || !errors.As(err, &drift) {
		t.Fatalf("midscan rewrite=%v matched=%v", err, matched)
	}
	if d.RequestCount(omorpc.CmdGetEntries) != 0 {
		t.Fatal("midscan rewrite reached RPC")
	}
}

func TestDurableHistoryFinalFencesAfterResponse(t *testing.T) {
	for _, kind := range []string{"cancel", "epoch", "route", "path", "identity", "rewrite"} {
		t.Run(kind, func(t *testing.T) {
			s, d := queueHistorySession(t, queueEntry("root", "", "user", "initial"), true)
			ctx, cancel := context.WithTimeout(t.Context(), testTimeout)
			defer cancel()
			inspected := false
			err := s.inspectQueueHistory(ctx, nil, func(order *coldhistory.FileOrder, leaf string) error {
				if _, err := order.Checkpoint(leaf); err != nil {
					return err
				}
				inspected = true
				// The provisional result is derived from a real response; change
				// authority synchronously before its final publication fence.
				switch kind {
				case "cancel":
					cancel()
				case "epoch":
					s.lifecycleMu.Lock()
					s.epoch = omorpc.EpochToken{}
					s.lifecycleMu.Unlock()
				case "route":
					s.lifecycleMu.Lock()
					s.routingID = "replaced"
					s.lifecycleMu.Unlock()
				case "path":
					s.lifecycleMu.Lock()
					s.sessionFile += ".changed"
					s.lifecycleMu.Unlock()
				case "identity":
					body, err := os.ReadFile(s.SessionFile())
					if err != nil {
						t.Fatal(err)
					}
					if err := os.Rename(s.SessionFile(), s.SessionFile()+".old"); err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(s.SessionFile(), body, 0o600); err != nil {
						t.Fatal(err)
					}
				case "rewrite":
					body, err := os.ReadFile(s.SessionFile())
					if err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(s.SessionFile(), []byte(strings.Replace(string(body), "initial", "changed", 1)), 0o600); err != nil {
						t.Fatal(err)
					}
				}
				return nil
			})
			if !inspected || err == nil {
				t.Fatalf("postresponse authority change survived: inspected=%v err=%v", inspected, err)
			}
			if d.RequestCount(omorpc.CmdGetEntries) != 1 {
				t.Fatal("expected one real daemon validation")
			}
		})
	}
}

func TestDurableHistoryIndexBudgetFailsWithoutRPC(t *testing.T) {
	s, d := queueHistorySession(t, queueEntry("root", "", "user", "initial"), true)
	f, err := os.OpenFile(s.SessionFile(), os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	w := bufio.NewWriter(f)
	parent := "root"
	for i := 0; i < 300000; i++ {
		id := fmt.Sprintf("bounded-%d", i)
		if _, err := fmt.Fprintf(w, "{\"type\":\"custom\",\"id\":%q,\"parentId\":%q}\n", id, parent); err != nil {
			t.Fatal(err)
		}
		parent = id
	}
	if err := w.Flush(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	_, err = s.DurableHistoryLeaf(ctx)
	if !errors.Is(err, coldhistory.ErrIndexBudgetExceeded) {
		t.Fatalf("index limit=%v", err)
	}
	if d.RequestCount(omorpc.CmdGetEntries) != 0 {
		t.Fatal("index exhaustion fell back to RPC")
	}
}

func TestDurableHistoryObservedTruncationCannotBecomeDaemonTail(t *testing.T) {
	s, d := queueHistorySession(t, queueEntry("root", "", "user", "initial"), true)
	ctx, cancel := context.WithTimeout(t.Context(), testTimeout)
	defer cancel()
	before, err := os.Stat(s.SessionFile())
	if err != nil {
		t.Fatal(err)
	}
	if !d.AppendHistory(s.SessionFile(), "assistant", "durable tail") {
		t.Fatal("append failed")
	}
	if _, err := s.DurableHistoryLeaf(ctx); err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(s.SessionFile(), before.Size()); err != nil {
		t.Fatal(err)
	}
	requests := d.RequestCount(omorpc.CmdGetEntries)
	if _, err := s.DurableHistoryLeaf(ctx); err == nil {
		t.Fatal("observed truncation was mistaken for a fresh daemon tail")
	}
	if d.RequestCount(omorpc.CmdGetEntries) != requests {
		t.Fatal("observed truncation reached RPC")
	}
}
