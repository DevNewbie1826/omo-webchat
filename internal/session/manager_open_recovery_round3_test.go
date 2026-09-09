package session

import (
	"context"
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

// Round-3 review regressions: recovery wins admission against an owner
// already parked between its successful provider open and manager
// publication. Retiring that route must fence the parked owner for both
// close outcomes: the close either completed before the owner resumed, or
// it is written but still unanswered. Publishing a retired route is never
// acceptable; the owner must be rejected as resumable instead.
func TestRound3PublisherAfterRecoveryRetiresRoute(t *testing.T) {
	for _, timeout := range []bool{false, true} {
		name := "close-completed"
		if timeout {
			name = "close-written-unanswered"
		}
		t.Run(name, func(t *testing.T) {
			d := newDaemon(t)
			client := dial(t, d)
			store := &identityParkedStore{memCursorStore: newMemStore(), entered: make(chan struct{}), release: make(chan struct{})}
			mgr := newRecoveryManager(t, client, store)
			path := filepath.Join(t.TempDir(), "publication-after-recovery.jsonl")
			for _, chat := range []string{"owner", "victim"} {
				if err := store.SaveCursor(context.Background(), chat, Cursor{SessionFile: path}); err != nil {
					t.Fatal(err)
				}
			}
			var once sync.Once
			releaseOwner := func() { once.Do(func() { close(store.release) }) }
			defer releaseOwner()
			ownerDone := make(chan error, 1)
			ownerCtx, cancel := context.WithTimeout(context.Background(), testTimeout)
			defer cancel()
			go func() {
				_, _, _, err := mgr.Acquire(ownerCtx, testChat{id: "owner", cwd: filepath.Dir(path)}, nil)
				ownerDone <- err
			}()
			awaitSignal(t, store.entered, "owner parked after successful provider open")
			openRelease := d.BlockHandlerForPath(omorpc.CmdOpenSession, path)
			defer openRelease()
			closeRelease := func() {}
			if timeout {
				closeRelease = d.BlockHandler(omorpc.CmdCloseSession)
				defer closeRelease()
			}
			budgetedAcquire(t, mgr, testChat{id: "victim", cwd: filepath.Dir(path)}, 60*time.Millisecond)
			awaitOpenFenceReleased(t, mgr, "victim", "recovery close returned and released its reservations")
			if n := d.RequestCount(omorpc.CmdCloseSession); n != 1 {
				t.Fatalf("recovery close requests = %d, want 1", n)
			}
			releaseOwner()
			select {
			case err := <-ownerDone:
				if errors.Is(err, ErrSessionResumable) {
					return
				}
				if err != nil {
					t.Fatalf("owner acquire: %v", err)
				}
			case <-time.After(testTimeout):
				t.Fatal("owner acquire did not settle")
			}
			owner, ok := mgr.Get("owner")
			if !ok {
				t.Fatal("owner acquire succeeded without published session")
			}
			if timeout {
				if _, err := owner.QueryState(ownerCtx); err != nil {
					t.Fatalf("owner route unusable before delayed close: %v", err)
				}
				closeRelease()
				if !d.AwaitCloseCount(1, testTimeout) {
					t.Fatal("delayed recovery close did not settle")
				}
			}
			if _, err := owner.QueryState(ownerCtx); err != nil {
				t.Fatalf("recovery won admission, released cleanup reservation, then allowed owner to publish a destroyed route: %v", err)
			}
		})
	}
}
