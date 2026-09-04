//go:build darwin || linux

package omorpc

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func writeExecutableFile(t *testing.T, dir, name string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\nexit 0\n"), 0o700); err != nil {
		t.Fatalf("write executable %s: %v", path, err)
	}
	return path
}

func TestResolveOmoBinaryExplicitOverrideBeatsPathOmo(t *testing.T) {
	pathDir := t.TempDir()
	pathOmo := writeExecutableFile(t, pathDir, "omo")
	t.Setenv("PATH", pathDir)
	overrideDir := t.TempDir()
	override := writeExecutableFile(t, overrideDir, "real-override")

	binary, err := resolveOmoBinary(override)
	if err != nil {
		t.Fatalf("resolveOmoBinary(%q): %v", override, err)
	}
	if binary != override {
		t.Fatalf("resolveOmoBinary(%q) = %q, want the override itself over PATH %q", override, binary, pathOmo)
	}
}

func TestResolveOmoBinaryMissingOverrideFailsWithoutPathFallback(t *testing.T) {
	pathDir := t.TempDir()
	pathOmo := writeExecutableFile(t, pathDir, "omo")
	t.Setenv("PATH", pathDir)
	missing := filepath.Join(t.TempDir(), "not-installed")

	binary, err := resolveOmoBinary(missing)
	if binary != "" {
		t.Fatalf("resolveOmoBinary(%q) = %q, want empty", missing, binary)
	}
	if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("resolveOmoBinary(%q) error = %v, want os.ErrNotExist", missing, err)
	}
	if !strings.Contains(err.Error(), missing) || strings.Contains(err.Error(), pathOmo) {
		t.Fatalf("resolveOmoBinary(%q) error = %v, want the missing override named and no PATH fallback", missing, err)
	}
}

func TestResolveOmoBinaryDefaultNameResolvesViaPath(t *testing.T) {
	pathDir := t.TempDir()
	pathOmo := writeExecutableFile(t, pathDir, "omo")
	t.Setenv("PATH", pathDir)
	t.Setenv("HOME", t.TempDir())

	binary, err := resolveOmoBinary("omo")
	if err != nil {
		t.Fatalf("resolveOmoBinary(\"omo\"): %v", err)
	}
	if binary != pathOmo {
		t.Fatalf("resolveOmoBinary(\"omo\") = %q, want PATH entry %q", binary, pathOmo)
	}
}

func TestResolveOmoBinaryDefaultNameNeverScansBunUserInstall(t *testing.T) {
	home := t.TempDir()
	bunBin := filepath.Join(home, ".bun", "bin")
	if err := os.MkdirAll(bunBin, 0o700); err != nil {
		t.Fatal(err)
	}
	bunOmo := writeExecutableFile(t, bunBin, "omo")
	emptyDir := t.TempDir()
	t.Setenv("PATH", emptyDir)
	t.Setenv("HOME", home)

	binary, err := resolveOmoBinary("omo")
	if binary != "" {
		t.Fatalf("resolveOmoBinary(\"omo\") = %q, want empty", binary)
	}
	if !errors.Is(err, exec.ErrNotFound) {
		t.Fatalf("resolveOmoBinary(\"omo\") error = %v, want exec.ErrNotFound from PATH-only resolution", err)
	}
	if strings.Contains(err.Error(), bunOmo) {
		t.Fatalf("resolveOmoBinary(\"omo\") error = %v, must not reference the bun candidate %q", err, bunOmo)
	}
}
