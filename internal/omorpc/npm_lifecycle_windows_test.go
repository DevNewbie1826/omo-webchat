//go:build windows && realomo

package omorpc

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Requires an actual npm-installed omo on PATH (or CHAT_PI_BINARY). Uses an
// isolated profile and opens an empty session; no provider credentials or LLM
// requests are needed. CI pins the package, while this also tests newer installs.
func TestWindowsNpmOmoLifecycle(t *testing.T) {
	binary := os.Getenv("CHAT_PI_BINARY")
	if binary == "" {
		binary = "omo"
	}
	shim, err := resolveOmoBinary(binary)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.EqualFold(filepath.Ext(shim), ".cmd") {
		t.Fatalf("npm lifecycle requires an npm .cmd launcher, got %q", shim)
	}
	entry, err := npmOmoEntry(shim)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ name, binary string }{{"npm_cmd", shim}, {"explicit_js", entry}} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			home := filepath.Join(dir, "home")
			agent := filepath.Join(home, ".omo", "agent")
			env := os.Environ()
			for key, value := range map[string]string{
				"HOME": home, "USERPROFILE": home,
				"APPDATA":              filepath.Join(home, "AppData", "Roaming"),
				"LOCALAPPDATA":         filepath.Join(home, "AppData", "Local"),
				"XDG_CONFIG_HOME":      filepath.Join(home, ".config"),
				"XDG_CACHE_HOME":       filepath.Join(home, ".cache"),
				"OMO_CODING_AGENT_DIR": agent, "SENPI_CODING_AGENT_DIR": agent,
			} {
				env = setEnv(env, key, value)
			}
			cfg := EnsureConfig{BinaryPath: tc.binary, AgentDir: agent, WorkingDir: dir,
				StateDir: filepath.Join(dir, "state"), Env: env, ReadyTimeout: 35 * time.Second}
			ctx, cancel := context.WithTimeout(t.Context(), 60*time.Second)
			defer cancel()
			owner, err := EnsureDaemon(ctx, cfg)
			if err != nil {
				log, _ := os.ReadFile(filepath.Join(cfg.StateDir, "daemon-spawn.log"))
				t.Fatalf("fresh npm daemon: %v\n%s", err, log)
			}
			t.Cleanup(func() {
				if err := owner.StopBounded(10 * time.Second); err != nil {
					t.Errorf("stop owned npm daemon: %v", err)
				}
			})
			if !owner.Owned || owner.supervisor == nil {
				t.Fatal("fresh npm daemon is not tracked/owned")
			}
			t.Logf("fresh npm daemon: owned=true serverVersion=%s", owner.ProtocolInfo.ServerVersion)
			shared, err := EnsureDaemon(ctx, cfg)
			if err != nil {
				t.Fatalf("reuse npm daemon: %v", err)
			}
			sharedOwned := shared.Owned
			if err := shared.StopBounded(10 * time.Second); err != nil {
				t.Fatal(err)
			}
			if sharedOwned {
				t.Fatal("reuse claimed ownership")
			}
			resp, err := owner.Client.Call(ctx, OpenSession{CWD: dir})
			if err != nil {
				t.Fatal(err)
			}
			var opened OpenSessionData
			if err := json.Unmarshal(resp.Data, &opened); err != nil || !resp.Success || opened.SessionID == "" {
				t.Fatalf("open session after shared Stop: success=%t err=%v", resp.Success, err)
			}
			resp, err = owner.Client.Call(ctx, CloseSession{SessionID: opened.SessionID})
			if err != nil || !resp.Success {
				t.Fatalf("close session: response=%v err=%v", resp, err)
			}
			if err := owner.StopBounded(10 * time.Second); err != nil {
				t.Fatal(err)
			}
			client, err := probeDaemon(ctx, cfg)
			if err == nil {
				_ = client.Close()
				t.Fatal("owned npm daemon still reachable after Stop")
			}
			t.Log("reuse, session open/close and owned process tree teardown passed")
		})
	}
}
