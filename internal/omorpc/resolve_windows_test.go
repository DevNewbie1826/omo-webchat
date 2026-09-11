//go:build windows

package omorpc

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func writeScanFixture(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("MZ placeholder, resolution only stats the file"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestResolveOmoBinaryCandidateScanFindsBunUserInstall(t *testing.T) {
	home := t.TempDir()
	t.Setenv("USERPROFILE", home)
	t.Setenv("PATH", t.TempDir())
	t.Setenv("PATHEXT", ".JS;.EXE;.BAT;.CMD")
	bunOmo := filepath.Join(home, ".bun", "bin", "omo.exe")
	writeScanFixture(t, filepath.Join(home, ".bun", "bin", "omo.js"))
	writeScanFixture(t, bunOmo)

	binary, err := resolveOmoBinary("omo")
	if err != nil {
		t.Fatalf("resolveOmoBinary(\"omo\"): %v", err)
	}
	if binary != bunOmo {
		t.Fatalf("resolveOmoBinary(\"omo\") = %q, want bun user install %q", binary, bunOmo)
	}
}

func TestResolveOmoBinaryPathEntryBeatsCandidateScan(t *testing.T) {
	home := t.TempDir()
	pathDir := t.TempDir()
	pathOmo := filepath.Join(pathDir, "omo.exe")
	writeScanFixture(t, pathOmo)
	t.Setenv("USERPROFILE", home)
	t.Setenv("PATH", pathDir)
	t.Setenv("PATHEXT", ".COM;.EXE;.BAT;.CMD")
	writeScanFixture(t, filepath.Join(home, ".bun", "bin", "omo.exe"))

	binary, err := resolveOmoBinary("omo")
	if err != nil {
		t.Fatalf("resolveOmoBinary(\"omo\"): %v", err)
	}
	if binary != pathOmo {
		t.Fatalf("resolveOmoBinary(\"omo\") = %q, want PATH entry %q over the scan candidate", binary, pathOmo)
	}
}

func TestResolveOmoBinaryCmdShimReturnsExplicitPathError(t *testing.T) {
	home := t.TempDir()
	t.Setenv("USERPROFILE", home)
	t.Setenv("PATH", t.TempDir())
	t.Setenv("PATHEXT", ".COM;.EXE;.BAT;.CMD")
	shim := filepath.Join(home, ".bun", "bin", "omo.cmd")
	writeScanFixture(t, shim)

	binary, err := resolveOmoBinary("omo")
	if binary != "" {
		t.Fatalf("resolveOmoBinary(\"omo\") = %q, want empty for a command shim", binary)
	}
	if err == nil {
		t.Fatal("resolveOmoBinary(\"omo\") accepted a .cmd shim, want an explicit-path error")
	}
	if !strings.Contains(err.Error(), shim) {
		t.Fatalf("resolveOmoBinary(\"omo\") error = %v, want it to name the shim %q", err, shim)
	}
}

func TestResolveOmoBinaryScanDefaultsPathextWhenUnset(t *testing.T) {
	home := t.TempDir()
	t.Setenv("USERPROFILE", home)
	t.Setenv("PATH", t.TempDir())
	t.Setenv("PATHEXT", "")
	bunOmo := filepath.Join(home, ".bun", "bin", "omo.exe")
	writeScanFixture(t, bunOmo)

	binary, err := resolveOmoBinary("omo")
	if err != nil {
		t.Fatalf("resolveOmoBinary(\"omo\"): %v", err)
	}
	if binary != bunOmo {
		t.Fatalf("resolveOmoBinary(\"omo\") = %q, want default PATHEXT scan to find %q", binary, bunOmo)
	}
}

func TestResolveOmoBinaryMissingEverywhereReportsScan(t *testing.T) {
	home := t.TempDir()
	t.Setenv("USERPROFILE", home)
	t.Setenv("PATH", t.TempDir())
	t.Setenv("PATHEXT", ".COM;.EXE;.BAT;.CMD")

	binary, err := resolveOmoBinary("omo")
	if binary != "" {
		t.Fatalf("resolveOmoBinary(\"omo\") = %q, want empty", binary)
	}
	if !errors.Is(err, exec.ErrNotFound) {
		t.Fatalf("resolveOmoBinary(\"omo\") error = %v, want exec.ErrNotFound", err)
	}
	if !strings.Contains(err.Error(), filepath.Join(home, ".bun", "bin")) {
		t.Fatalf("resolveOmoBinary(\"omo\") error = %v, want the scanned directory named", err)
	}
}

func TestResolveOmoBinaryNpmInstall(t *testing.T) {
	shim, entry := writeNpmLauncherFixture(t, false)
	t.Setenv("PATH", filepath.Dir(shim))
	t.Setenv("PATHEXT", ".COM;.EXE;.BAT;.CMD")
	for _, input := range []string{"omo", shim, entry} {
		if _, err := resolveOmoBinary(input); err != nil {
			t.Errorf("npm launcher %q: %v", input, err)
		}
	}
}

func writeNpmLauncherFixture(t *testing.T, local bool) (shim, entry string) {
	t.Helper()
	prefix := filepath.Join(t.TempDir(), "npm prefix & spaces")
	root := filepath.Join(prefix, "node_modules", "omo-ai")
	entry = filepath.Join(root, "bin", "omo.js")
	writeScanFixture(t, entry)
	if err := os.WriteFile(filepath.Join(root, "package.json"), []byte(`{"name":"omo-ai","bin":{"omo":"bin/omo.js"}}`), 0600); err != nil {
		t.Fatal(err)
	}
	shim = filepath.Join(prefix, "omo.cmd")
	rel := `node_modules\omo-ai\bin\omo.js`
	if local {
		shim = filepath.Join(prefix, "node_modules", ".bin", "omo.cmd")
		rel = `..\omo-ai\bin\omo.js`
	}
	writeScanFixture(t, shim)
	content := "@ECHO off\r\nSET \"_prog=node\"\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\" + rel + "\" %*\r\n"
	if err := os.WriteFile(shim, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	return shim, entry
}

func TestNpmSupervisorExecPreservesArguments(t *testing.T) {
	node, err := exec.LookPath("node.exe")
	if err != nil {
		t.Skip("Node.js is required for the launcher execution contract")
	}
	for _, local := range []bool{false, true} {
		shim, entry := writeNpmLauncherFixture(t, local)
		if err := os.WriteFile(entry, []byte(`console.log(JSON.stringify(process.argv.slice(2)))`), 0600); err != nil {
			t.Fatal(err)
		}
		t.Setenv("PATH", filepath.Dir(node))
		t.Setenv("PATHEXT", ".EXE;.CMD")
		for _, launcher := range []string{shim, entry} {
			want := []string{"--internal-rpc-host-supervisor", "", "space here", "a&b", `"quoted"`, "%USERPROFILE%", `trailing\`}
			command, args, err := supervisorCommand(EnsureConfig{BinaryPath: launcher, ArgsTemplate: want})
			if err != nil {
				t.Fatal(err)
			}
			cmd, err := supervisorExecCommand(command, args)
			if err != nil {
				t.Fatal(err)
			}
			if cmd.Path != node || cmd.Args[1] != entry {
				t.Fatalf("launcher %q: native command=%v", launcher, cmd.Args)
			}
			output, err := cmd.Output()
			if err != nil {
				t.Fatal(err)
			}
			var got []string
			if err := json.Unmarshal(output, &got); err != nil || !slices.Equal(got, want) {
				t.Fatalf("launcher %q: argv=%q want=%q err=%v", launcher, got, want, err)
			}
		}
	}
}

func TestNpmSupervisorExecSiblingNodeAndMissingRuntime(t *testing.T) {
	shim, _ := writeNpmLauncherFixture(t, false)
	t.Setenv("PATH", t.TempDir())
	if _, err := supervisorExecCommand(shim, nil); err == nil || !strings.Contains(err.Error(), "Node.js is required") {
		t.Fatalf("missing Node error=%v", err)
	}
	sibling := filepath.Join(filepath.Dir(shim), "node.exe")
	writeScanFixture(t, sibling)
	cmd, err := supervisorExecCommand(shim, nil)
	if err != nil || cmd.Path != sibling {
		t.Fatalf("npm sibling Node: cmd=%v err=%v", cmd, err)
	}
}

func TestNpmLauncherRejectsBrokenAndUnrelatedInstalls(t *testing.T) {
	for _, fault := range []string{"missing entry", "wrong package", "unrelated shim"} {
		t.Run(fault, func(t *testing.T) {
			shim, entry := writeNpmLauncherFixture(t, false)
			var err error
			switch fault {
			case "missing entry":
				err = os.Remove(entry)
			case "wrong package":
				err = os.WriteFile(filepath.Join(filepath.Dir(filepath.Dir(entry)), "package.json"), []byte(`{"name":"other","bin":{"omo":"bin/omo.js"}}`), 0600)
			case "unrelated shim":
				err = os.WriteFile(shim, []byte("@echo off\r\nother-omo.exe %*\r\n"), 0600)
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err := resolveOmoBinary(shim); err == nil {
				t.Fatal("broken/unrelated explicit launcher accepted")
			}
		})
	}
}

func TestSupervisorExecKeepsNativeExe(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "omo.exe")
	writeScanFixture(t, binary)
	args := []string{"--internal-rpc-host-supervisor", "--socket", "path with spaces"}
	cmd, err := supervisorExecCommand(binary, args)
	if err != nil || cmd.Path != binary || !slices.Equal(cmd.Args[1:], args) {
		t.Fatalf("native launch changed: cmd=%v err=%v", cmd, err)
	}
}
