//go:build windows

package omorpc

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// defaultPathExt is the Windows command-lookup extension order when PATHEXT
// is unset. Batch shims are included only so resolution can reject them with
// a direct error instead of attempting to pass them to CreateProcess.
const defaultPathExt = ".COM;.EXE;.BAT;.CMD"

// resolveOmoBinary resolves the supervisor command for EnsureDaemon. Order:
// an explicit cfg override is LookPath'd strictly (no silent fallback), then
// PATH via the default "omo" name, then the bun user-level install scan.
// Live probing of windows runners showed bun installs a real omo.exe on
// PATH, while user-level installs may live outside PATH at
// %USERPROFILE%\.bun\bin.
func resolveOmoBinary(cfgPath string) (string, error) {
	binary, err := exec.LookPath(cfgPath)
	if err == nil {
		if shimErr := batchShimError(binary); shimErr != nil {
			return "", shimErr
		}
		return binary, nil
	}
	if cfgPath != "omo" {
		return "", fmt.Errorf("omorpc: resolve supervisor %q: %w", cfgPath, err)
	}
	home := os.Getenv("USERPROFILE")
	if home == "" {
		return "", fmt.Errorf("omorpc: resolve supervisor %q: %w", cfgPath, err)
	}
	bunBin := filepath.Join(home, ".bun", "bin")
	pathExt := os.Getenv("PATHEXT")
	if strings.Trim(pathExt, " ;") == "" {
		pathExt = defaultPathExt
	}
	for _, ext := range strings.Split(pathExt, ";") {
		ext = strings.TrimSpace(ext)
		if ext == "" {
			continue
		}
		if !strings.HasPrefix(ext, ".") {
			ext = "." + ext
		}
		ext = strings.ToUpper(ext)
		switch ext {
		case ".COM", ".EXE", ".BAT", ".CMD":
		default:
			continue
		}
		candidate := filepath.Join(bunBin, "omo"+ext)
		info, statErr := os.Stat(candidate)
		if errors.Is(statErr, os.ErrNotExist) {
			continue
		}
		if statErr != nil {
			return "", fmt.Errorf("omorpc: inspect supervisor candidate %q: %w", candidate, statErr)
		}
		if info.IsDir() {
			continue
		}
		if shimErr := batchShimError(candidate); shimErr != nil {
			return "", shimErr
		}
		return candidate, nil
	}
	return "", fmt.Errorf("omorpc: resolve supervisor %q: %w (also scanned %s)", cfgPath, err, bunBin)
}

// batchShimError rejects .bat/.cmd resolutions: CreateProcess cannot launch
// command shims directly, and routing them through cmd.exe is out of scope
// for this phase, so the caller must point the explicit binary path at a
// native executable.
func batchShimError(path string) error {
	ext := strings.ToLower(filepath.Ext(path))
	if ext != ".bat" && ext != ".cmd" {
		return nil
	}
	return fmt.Errorf("omorpc: resolve supervisor: %s is a %s command shim; set the explicit binary path (EnsureConfig.BinaryPath) to the native executable", path, ext)
}
