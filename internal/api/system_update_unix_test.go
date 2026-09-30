//go:build darwin || linux

package api

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// Exercise the real HTTP/auth/router -> launcher detection -> subprocess path.
// The configured installation and runtime are entirely inside a temporary dir;
// there is no injection of the installer function in this test.
func TestSystemUpdateHTTPPackageManager(t *testing.T) {
	for _, tc := range []struct {
		name     string
		manager  string
		manifest string
		spec     string
	}{
		{name: "npm stable", manager: "npm", manifest: `{"name":"omo-ai","version":"5.1.4"}`, spec: "omo-ai"},
		{name: "npm prerelease", manager: "npm", manifest: `{"name":"omo-ai","version":"5.2.0-0.beta.1"}`, spec: "omo-ai@beta"},
		{name: "npm missing version", manager: "npm", manifest: `{"name":"omo-ai"}`, spec: "omo-ai"},
		{name: "bun stable", manager: "bun", manifest: `{"name":"omo-ai","version":"5.1.4"}`, spec: "omo-ai"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			base, err := filepath.EvalSymlinks(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			prefix := filepath.Join(base, "node installation")
			var root string
			if tc.manager == "bun" {
				root = filepath.Join(prefix, "install", "global", "node_modules", "omo-ai")
			} else {
				root = filepath.Join(prefix, "lib", "node_modules", "omo-ai")
			}
			entry := filepath.Join(root, "bin", "omo.js")
			launcher := filepath.Join(prefix, "bin", "omo")
			argvPath := filepath.Join(base, "argv")
			write := func(path, body string) {
				t.Helper()
				if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, []byte(body), 0700); err != nil {
					t.Fatal(err)
				}
			}
			recorder := "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$WEBCHAT_UPDATE_TEST_ARGV\"\n"
			write(entry, "#!/bin/sh\nexit 99\n")
			write(filepath.Join(root, "package.json"), tc.manifest)
			var want []string
			if tc.manager == "bun" {
				if err := os.MkdirAll(filepath.Dir(launcher), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(entry, launcher); err != nil {
					t.Fatal(err)
				}
				write(filepath.Join(prefix, "bin", "bun"), recorder)
				want = []string{"add", "--cwd", root, "-g", tc.spec}
			} else {
				npm := filepath.Join(prefix, "lib", "node_modules", "npm", "bin", "npm-cli.js")
				write(launcher, "#!/bin/sh\n# entry: "+entry+"\nexit 99\n")
				write(npm, "// never executed by the fixture\n")
				write(filepath.Join(prefix, "bin", "node"), recorder)
				want = []string{npm, "i", "-g", "--prefix", prefix, tc.spec}
			}
			poison := filepath.Join(base, "unrelated-path")
			for _, name := range []string{"omo", "npm", "node", "bun", "senpi"} {
				write(filepath.Join(poison, name), "#!/bin/sh\nexit 98\n")
			}
			t.Setenv("PATH", poison)
			t.Setenv("CHAT_PI_BINARY", launcher)
			t.Setenv("WEBCHAT_UPDATE_TEST_ARGV", argvPath)
			s, _, _ := newChatCreateTestServer(t)
			s.ctx = t.Context()
			// Configuration is captured when the server is created, just like startup.
			t.Setenv("CHAT_PI_BINARY", filepath.Join(poison, "omo"))
			server := httptest.NewServer(s.Handler())
			defer server.Close()
			jar, err := cookiejar.New(nil)
			if err != nil {
				t.Fatal(err)
			}
			client := &http.Client{Jar: jar, Timeout: 10 * time.Second}
			post := func(path, body string) (int, []byte) {
				t.Helper()
				response, err := client.Post(server.URL+path, "application/json", strings.NewReader(body))
				if err != nil {
					t.Fatal(err)
				}
				defer response.Body.Close()
				data, err := io.ReadAll(response.Body)
				if err != nil {
					t.Fatal(err)
				}
				return response.StatusCode, data
			}
			if status, body := post("/api/system/update", "{}"); status != http.StatusUnauthorized {
				t.Fatalf("unauthenticated: %d %s", status, body)
			}
			if _, err := os.Stat(argvPath); !os.IsNotExist(err) {
				t.Fatalf("unauthenticated request ran installer: %v", err)
			}
			if status, body := post("/api/login", `{"password":"pw"}`); status != http.StatusOK {
				t.Fatalf("login: %d %s", status, body)
			}
			status, body := post("/api/system/update", "{}")
			var result struct {
				RestartRequired bool `json:"restartRequired"`
			}
			if status != http.StatusOK || json.Unmarshal(body, &result) != nil || !result.RestartRequired {
				t.Fatalf("update: %d %s", status, body)
			}
			argv, err := os.ReadFile(argvPath)
			if err != nil {
				t.Fatal(err)
			}
			got := strings.Split(strings.TrimSuffix(string(argv), "\n"), "\n")
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("actual installer argv = %q, want %q", got, want)
			}
			// Success did not shut down/restart webchat or invalidate its auth session.
			response, err := client.Get(server.URL + "/api/auth/check")
			if err != nil {
				t.Fatal(err)
			}
			response.Body.Close()
			if response.StatusCode != http.StatusOK {
				t.Fatalf("post-update server/auth status = %d", response.StatusCode)
			}
		})
	}
}
