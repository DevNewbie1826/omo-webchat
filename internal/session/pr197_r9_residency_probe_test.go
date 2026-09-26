package session

import (
	"context"
	"fmt"
	"testing"
)

func TestPR197R9ReversePublicationHistoryReleasesStoppedResidents(t *testing.T) {
	// Given more live bound rows than the non-resident history capacity.
	d := newDaemon(t)
	mgr := testManager(t, dial(t, d), newMemStore(), 64)
	updates := make(chan Summary, 1)
	_, stop := mgr.SubscribeActivity(true, nil, func(s Summary, _ bool) { updates <- s })
	defer stop()
	chats := make([]string, 3*maxIdentityTombstones+17)
	for i := range chats {
		chats[i] = fmt.Sprintf("r9-bound-%04d", i)
		s, _, detach := acquire(t, mgr, testChat{id: chats[i], cwd: t.TempDir()}, nil)
		detach()
		emitUnboundActivity(d, s.ID(), activitySnapshotOrder[0], map[string]any{"tasks": []any{}})
		if got := awaitOverview(t, updates); got.ChatID != chats[i] || got.Active {
			t.Fatalf("fixture did not publish an inactive bound row: %+v", got)
		}
	}

	// When all holders stop without another activity publication.
	for _, chat := range chats {
		mustOK(t, mgr.StopContext(context.Background(), chat))
	}

	// Then every publication index must obey the non-resident bound immediately.
	mgr.mu.Lock()
	defer mgr.mu.Unlock()
	if len(mgr.byChat) != 0 || len(mgr.overviewCache) != 0 {
		t.Fatalf("resident fixture remains: bound=%d cache=%d", len(mgr.byChat), len(mgr.overviewCache))
	}
	check := func(name string, publications *overviewPublications) {
		t.Helper()
		t.Logf("%s: ids=%d history=%d pins=%d reverse_rows=%d", name,
			publications.ids.Len(), publications.ids.HistoryLen(),
			len(publications.ids.pinned), len(publications.rows))
		if len(publications.ids.pinned) != 0 || publications.ids.Len() > maxOverviewPublications ||
			len(publications.rows) > maxOverviewPublications {
			t.Errorf("%s retained non-resident evidence beyond %d entries", name, maxOverviewPublications)
		}
	}
	check("manager", &mgr.overviewPrevious)
	for _, sub := range mgr.overviewSubscribers {
		sub.mu.Lock()
		check("subscriber", &sub.published)
		sub.mu.Unlock()
	}
}
