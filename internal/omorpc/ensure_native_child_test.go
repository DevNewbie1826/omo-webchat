package omorpc

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestWindowsNativeChildContext(t *testing.T) {
	engine := os.Getenv("OMORPC_TEST_ENGINE")
	if engine == "" {
		engine = "node"
	}
	if engine != "node" && engine != "bun" {
		t.Fatalf("invalid fixture engine %q", engine)
	}
	for _, original := range []string{"", "--no-warnings"} {
		t.Run(original, func(t *testing.T) {
			dir := filepath.Join(t.TempDir(), "space & directory")
			native := filepath.Join(dir, "senpi", "dist")
			if err := os.MkdirAll(native, 0700); err != nil {
				t.Fatal(err)
			}
			cfg := EnsureConfig{StateDir: dir, Env: os.Environ()}
			// Do not inherit an unrelated test runner's preload/Inspector configuration.
			var env []string
			for _, value := range cfg.Env {
				if !strings.HasPrefix(value, "NODE_OPTIONS=") && !strings.HasPrefix(value, "BUN_OPTIONS=") {
					env = append(env, value)
				}
			}
			cfg.Env = env
			if original != "" {
				cfg.Env = setEnv(cfg.Env, "NODE_OPTIONS", original)
				cfg.Env = setEnv(cfg.Env, "BUN_OPTIONS", "--smol")
			}
			cfg.Env = setEnv(cfg.Env, "SENPI_BRAND", `{"name":"OmO","envPrefix":"OMO"}`)
			cfg.Env = setEnv(cfg.Env, "OMO_AGENT_TOOLKIT_BIN", filepath.Join(dir, "omo-ai", "bin", "omo-agent-toolkit.js"))
			env, preload, err := windowsNativeChildContext(cfg)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if err := os.Remove(preload); err != nil {
					t.Error(err)
				}
			})
			const supervisor = `const {spawn} = require("node:child_process");
const path = require("node:path");
const args = process.argv.slice(process.argv.indexOf("--internal-rpc-host-supervisor") + 1);
delete process.env.SENPI_BRAND; // The real cli-main scrubs before supervisor dispatch.
const child = spawn(process.execPath, [path.join(__dirname,"cli-main.js"), "--mode", "rpc", "--multi-session", "--listen", "unix://fixture", ...args], {
 env:{...process.env, SENPI_RPC_HOST_WATCH_PPID:String(process.pid), SENPI_RPC_HOST_WATCH_FD:"3"},
 stdio:["ignore","pipe","inherit","pipe"]
});
child.stdout.pipe(process.stdout);
child.stdio[3].end("FD3_READY");
child.once("error", error => { throw error; });
child.once("close", code => { process.exitCode = code; });
`
			const host = `const {createReadStream} = require("node:fs");
const stream = createReadStream("", {fd:3, autoClose:true});
let bytes = "";
stream.on("data", data => { bytes += data; });
stream.once("error", error => { throw error; });
stream.once("end", () => console.log(JSON.stringify({pid:process.pid, ppid:process.ppid, watch:Number(process.env.SENPI_RPC_HOST_WATCH_PPID),
 fd:bytes === "FD3_READY", brand:process.env.SENPI_BRAND,
 options:process.env.NODE_OPTIONS || "", bunOptions:process.env.BUN_OPTIONS || "",
 marker:process.env.OMO_WEBCHAT_RPC_LAUNCH_CONTEXT || "", args:process.argv.slice(2)})));
`
			for name, source := range map[string]string{"cli.js": supervisor, "cli-main.js": host} {
				if err := os.WriteFile(filepath.Join(native, name), []byte(source), 0600); err != nil {
					t.Fatal(err)
				}
			}
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, engine, filepath.Join(native, "cli.js"), "--internal-rpc-host-supervisor")
			cmd.Env = env
			cmd.WaitDelay = time.Second
			output, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatalf("native preload fixture: %v (%s)", err, output)
			}
			var got struct {
				PID, PPID, Watch                   int
				FD                                 bool
				Brand, Options, BunOptions, Marker string
				Args                               []string
			}
			if err := json.Unmarshal(output, &got); err != nil {
				t.Fatal(err)
			}
			brand, _ := lookupEnv(cfg.Env, "SENPI_BRAND")
			bunOptions, _ := lookupEnv(cfg.Env, "BUN_OPTIONS")
			if got.PPID != cmd.Process.Pid || got.Watch != cmd.Process.Pid || !got.FD || got.Brand != brand || got.Options != original || got.BunOptions != bunOptions || got.Marker != "" {
				t.Fatalf("native context = %+v", got)
			}
			want := []string{"--mode", "rpc", "--multi-session", "--listen", "unix://fixture", "--extension", filepath.Join(dir, "omo-ai", "plugin")}
			if !reflect.DeepEqual(got.Args, want) {
				t.Fatalf("native args = %v, want %v", got.Args, want)
			}
		})
	}
}

func TestNativeChildContextPreservesExplicitLaunch(t *testing.T) {
	for _, cfg := range []EnsureConfig{{ChildCommand: "explicit-child"}, {ArgsTemplate: []string{"explicit-template"}}} {
		want := []string{"explicit-args"}
		args, env, adapter, err := nodeFallbackContext(cfg, "omo", want)
		if err != nil || adapter != "" || !reflect.DeepEqual(args, want) {
			t.Fatalf("explicit launch rewritten: args=%v adapter=%q err=%v", args, adapter, err)
		}
		if runtime, _ := lookupEnv(env, "OMO_RUNTIME"); runtime != "node" {
			t.Fatalf("fallback runtime=%s", runtime)
		}
	}
}
