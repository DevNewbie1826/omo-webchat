package api

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/testfs"
)

func TestChatDagRunCatalogRejectsInaccessibleStore(t *testing.T) {
	for _, kind := range []string{"symlink", "regularFile"} {
		t.Run(kind, func(t *testing.T) {
			f := newDagHTTPFixture(t)
			if err := os.Remove(f.dir); err != nil {
				t.Fatal(err)
			}
			if kind == "symlink" {
				testfs.Symlink(t, t.TempDir(), f.dir)
			} else {
				if err := os.WriteFile(f.dir, []byte("not a directory"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if rec := f.get(t, ""); rec.Code != 404 {
				t.Fatalf("inaccessible store status=%d want 404 body=%s", rec.Code, rec.Body.String())
			}
		})
	}
}

func TestChatDagRunCatalogMissingStoreIsEmpty(t *testing.T) {
	f := newDagHTTPFixture(t)
	if err := os.RemoveAll(filepath.Join(f.ws.Path, ".omo")); err != nil {
		t.Fatal(err)
	}
	if rec := f.get(t, ""); rec.Code != 200 {
		t.Fatalf("absent catalog status=%d", rec.Code)
	}
	if rec := f.get(t, "/missing"); rec.Code != 404 {
		t.Fatalf("absent selected run status=%d", rec.Code)
	}
}

func TestChatDagRunCatalogRejectsMalformedQuery(t *testing.T) {
	f := newDagHTTPFixture(t)
	for _, suffix := range []string{"?cursor=%zz", "?limit=1;cursor=bad"} {
		t.Run(suffix, func(t *testing.T) {
			if rec := f.get(t, suffix); rec.Code != 400 {
				t.Fatalf("malformed query status=%d want 400", rec.Code)
			}
		})
	}
}
