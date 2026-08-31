package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/config"
)

// canonicalTempDir returns a symlink-resolved temp dir, mirroring how
// config.Load canonicalizes cfg.Root (Abs + Clean + EvalSymlinks). Without
// this, macOS /var→/private/var symlinks break the root-boundary check.
func canonicalTempDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	resolved, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatalf("eval symlinks %s: %v", dir, err)
	}
	return resolved
}

// TestResolveUnder exercises the path-resolution rules: cwd-relative `..`,
// root-relative `/`, escape detection, trailing-slash handling, and symlink
// resolution. root is the parent temp; cwd is a "project" subdir of root.
func TestResolveUnder(t *testing.T) {
	root := canonicalTempDir(t)
	cwd := filepath.Join(root, "cli-webchat")
	sibling := filepath.Join(root, "sibling")
	cwdSub := filepath.Join(cwd, "sub")
	for _, d := range []string{cwd, sibling, cwdSub} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}

	cases := []struct {
		name    string
		rel     string
		want    string
		wantErr error
	}{
		{name: "dot-self", rel: ".", want: cwd},
		{name: "parent", rel: "..", want: root},
		{name: "parent-sibling", rel: "../sibling", want: sibling},
		{name: "root-relative-abs", rel: "/sibling", want: sibling},
		{name: "trailing-slash-sub", rel: "sub/", want: cwdSub},
		{name: "escape-above-root", rel: "../../..", wantErr: errOutsideRoot},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := resolveUnder(root, cwd, c.rel)
			if c.wantErr != nil {
				if err == nil {
					t.Fatalf("resolveUnder(%q): want error %v, got nil (path=%s)", c.rel, c.wantErr, got)
				}
				if !errors.Is(err, c.wantErr) {
					t.Fatalf("resolveUnder(%q): want error %v, got %v", c.rel, c.wantErr, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("resolveUnder(%q): unexpected err %v", c.rel, err)
			}
			if got != c.want {
				t.Fatalf("resolveUnder(%q) = %q, want %q", c.rel, got, c.want)
			}
		})
	}

	// A symlink pointing within root resolves through EvalSymlinks to its
	// real target and stays inside the boundary.
	t.Run("symlink-within-root", func(t *testing.T) {
		target := filepath.Join(root, "realdir")
		if err := os.MkdirAll(target, 0o755); err != nil {
			t.Fatal(err)
		}
		link := filepath.Join(cwd, "linkdir")
		if err := os.Symlink(target, link); err != nil {
			t.Fatal(err)
		}
		got, err := resolveUnder(root, cwd, "linkdir")
		if err != nil {
			t.Fatalf("unexpected err %v", err)
		}
		if got != target {
			t.Fatalf("resolveUnder(linkdir) = %q, want %q", got, target)
		}
	})
}

// TestListMentionDirOrdering checks dirs-before-files alpha ordering, the
// synthetic `..` parent presence (resolved != root), and searchIgnoreDirs
// filtering.
func TestListMentionDirOrdering(t *testing.T) {
	root := canonicalTempDir(t)
	cwd := filepath.Join(root, "cwd")
	resolved := cwd // resolved != root → `..` expected
	if err := os.MkdirAll(resolved, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, d := range []string{"bdir", "adir", "node_modules"} {
		if err := os.MkdirAll(filepath.Join(resolved, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for _, f := range []string{"bfile.txt", "afile.txt"} {
		if err := os.WriteFile(filepath.Join(resolved, f), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	entries, err := os.ReadDir(resolved)
	if err != nil {
		t.Fatal(err)
	}
	out, capped := listMentionDir(root, cwd, resolved, entries)
	if capped {
		t.Fatalf("capped = true, want false")
	}

	wantNames := []string{"..", "adir", "bdir", "afile.txt", "bfile.txt"}
	if len(out) != len(wantNames) {
		t.Fatalf("len(out) = %d, want %d (%+v)", len(out), len(wantNames), out)
	}
	for i, w := range wantNames {
		if out[i].Name != w {
			t.Fatalf("out[%d].Name = %q, want %q (full: %+v)", i, out[i].Name, w, out)
		}
	}
	if !out[0].IsParent || !out[0].IsDir {
		t.Fatalf("first entry must be the synthetic parent: %+v", out[0])
	}
	for _, e := range out {
		if e.Name == "node_modules" {
			t.Fatalf("node_modules was not skipped by searchIgnoreDirs")
		}
	}
}

// TestListMentionDirNoParentAtRoot verifies the synthetic `..` is omitted
// when the resolved directory is the workspace root.
func TestListMentionDirNoParentAtRoot(t *testing.T) {
	root := canonicalTempDir(t)
	if err := os.MkdirAll(filepath.Join(root, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	out, capped := listMentionDir(root, root, root, entries)
	if capped {
		t.Fatalf("capped = true, want false")
	}
	for _, e := range out {
		if e.IsParent {
			t.Fatalf("unexpected synthetic parent entry at root: %+v", e)
		}
	}
	if len(out) != 2 || out[0].Name != "sub" || out[1].Name != "a.txt" {
		t.Fatalf("out = %+v, want [sub, a.txt] (dirs before files, alpha)", out)
	}
}

// TestListMentionDirCapped verifies truncation at searchMaxResults and the
// capped flag when a directory holds more than 50 entries.
func TestListMentionDirCapped(t *testing.T) {
	root := canonicalTempDir(t)
	for i := range 60 {
		name := fmt.Sprintf("f%02d.txt", i)
		if err := os.WriteFile(filepath.Join(root, name), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	out, capped := listMentionDir(root, root, root, entries)
	if !capped {
		t.Fatalf("capped = false, want true (60 files > %d)", searchMaxResults)
	}
	if len(out) != searchMaxResults {
		t.Fatalf("len(out) = %d, want %d", len(out), searchMaxResults)
	}
}

// TestHandleListMentionHTTP exercises the cwd-guard end-to-end: browsing to
// the parent returns entries, escaping above root yields 400 outsideRoot,
// and a request without `cwd` keeps the legacy response shape.
func TestHandleListMentionHTTP(t *testing.T) {
	root := canonicalTempDir(t)
	cwd := filepath.Join(root, "project")
	if err := os.MkdirAll(cwd, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cwd, "main.go"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := &Server{
		cfg:    &config.Config{Root: root},
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}

	do := func(q string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/api/fs/list?"+q, nil)
		rec := httptest.NewRecorder()
		s.handleList(rec, req)
		return rec
	}

	// cwd present, path=".." browses to root → 200 with entries.
	rec := do("cwd=" + url.QueryEscape(cwd) + "&path=..")
	if rec.Code != http.StatusOK {
		t.Fatalf("browse status = %d, want 200 (body=%s)", rec.Code, rec.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal browse response: %v (body=%s)", err, rec.Body.String())
	}
	entries, ok := resp["entries"].([]any)
	if !ok {
		t.Fatalf("browse response missing entries array: %+v", resp)
	}
	if len(entries) == 0 {
		t.Fatalf("expected non-empty entries when browsing root")
	}

	// cwd present, path="/" (bare workspace-root-relative) → resolves to ROOT,
	// not the cwd. Regression: a bare "/" must not collapse to "." / cwd.
	rec = do("cwd=" + url.QueryEscape(cwd) + "&path=" + url.QueryEscape("/"))
	if rec.Code != http.StatusOK {
		t.Fatalf("root-slash status = %d, want 200 (body=%s)", rec.Code, rec.Body.String())
	}
	var rootSlash map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &rootSlash); err != nil {
		t.Fatalf("unmarshal root-slash response: %v (body=%s)", err, rec.Body.String())
	}
	if got := rootSlash["path"]; got != ".." {
		t.Fatalf("path=/ resolved to cwd (%q), want \"..\" (workspace root)", got)
	}

	// cwd present, path escapes above root → 400 with outsideRoot error.
	rec = do("cwd=" + url.QueryEscape(cwd) + "&path=" + url.QueryEscape("../../.."))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("escape status = %d, want 400 (body=%s)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "outside the allowed root") {
		t.Fatalf("escape body = %s, want outsideRoot error", rec.Body.String())
	}

	// No cwd → legacy shape: must carry 'parent' and NOT 'capped'.
	rec = do("path=" + url.QueryEscape(cwd))
	if rec.Code != http.StatusOK {
		t.Fatalf("legacy status = %d, want 200 (body=%s)", rec.Code, rec.Body.String())
	}
	var legacy map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &legacy); err != nil {
		t.Fatalf("unmarshal legacy response: %v (body=%s)", err, rec.Body.String())
	}
	if _, ok := legacy["parent"]; !ok {
		t.Fatalf("legacy response missing 'parent' key: %+v", legacy)
	}
	if _, ok := legacy["capped"]; ok {
		t.Fatalf("legacy response must not include 'capped': %+v", legacy)
	}
}
