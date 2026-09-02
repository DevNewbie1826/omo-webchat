package api

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/auth"
	"github.com/DevNewbie1826/omo-webchat/internal/config"
	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
)

func newWriteTestServer(t *testing.T) (*Server, string) {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("resolving test root: %v", err)
	}
	return &Server{
		cfg:    &config.Config{Root: root},
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}, root
}

func TestHandleWriteFileAcceptsContentAboveOneMiB(t *testing.T) {
	s, root := newWriteTestServer(t)
	path := filepath.Join(root, "editor.txt")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatalf("creating target file: %v", err)
	}

	content := strings.Repeat("x", (1<<20)+1024)
	body, err := json.Marshal(map[string]string{"content": content})
	if err != nil {
		t.Fatalf("encoding request: %v", err)
	}
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/fs/write?path=editor.txt", bytes.NewReader(body))

	s.handleWriteFile(recorder, req)

	if recorder.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d: %s", recorder.Code, http.StatusNoContent, recorder.Body.String())
	}
	written, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading saved file: %v", err)
	}
	if string(written) != content {
		t.Fatalf("saved content length = %d, want %d", len(written), len(content))
	}
}

func TestHandleWriteFileAcceptsMaxSizeContentWithHeavyEscaping(t *testing.T) {
	s, root := newWriteTestServer(t)
	path := filepath.Join(root, "editor.txt")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatalf("creating target file: %v", err)
	}

	// Newlines double in JSON; control chars expand 6x. A max-size file of
	// either must still save, or the read/save round trip breaks at the cap.
	for name, content := range map[string]string{
		"newlines": strings.Repeat("\n", maxWriteBytes),
		"controls": strings.Repeat("\x01", maxWriteBytes),
	} {
		t.Run(name, func(t *testing.T) {
			body, err := json.Marshal(map[string]string{"content": content})
			if err != nil {
				t.Fatalf("encoding request: %v", err)
			}
			recorder := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodPost, "/api/fs/write?path=editor.txt", bytes.NewReader(body))

			s.handleWriteFile(recorder, req)

			if recorder.Code != http.StatusNoContent {
				t.Fatalf("status = %d, want %d: %s", recorder.Code, http.StatusNoContent, recorder.Body.String())
			}
			written, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("reading saved file: %v", err)
			}
			if string(written) != content {
				t.Fatalf("saved content length = %d, want %d", len(written), len(content))
			}
		})
	}
}

func TestHandleWriteFileRejectsOversizedBody(t *testing.T) {
	s, root := newWriteTestServer(t)
	path := filepath.Join(root, "editor.txt")
	const original = "original"
	if err := os.WriteFile(path, []byte(original), 0o600); err != nil {
		t.Fatalf("creating target file: %v", err)
	}

	body, err := json.Marshal(map[string]string{"content": strings.Repeat("x", maxWriteBytes+4096)})
	if err != nil {
		t.Fatalf("encoding request: %v", err)
	}
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/fs/write?path=editor.txt", bytes.NewReader(body))

	s.handleWriteFile(recorder, req)

	if recorder.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want %d: %s", recorder.Code, http.StatusRequestEntityTooLarge, recorder.Body.String())
	}
	written, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading target file: %v", err)
	}
	if string(written) != original {
		t.Fatalf("target was modified after oversized request: %q", written)
	}
}

func multipartUploadRequest(t *testing.T, path, filename, content string) *http.Request {
	t.Helper()
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	file, err := form.CreateFormFile("files", filename)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write([]byte(content)); err != nil {
		t.Fatal(err)
	}
	if err := form.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, path, &body)
	req.Header.Set("Content-Type", form.FormDataContentType())
	return req
}

func TestUploadAcceptsCursorStoreOnlyChatAndRejectsMissingChat(t *testing.T) {
	s, st, ws := newChatCreateTestServer(t)
	if err := st.SaveChat(cursorstore.Chat{ID: "v2-only", WorkspaceID: ws.ID, CWD: ws.Path, Name: "v2"}); err != nil {
		t.Fatal(err)
	}

	for _, test := range []struct {
		chatID string
		want   int
	}{
		{chatID: "v2-only", want: http.StatusOK},
		{chatID: "missing", want: http.StatusNotFound},
	} {
		path := "/api/workspaces/" + ws.ID + "/chats/" + test.chatID + "/upload"
		req := multipartUploadRequest(t, path, "v2-proof.txt", "cursor upload")
		req.SetPathValue("wsId", ws.ID)
		req.SetPathValue("chatId", test.chatID)
		rec := httptest.NewRecorder()
		s.handleUpload(rec, req)
		if rec.Code != test.want {
			t.Fatalf("chat %q status = %d, want %d: %s", test.chatID, rec.Code, test.want, rec.Body.String())
		}
	}
	got, err := os.ReadFile(filepath.Join(ws.Path, "v2-proof.txt"))
	if err != nil || string(got) != "cursor upload" {
		t.Fatalf("uploaded file = %q, %v", got, err)
	}
}

func TestHandlerRoutesAuthenticatedChatUpload(t *testing.T) {
	s, st, ws := newChatCreateTestServer(t)
	chat, err := st.NewChat(ws.ID, "upload", ws.Path, "", "omo")
	if err != nil {
		t.Fatalf("creating chat: %v", err)
	}
	token, err := s.sessions.Create(t.Context())
	if err != nil {
		t.Fatalf("creating session: %v", err)
	}

	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	file, err := form.CreateFormFile("files", "proof.txt")
	if err != nil {
		t.Fatalf("creating upload part: %v", err)
	}
	if _, err := file.Write([]byte("routed upload")); err != nil {
		t.Fatalf("writing upload part: %v", err)
	}
	if err := form.Close(); err != nil {
		t.Fatalf("closing multipart form: %v", err)
	}

	path := "/api/workspaces/" + ws.ID + "/chats/" + chat.ID + "/upload"
	req := httptest.NewRequest(http.MethodPost, path, &body)
	req.Header.Set("Content-Type", form.FormDataContentType())
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: token})
	recorder := httptest.NewRecorder()
	s.Handler().ServeHTTP(recorder, req)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}
	uploaded, err := os.ReadFile(filepath.Join(ws.Path, "proof.txt"))
	if err != nil {
		t.Fatalf("reading uploaded file: %v", err)
	}
	if string(uploaded) != "routed upload" {
		t.Fatalf("uploaded content = %q, want routed upload", uploaded)
	}
}
