package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/auth"
)

func postMkdir(t *testing.T, s *Server, path, name string) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(map[string]string{"path": path, "name": name})
	if err != nil {
		t.Fatalf("encoding request: %v", err)
	}
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/fs/mkdir", bytes.NewReader(body))
	s.handleMakeDir(recorder, req)
	return recorder
}

func TestHandleMakeDirCreatesDirectoryInsideRoot(t *testing.T) {
	s, root := newWriteTestServer(t)
	if err := os.Mkdir(filepath.Join(root, "projects"), 0o755); err != nil {
		t.Fatalf("creating parent: %v", err)
	}

	recorder := postMkdir(t, s, "projects", "session-logs")

	if recorder.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d: %s", recorder.Code, http.StatusCreated, recorder.Body.String())
	}
	var body struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decoding response: %v", err)
	}
	want := filepath.Join(root, "projects", "session-logs")
	if body.Path != want {
		t.Fatalf("created path = %q, want %q", body.Path, want)
	}
	info, err := os.Stat(want)
	if err != nil || !info.IsDir() {
		t.Fatalf("created directory stat err=%v isDir=%v", err, err == nil && info.IsDir())
	}
}

func TestHandleMakeDirRejectsEscapingLeafNames(t *testing.T) {
	s, root := newWriteTestServer(t)
	if err := os.Mkdir(filepath.Join(root, "projects"), 0o755); err != nil {
		t.Fatalf("creating parent: %v", err)
	}

	for _, name := range []string{"", "   ", ".", "..", "a/b", "../escape", `..\escape`, "bad\x00name"} {
		t.Run(name, func(t *testing.T) {
			recorder := postMkdir(t, s, "projects", name)

			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want %d: %s", recorder.Code, http.StatusBadRequest, recorder.Body.String())
			}
		})
	}

	entries, err := os.ReadDir(filepath.Join(root, "projects"))
	if err != nil {
		t.Fatalf("reading projects dir: %v", err)
	}
	if len(entries) != 0 {
		names := make([]string, 0, len(entries))
		for _, entry := range entries {
			names = append(names, entry.Name())
		}
		t.Fatalf("rejected names created entries: %v", names)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(root), "escape")); !os.IsNotExist(err) {
		t.Fatalf("directory created outside root: %v", err)
	}
}

func TestHandleMakeDirRejectsParentOutsideRoot(t *testing.T) {
	s, root := newWriteTestServer(t)
	outside := filepath.Dir(root)

	recorder := postMkdir(t, s, outside, "escape")

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d: %s", recorder.Code, http.StatusBadRequest, recorder.Body.String())
	}
	if _, err := os.Stat(filepath.Join(outside, "escape")); !os.IsNotExist(err) {
		t.Fatalf("directory created outside root: %v", err)
	}
}

func TestHandleMakeDirMapsExistingDirectoryToConflict(t *testing.T) {
	s, root := newWriteTestServer(t)
	if err := os.Mkdir(filepath.Join(root, "dupe"), 0o755); err != nil {
		t.Fatalf("creating directory: %v", err)
	}

	recorder := postMkdir(t, s, "", "dupe")

	if recorder.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d: %s", recorder.Code, http.StatusConflict, recorder.Body.String())
	}
}

func TestHandleMakeDirMapsMissingParentToNotFound(t *testing.T) {
	s, root := newWriteTestServer(t)

	recorder := postMkdir(t, s, filepath.Join(root, "nope"), "child")

	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d: %s", recorder.Code, http.StatusNotFound, recorder.Body.String())
	}
}

func TestMkdirRouteCreatesDirectoryWhenAuthenticated(t *testing.T) {
	s, _, ws := newChatCreateTestServer(t)
	s.cfg.Root = ws.Path
	token, err := s.sessions.Create(t.Context())
	if err != nil {
		t.Fatalf("creating session: %v", err)
	}

	body, err := json.Marshal(map[string]string{"path": "", "name": "made-via-route"})
	if err != nil {
		t.Fatalf("encoding request: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/fs/mkdir", bytes.NewReader(body))
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: token})
	recorder := httptest.NewRecorder()
	s.Handler().ServeHTTP(recorder, req)

	if recorder.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d: %s", recorder.Code, http.StatusCreated, recorder.Body.String())
	}
	if _, err := os.Stat(filepath.Join(ws.Path, "made-via-route")); err != nil {
		t.Fatalf("created directory missing: %v", err)
	}
}
