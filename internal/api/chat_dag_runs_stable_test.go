package api

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/auth"
)

func TestChatDagRunStable(t *testing.T) {
	t.Run("atomicReplacementAtReadBarrier", func(t *testing.T) {
		f := newDagHTTPFixture(t)
		old := dagFixtureRun("stable", 64, 2048)
		newRun := dagFixtureRun("stable", 65, 4096)
		newRun["updatedAt"] = "2026-09-03T11:01:00.987654321+09:00"
		path := filepath.Join(f.dir, "checkpoint.json")
		oldBytes := writeDagFixture(t, path, old)
		replacement := filepath.Join(f.dir, "replacement.tmp")
		newBytes := writeDagFixture(t, replacement, newRun)
		fired := false
		ctx := &dagReadBarrierContext{Context: t.Context(), onRead: func() {
			fired = true
			if err := os.Rename(replacement, path); err != nil {
				t.Fatal(err)
			}
		}}
		req := httptest.NewRequest(http.MethodGet, f.path+"/stable", nil).WithContext(ctx)
		req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: f.token})
		rec := httptest.NewRecorder()
		f.server.Handler().ServeHTTP(rec, req)
		doc := decodeDagDocument(t, rec)
		if !fired {
			t.Fatal("source read barrier never fired")
		}
		if len(doc.Run.Nodes) == 64 {
			assertFullDag(t, doc, old, oldBytes)
		} else {
			assertFullDag(t, doc, newRun, newBytes)
		}
		assertFullDag(t, decodeDagDocument(t, f.get(t, "/stable")), newRun, newBytes)
	})
	t.Run("inPlaceMutationIsExplicitConflict", func(t *testing.T) {
		f := newDagHTTPFixture(t)
		source := dagFixtureRun("stable", 64, 2048)
		path := filepath.Join(f.dir, "checkpoint.json")
		writeDagFixture(t, path, source)
		replacement := dagFixtureRun("stable", 65, 4096)
		fired := false
		ctx := &dagReadBarrierContext{Context: t.Context(), onRead: func() { fired = true; writeDagFixture(t, path, replacement) }}
		req := httptest.NewRequest(http.MethodGet, f.path+"/stable", nil).WithContext(ctx)
		req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: f.token})
		rec := httptest.NewRecorder()
		f.server.Handler().ServeHTTP(rec, req)
		if rec.Code != 409 || !fired {
			t.Fatalf("status=%d barrier=%v want409", rec.Code, fired)
		}
	})
	t.Run("originalBytesAndTimestampsNotMtime", func(t *testing.T) {
		f := newDagHTTPFixture(t)
		source := dagFixtureRun("stable", 1, 1)
		delete(source, "createdAt")
		delete(source, "updatedAt")
		path := filepath.Join(f.dir, "checkpoint.json")
		data := writeDagFixture(t, path, source)
		first := decodeDagDocument(t, f.get(t, "/stable"))
		if first.Run.CreatedAt != "" || first.Run.UpdatedAt != "" {
			t.Fatal("fabricated source clock")
		}
		whitespace := append([]byte(" \n"), data...)
		if err := os.WriteFile(path, whitespace, 0600); err != nil {
			t.Fatal(err)
		}
		second := decodeDagDocument(t, f.get(t, "/stable"))
		if first.ContentToken == second.ContentToken || second.Run.UpdatedAt != "" {
			t.Fatal("token must compare original bytes, never invent revision")
		}
	})
}
