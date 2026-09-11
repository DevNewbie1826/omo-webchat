//go:build windows

package omorpc

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

// defaultPathExt is the Windows command-lookup extension order when PATHEXT
// is unset. Recognized npm shims are launched through Node, never CreateProcess
// or a shell; other batch shims receive an actionable error.
const defaultPathExt = ".COM;.EXE;.BAT;.CMD"

// resolveOmoBinary resolves the supervisor command for EnsureDaemon. Order:
// an explicit cfg override is LookPath'd strictly (no silent fallback), then
// PATH via the default "omo" name, then the bun user-level install scan.
// Live probing of windows runners showed bun installs a real omo.exe on
// PATH, while user-level installs may live outside PATH at
// %USERPROFILE%\.bun\bin.
func resolveOmoBinary(cfgPath string) (string, error) {
	// An explicit JavaScript entry does not need a .JS file association or a
	// PATHEXT entry: Node, rather than Windows, will execute it.
	if strings.EqualFold(filepath.Ext(cfgPath), ".js") && strings.ContainsAny(cfgPath, `/\`) {
		entry, err := filepath.Abs(cfgPath)
		if err == nil {
			err = regularLauncherFile(entry)
		}
		if err != nil {
			return "", fmt.Errorf("omorpc: resolve supervisor %q: %w", cfgPath, err)
		}
		return entry, nil
	}
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
	// Read the bin directory once and match case-insensitively: PATHEXT uses
	// uppercase extensions while the on-disk name keeps its own casing, so the
	// returned path must come from the directory listing, not the pattern.
	entries, dirErr := os.ReadDir(bunBin)
	if dirErr != nil {
		return "", fmt.Errorf("omorpc: resolve supervisor %q: %w (also scanned %s)", cfgPath, err, bunBin)
	}
	for _, ext := range strings.Split(pathExt, ";") {
		ext = strings.TrimSpace(ext)
		if ext == "" {
			continue
		}
		if !strings.HasPrefix(ext, ".") {
			ext = "." + ext
		}
		switch strings.ToUpper(ext) {
		case ".COM", ".EXE", ".BAT", ".CMD":
		default:
			continue
		}
		for _, entry := range entries {
			if entry.IsDir() || !strings.EqualFold(entry.Name(), "omo"+ext) {
				continue
			}
			candidate := filepath.Join(bunBin, entry.Name())
			if shimErr := batchShimError(candidate); shimErr != nil {
				return "", shimErr
			}
			return candidate, nil
		}
	}
	return "", fmt.Errorf("omorpc: resolve supervisor %q: %w (also scanned %s)", cfgPath, err, bunBin)
}

// batchShimError accepts only a known npm omo shim. Arbitrary batch programs
// cannot be faithfully run without a shell and remain unsupported.
func batchShimError(path string) error {
	ext := strings.ToLower(filepath.Ext(path))
	if ext != ".bat" && ext != ".cmd" {
		return nil
	}
	_, err := npmOmoEntry(path)
	return err
}

// Match only npm's quoted invocation of the official global/local omo-ai bin.
// The batch program is inspected, never evaluated or passed to cmd.exe.
var npmOmoInvocation = regexp.MustCompile(`(?im)"%_prog%"[ \t]+"%dp0%[\\/]((?:node_modules|\.\.)[\\/]omo-ai[\\/]bin[\\/]omo\.js)"[ \t]+%\*[ \t]*\r?$`)

func npmOmoEntry(shim string) (string, error) {
	data, err := os.ReadFile(shim)
	if err != nil {
		return "", fmt.Errorf("omorpc: read npm launcher %q: %w", shim, err)
	}
	match := npmOmoInvocation.FindSubmatch(data)
	if match == nil {
		return "", fmt.Errorf("omorpc: resolve supervisor: %s is an unsupported command shim; set CHAT_PI_BINARY to omo.exe or the official omo-ai/bin/omo.js entry", shim)
	}
	entry := filepath.Clean(filepath.Join(filepath.Dir(shim), string(match[1])))
	manifestPath := filepath.Join(filepath.Dir(filepath.Dir(entry)), "package.json")
	manifest, err := os.ReadFile(manifestPath)
	if err != nil {
		return "", fmt.Errorf("omorpc: read npm omo package %q: %w", manifestPath, err)
	}
	var pkg struct {
		Name string            `json:"name"`
		Bin  map[string]string `json:"bin"`
	}
	if err := json.Unmarshal(manifest, &pkg); err != nil || pkg.Name != "omo-ai" || filepath.Clean(pkg.Bin["omo"]) != filepath.Join("bin", "omo.js") {
		return "", fmt.Errorf("omorpc: %s does not describe the official omo-ai bin; set CHAT_PI_BINARY to the intended launcher", manifestPath)
	}
	if err := regularLauncherFile(entry); err != nil {
		return "", fmt.Errorf("omorpc: npm omo entry %q: %w", entry, err)
	}
	return entry, nil
}

func regularLauncherFile(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("%s is not a regular launcher file", path)
	}
	return nil
}

// Keep the resolved launcher as the daemon's identity/cache key, but translate
// JavaScript to a native executable plus argv at the actual process boundary.
// The same tracked Windows job still owns Node and every launcher descendant.
func supervisorExecCommand(command string, args []string) (*exec.Cmd, error) {
	entry := command
	switch strings.ToLower(filepath.Ext(command)) {
	case ".cmd", ".bat":
		var err error
		entry, err = npmOmoEntry(command)
		if err != nil {
			return nil, err
		}
	case ".js":
	default:
		return exec.Command(command, args...), nil
	}
	// npm's shim gives a sibling node.exe priority over PATH.
	node := filepath.Join(filepath.Dir(command), "node.exe")
	if _, err := os.Stat(node); os.IsNotExist(err) {
		var lookupErr error
		node, lookupErr = exec.LookPath("node.exe")
		if lookupErr != nil {
			return nil, fmt.Errorf("omorpc: Node.js is required for %s: %w", command, lookupErr)
		}
	} else if err != nil {
		return nil, err
	}
	if err := regularLauncherFile(node); err != nil {
		return nil, fmt.Errorf("omorpc: resolve Node.js: %w", err)
	}
	return exec.Command(node, append([]string{entry}, args...)...), nil
}
