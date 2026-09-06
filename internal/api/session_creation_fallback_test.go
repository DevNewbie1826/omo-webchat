package api

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
)

func TestRepresentativeCreationIsFallback(t *testing.T) {
	for _, location := range []string{"owned", "catalog"} {
		for _, use := range []int64{0, 1767960000, 1768132800000} {
			t.Run(location+"/"+time.UnixMilli(use).UTC().Format(time.RFC3339Nano), func(t *testing.T) {
				// Given: wrapping an old logical file created a newer metadata record.
				s, st, ws := newChatCreateTestServer(t)
				agent := t.TempDir()
				t.Setenv("OMO_CODING_AGENT_DIR", agent)
				fileRoot := agent
				if location == "owned" {
					fileRoot = t.TempDir()
				}
				activity := time.Date(2026, 1, 10, 12, 0, 0, 0, time.UTC)
				path := writeDiskSession(t, fileRoot, ws.Path, "logical", "Logical file", activity.AddDate(-1, 0, 0))
				if err := os.Chtimes(path, activity, activity); err != nil {
					t.Fatal(err)
				}
				if location == "catalog" {
					path = filepath.Join(t.TempDir(), "absent-owned.jsonl")
				}
				chat := cursorstore.Chat{
					ID: "wrapper", WorkspaceID: ws.ID, CWD: ws.Path, SessionFile: path, DurableSessionID: "logical",
					CreatedAt: activity.AddDate(0, 1, 0).UnixMilli(), LastUsedAt: use,
				}
				if err := st.SaveChat(chat); err != nil {
					t.Fatal(err)
				}
				// When: list the represented session, including catalog folding before pagination.
				page := listWorkspaceSessions(t, s, ws.ID, "")
				// Then: activity/use win over wrapper creation; legacy seconds stay comparable.
				want := activity.UnixMilli()
				if use == 1768132800000 {
					want = use
				}
				if len(page.Items) != 1 || page.Items[0].ID != "wrapper" || page.Items[0].RecencyMs != want {
					t.Fatalf("LastUsedAt=%d wrapper creation=%d: items=%+v want recency=%d", use, chat.CreatedAt, page.Items, want)
				}
			})
		}
	}
}

func TestExplicitUsePrecedesFileCreationFallback(t *testing.T) {
	// Given: valid use, newer creation, and unavailable file activity.
	root := t.TempDir()
	path := writeDiskSession(t, t.TempDir(), root, "logical", "Logical", time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC))
	epoch := time.Unix(0, 0)
	if err := os.Chtimes(path, epoch, epoch); err != nil {
		t.Fatal(err)
	}
	chat := cursorstore.Chat{ID: "wrapper", SessionFile: path, DurableSessionID: "logical", CreatedAt: 1772323200000, LastUsedAt: 1768132800000}
	// When
	items := mergeSessionHistory([]cursorstore.Chat{chat}, nil)
	// Then: neither file nor wrapper creation is activity when explicit use exists.
	if len(items) != 1 || items[0].RecencyMs != chat.LastUsedAt {
		t.Fatalf("items=%+v want use=%d", items, chat.LastUsedAt)
	}
}
