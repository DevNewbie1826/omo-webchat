package session

import (
	"context"
	"fmt"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func TestPR197FinalRenameAfterCacheEvictionAdvancesRevision(t *testing.T) {
	for _, evicted := range []bool{false, true} {
		t.Run(fmt.Sprintf("evicted_%t", evicted), func(t *testing.T) {
			// Given an exposed logical revision ahead of wall time, using
			// the same fixed receipt as the existing R13/R14 probes.
			store := newResolvingCursorStore()
			store.setOwner("rename-source", "rename-chat", "Before")
			mgr := NewManager(Config{Store: store})
			t.Cleanup(func() { mustOK(t, mgr.CloseAll(context.Background())) })
			ingest := func(id string) {
				mgr.ingestEpochEvent(omorpc.EpochToken{}, &omorpc.Event{
					Type: "extension_event", SessionID: id,
					Raw: []byte(`{"name":"omo.task.updated","data":{"tasks":[]}}`),
				})
			}
			ingest("rename-source")
			mgr.mu.Lock()
			mgr.overviewCache["rename-source"].task.ReceivedAt = "2100-01-01T00:00:00Z"
			mgr.overviewCache["rename-source"].liveRevision = liveRevision{}
			mgr.mu.Unlock()
			before := mgr.LiveSummaries()[0]
			high := *before.LiveValues().LastActivityMS
			updates := make(chan Summary, 1)
			_, stop := mgr.SubscribeActivity(false, []string{"rename-chat"}, func(row Summary, _ bool) {
				updates <- row
			})
			defer stop()
			if evicted {
				for i := 0; i < maxOverviewCacheEntries; i++ {
					ingest(fmt.Sprintf("rename-filler-%03d", i))
				}
			}
			mgr.mu.Lock()
			cached := mgr.overviewCache["rename-source"] != nil
			exposure, retained := mgr.overviewExposed.Get("rename-chat")
			mgr.mu.Unlock()
			if cached == evicted || !retained || exposure.revision != high {
				t.Fatalf("bad fixture: cached=%t retained=%t revision=%d", cached, retained, exposure.revision)
			}

			// When the stored chat is renamed, then its same durable returns.
			store.setOwner("rename-source", "rename-chat", "After")
			mgr.ApplyChatTitle("rename-chat", "After")
			if evicted {
				ingest("rename-source")
			}

			// Then both subscription delivery and REST's manager projection
			// must expose the changed title with a strictly newer revision.
			ws := awaitOverview(t, updates)
			rows := []Summary{ws}
			for _, row := range mgr.LiveSummaries() {
				if row.ChatID == "rename-chat" {
					rows = append(rows, row)
				}
			}
			if len(rows) != 2 {
				t.Fatalf("missing returned REST row: %+v", rows)
			}
			for i, row := range rows {
				revision := row.LiveValues().LastActivityMS
				t.Logf("RENAME evicted=%t surface=%d before=%d after=%v title=%s",
					evicted, i, high, revisionValueR13(revision), row.Title)
				if row.Title != "After" || revision == nil || *revision <= high {
					t.Errorf("rename failed to advance exposed revision: before=%d after=%v title=%s",
						high, revisionValueR13(revision), row.Title)
				}
			}
		})
	}
}
