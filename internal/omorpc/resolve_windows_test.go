//go:build windows

package omorpc

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
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
