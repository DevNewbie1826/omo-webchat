//go:build unix || darwin || linux

package omorpc

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// This is executable fixture input, not a snapshot of launcher documentation.
const testNodeSiblingForwarder = `#!/bin/sh
node_path=$(command -v node 2>/dev/null) || {
  echo "omo: Node.js is not available; install Node.js 24+ and omo-ai@beta" >&2
  exit 127
}
resolved_node=$(readlink -f "$node_path" 2>/dev/null) || resolved_node=$node_path
native_omo=$(dirname "$resolved_node")/omo
if [ ! -x "$native_omo" ] || [ "$native_omo" = "$0" ]; then
  echo "omo: OmO Native is missing beside $resolved_node; run: npm i -g omo-ai@beta" >&2
  exit 127
fi
exec "$native_omo" "$@"
`

func writeNodeSiblingLauncher(t *testing.T) (forwarder, root, node string) {
	t.Helper()
	launcher, root, _ := writeRecognizedLauncherInstall(t, "3.2.1")
	if err := os.Remove(launcher); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../lib/node_modules/omo-ai/bin/omo.js", launcher); err != nil {
		t.Fatal(err)
	}
	node = filepath.Join(filepath.Dir(launcher), "node")
	if err := os.WriteFile(node, []byte("#!/bin/sh\nexit 91\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	bin := t.TempDir()
	forwarder = filepath.Join(bin, "omo")
	if err := os.WriteFile(forwarder, []byte(testNodeSiblingForwarder), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(node, filepath.Join(bin, "node")); err != nil {
		t.Fatal(err)
	}
	// Neither the host PATH nor agent-only environment can satisfy discovery.
	t.Setenv("PATH", bin)
	t.Setenv("OMO_AGENT_TOOLKIT_BIN", "")
	t.Setenv("OMO_BIN", "")
	return forwarder, root, node
}

func TestLauncherUnmarkedForwarderWithoutAgentEnvironment(t *testing.T) {
	forwarder, root, _ := writeNodeSiblingLauncher(t)
	command, err := resolveOmoBinary("omo")
	if err != nil || command != forwarder {
		t.Fatalf("resolve PATH launcher = %q, %v", command, err)
	}
	root, err = filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}
	cfg := EnsureConfig{BinaryPath: "omo", StateDir: t.TempDir(), Env: []string{"PATH=" + filepath.Dir(forwarder)}}
	args, _, adapter, err := nodeFallbackContext(cfg, command, nil)
	if err != nil {
		t.Fatalf("unmarked forwarder context without agent environment: %v", err)
	}
	if adapter == "" || len(args) == 0 {
		t.Fatalf("missing native adapter: args=%v adapter=%q", args, adapter)
	}
	profile, native, err := launcherNativeContext(command, cfg.Env)
	if err != nil {
		t.Fatal(err)
	}
	var brand launcherBrandProfile
	if err := json.Unmarshal([]byte(profile), &brand); err != nil {
		t.Fatal(err)
	}
	if brand.DisplayVersion != "3.2.1" || native != filepath.Join(root, "node_modules", "@code-yeongyu", "senpi", "dist", "cli.js") {
		t.Fatalf("wrong installation context: version=%q native=%q", brand.DisplayVersion, native)
	}
}

func TestLauncherForwarderPrecedence(t *testing.T) {
	for _, source := range []string{"marker", "symlink", "toolkit", "omo-bin", "invalid-marker", "invalid-env"} {
		t.Run(source, func(t *testing.T) {
			forwarder, _, _ := writeNodeSiblingLauncher(t)
			_, authoritative, _ := writeRecognizedLauncherInstall(t, "4.0.0")
			_, other, _ := writeRecognizedLauncherInstall(t, "5.0.0")
			entry := filepath.Join(authoritative, "bin", "omo.js")
			env := []string{"PATH=" + filepath.Dir(forwarder), "OMO_BIN=" + filepath.Join(other, "bin", "omo.js")}
			switch source {
			case "marker", "invalid-marker":
				if source == "invalid-marker" {
					entry = filepath.Join(t.TempDir(), "missing", "bin", "omo.js")
				}
				if err := os.WriteFile(forwarder, []byte(testNodeSiblingForwarder+"# entry: "+entry+"\n"), 0o700); err != nil {
					t.Fatal(err)
				}
			case "symlink":
				if err := os.Remove(forwarder); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(entry, forwarder); err != nil {
					t.Fatal(err)
				}
				var err error
				entry, err = filepath.EvalSymlinks(entry)
				if err != nil {
					t.Fatal(err)
				}
			case "toolkit":
				env = append(env, "OMO_AGENT_TOOLKIT_BIN="+filepath.Join(authoritative, "bin", "omo-agent-toolkit.js"))
			case "omo-bin", "invalid-env":
				if source == "invalid-env" {
					entry = filepath.Join(t.TempDir(), "missing", "bin", "omo.js")
				}
				env = append(env, "OMO_BIN="+entry)
			}
			got, recognized, err := resolveLauncherInstallation(forwarder, env)
			if err != nil || !recognized || got.entry != entry || got.root != filepath.Dir(filepath.Dir(entry)) {
				t.Fatalf("authoritative %s: got=%+v recognized=%v err=%v want entry=%q", source, got, recognized, err, entry)
			}
		})
	}
}

func TestLauncherForwarderRejectsUnrelatedInstallation(t *testing.T) {
	for _, scenario := range []string{"unknown-wrapper", "changed-exec", "missing-node", "missing-sibling", "regular-sibling", "foreign-symlink", "non-executable-entry", "self-recursion", "first-node-only", "explicit-path-only"} {
		t.Run(scenario, func(t *testing.T) {
			forwarder, root, node := writeNodeSiblingLauncher(t)
			env := []string{"PATH=" + filepath.Dir(forwarder)}
			sibling := filepath.Join(filepath.Dir(node), "omo")
			switch scenario {
			case "unknown-wrapper", "changed-exec":
				body := "#!/bin/sh\nexit 0\n"
				if scenario == "changed-exec" {
					body = strings.Replace(testNodeSiblingForwarder, `exec "$native_omo" "$@"`, `exec /unrelated/omo "$@"`, 1)
				}
				if err := os.WriteFile(forwarder, []byte(body), 0o700); err != nil {
					t.Fatal(err)
				}
			case "missing-node":
				if err := os.Remove(node); err != nil {
					t.Fatal(err)
				}
			case "missing-sibling", "regular-sibling", "foreign-symlink", "self-recursion":
				if err := os.Remove(sibling); err != nil {
					t.Fatal(err)
				}
				switch scenario {
				case "regular-sibling":
					if err := os.WriteFile(sibling, []byte(testNodeSiblingForwarder), 0o700); err != nil {
						t.Fatal(err)
					}
				case "foreign-symlink", "self-recursion":
					target := forwarder
					if scenario == "foreign-symlink" {
						_, foreign, _ := writeRecognizedLauncherInstall(t, "99.0.0")
						target = filepath.Join(foreign, "bin", "omo.js")
					}
					if err := os.Symlink(target, sibling); err != nil {
						t.Fatal(err)
					}
				}
			case "non-executable-entry":
				if err := os.Chmod(filepath.Join(root, "bin", "omo.js"), 0o600); err != nil {
					t.Fatal(err)
				}
			case "first-node-only":
				bin := t.TempDir()
				if err := os.WriteFile(filepath.Join(bin, "node"), []byte("#!/bin/sh\nexit 92\n"), 0o700); err != nil {
					t.Fatal(err)
				}
				env = []string{"PATH=" + bin + string(os.PathListSeparator) + filepath.Dir(forwarder)}
			case "explicit-path-only":
				env = []string{"PATH=" + t.TempDir()}
			}
			got, recognized, err := resolveLauncherInstallation(forwarder, env)
			if err == nil || !recognized || got != (launcherInstallation{}) {
				t.Fatalf("unsafe %s fallback: got=%+v recognized=%v err=%v", scenario, got, recognized, err)
			}
		})
	}
}
