package api

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
)

func TestStoredFileActivity(t *testing.T) {
	for _, durableID := range []string{"file-id", "replacement-id"} {
		t.Run(durableID, func(t *testing.T) {
			// Given: a stored file outside the discovered catalog, with explicit identity.
			root := t.TempDir()
			activity := time.Date(2026, 1, 10, 12, 0, 0, 0, time.UTC)
			created := activity.AddDate(-1, 0, 0)
			path := writeDiskSession(t, t.TempDir(), root, "file-id", "Owned", created)
			if err := os.Chtimes(path, activity, activity); err != nil {
				t.Fatal(err)
			}
			chat := cursorstore.Chat{ID: "stored", SessionFile: path, DurableSessionID: durableID, CreatedAt: created.UnixMilli()}
			// When
			items := mergeSessionHistory([]cursorstore.Chat{chat}, nil)
			// Then: matching owned activity counts; a same-path replacement does not.
			want := created.UnixMilli()
			if durableID == "file-id" {
				want = activity.UnixMilli()
			}
			if len(items) != 1 || items[0].RecencyMs != want {
				t.Fatalf("items=%+v want=%d", items, want)
			}
		})
	}
}

func TestFileRecencyFallback(t *testing.T) {
	for _, timestamp := range []string{"2026-01-01T00:00:00Z", "invalid", ""} {
		t.Run(timestamp, func(t *testing.T) {
			// Given: the filesystem time is unknown/nonpositive.
			path := filepath.Join(t.TempDir(), "session.jsonl")
			body := `{"type":"session","id":"disk","cwd":"/work","timestamp":"` + timestamp + `"}`
			if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
				t.Fatal(err)
			}
			epoch := time.Unix(0, 0)
			if err := os.Chtimes(path, epoch, epoch); err != nil {
				t.Fatal(err)
			}
			// When
			got, ok := parseSessionFile(path)
			// Then: valid creation is fallback; truly unknown is zero, never Go zero time.
			want := int64(0)
			if timestamp == "2026-01-01T00:00:00Z" {
				want = 1767225600000
			}
			if !ok || got.RecencyMs != want {
				t.Fatalf("got=%+v parsed=%v want=%d", got, ok, want)
			}
		})
	}
}
