package session

import (
	"context"
	"fmt"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func TestPR197R11ExposedRevisionPinsFollowCurrentRowOwnership(t *testing.T) {
	for _, mode := range []string{"rest_reads", "publications"} {
		t.Run(mode, func(t *testing.T) {
			// Given one resident durable, with no bound sessions.
			store := newResolvingCursorStore()
			mgr := NewManager(Config{Store: store})
			t.Cleanup(func() { mustOK(t, mgr.CloseAll(context.Background())) })
			const durable = "one-resident-durable"
			event := &omorpc.Event{
				Type: "extension_event", SessionID: durable,
				Raw: []byte(`{"name":"omo.task.updated","data":{"tasks":[]}}`),
			}

			// When its stored owner changes repeatedly without evicting the durable.
			for i := 0; i < 2*maxIdentityTombstones+3; i++ {
				chat := fmt.Sprintf("successive-owner-%04d", i)
				store.setOwner(durable, chat, "Stable title")
				if i == 0 || mode == "publications" {
					mgr.ingestEpochEvent(omorpc.EpochToken{}, event)
				}
				rows := mgr.LiveSummaries()
				if len(rows) != 1 || rows[0].ChatID != chat || rows[0].DurableSessionID != durable {
					t.Fatalf("owner %d did not replace the sole row: %+v", i, rows)
				}
			}

			// Then former chat rows must enter the bounded non-resident history.
			mgr.mu.Lock()
			defer mgr.mu.Unlock()
			pins := len(mgr.overviewExposed.pinned)
			total, history := mgr.overviewExposed.Len(), mgr.overviewExposed.HistoryLen()
			cached, bound := len(mgr.overviewCache), len(mgr.byChat)
			t.Logf("EXPOSURE_STATE pins=%d total=%d history=%d cached=%d bound=%d limit=%d",
				pins, total, history, cached, bound, maxIdentityTombstones)
			if pins > cached+bound || total > maxIdentityTombstones+cached+bound {
				t.Fatalf("former owners remain pinned outside the bounded history: pins=%d total=%d history=%d resident=%d",
					pins, total, history, cached+bound)
			}
		})
	}
}
