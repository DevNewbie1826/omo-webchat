package omorpc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/procexec"
)

var errWindowsInstallationUpdate = errors.New("in-place updates are unsupported on Windows: loaded native modules can leave a partial installation; stop all omo/senpi agents and webchat, then update omo-ai@beta with your installation's package manager in a terminal")

// UpdateInstallation updates the configured omo-ai package and its pinned engine.
// It does not contact, stop, or restart the running daemon. The caller owns the
// bounded installation context; it must not be an HTTP request context.
func UpdateInstallation(ctx context.Context, binary string) error {
	if runtime.GOOS == "windows" {
		return errWindowsInstallationUpdate
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if binary == "" {
		binary = "omo"
	}
	command, err := resolveOmoBinary(binary)
	if err != nil {
		return err
	}
	env := os.Environ()
	// Ambient agent markers are compatibility fallbacks for daemon startup, not
	// proof that an arbitrary configured executable belongs to that installation.
	detectionEnv := setEnv(setEnv(env, "OMO_BIN", ""), "OMO_AGENT_TOOLKIT_BIN", "")
	installation, recognized, err := resolveLauncherInstallation(command, detectionEnv)
	if err != nil {
		return fmt.Errorf("resolve update installation: %w", err)
	}
	if !recognized {
		return errors.New("unsupported omo installation: configured launcher is not recognized")
	}
	entry, err := filepath.EvalSymlinks(installation.entry)
	if err != nil {
		return fmt.Errorf("resolve update entry: %w", err)
	}
	root := filepath.Dir(filepath.Dir(entry))
	if filepath.Base(entry) != "omo.js" || filepath.Base(filepath.Dir(entry)) != "bin" {
		return errors.New("unsupported omo installation: launcher entry is not bin/omo.js")
	}
	var manifest struct {
		Name string `json:"name"`
	}
	data, err := os.ReadFile(filepath.Join(root, "package.json"))
	if err != nil {
		return fmt.Errorf("read update installation: %w", err)
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		return fmt.Errorf("read update manifest: %w", err)
	}
	if manifest.Name != "omo-ai" {
		return errors.New("unsupported omo installation: package is not omo-ai")
	}

	var executable, cwd, binDir string
	var args []string
	switch {
	case isBunLauncherInstallation(root):
		global := filepath.Dir(filepath.Dir(root))
		prefix := filepath.Dir(filepath.Dir(global))
		binDir = filepath.Join(prefix, "bin")
		executable = filepath.Join(binDir, "bun")
		args = []string{"add", "--cwd", root, "-g", "omo-ai@beta"}
		cwd = root
		env = setEnv(setEnv(env, "BUN_INSTALL", prefix), "BUN_INSTALL_GLOBAL_DIR", global)
	case strings.HasSuffix(filepath.ToSlash(root), "/lib/node_modules/omo-ai"):
		prefix := filepath.Dir(filepath.Dir(filepath.Dir(root)))
		binDir = filepath.Join(prefix, "bin")
		executable = filepath.Join(binDir, "node")
		npm := filepath.Join(prefix, "lib", "node_modules", "npm", "bin", "npm-cli.js")
		info, err := os.Stat(npm)
		if err != nil {
			return fmt.Errorf("matching npm CLI is unavailable: %w", err)
		}
		if !info.Mode().IsRegular() {
			return errors.New("matching npm CLI is not a regular file")
		}
		args = []string{npm, "i", "-g", "--prefix", prefix, "omo-ai@beta"}
		cwd = prefix
	default:
		return errors.New("unsupported omo installation: expected an npm prefix or Bun global installation")
	}
	// Never use an unrelated PATH npm/bun. npm runs through this prefix's Node
	// and receives an explicit prefix, overriding ambient npm configuration.
	executable, err = exec.LookPath(executable)
	if err != nil {
		return fmt.Errorf("matching package-manager runtime is unavailable: %w", err)
	}
	path, _ := lookupEnv(env, "PATH")
	env = setEnv(updateInstallationEnvironment(env), "PATH", binDir+string(os.PathListSeparator)+path)
	cmd := exec.Command(executable, args...)
	// A nil Stdin is the null device, not webchat's terminal or the request body.
	cmd.Env, cmd.Dir = env, cwd
	cmd.WaitDelay = 2 * time.Second
	output := &updateOutput{}
	cmd.Stdout, cmd.Stderr = output, output
	procexec.SetupCommand(cmd)
	if err := ctx.Err(); err != nil {
		return err
	}
	tracked, err := procexec.StartTracked(cmd)
	if err != nil {
		return fmt.Errorf("start package update: %w", err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	var runErr error
	select {
	case runErr = <-done:
	case <-ctx.Done():
		terminateErr := tracked.TerminateTree()
		runErr = errors.Join(ctx.Err(), terminateErr, <-done)
	}
	// Reap/terminate any descendants even when the package manager exits first.
	cleanupErr := errors.Join(tracked.TerminateTree(), tracked.Close())
	if err := errors.Join(runErr, cleanupErr); err != nil {
		return fmt.Errorf("omo installation update failed: %w\n%s", err, strings.TrimSpace(string(output.tail)))
	}
	return nil
}

const updateOutputLimit = 8 << 10

func updateInstallationEnvironment(env []string) []string {
	clean := make([]string, 0, len(env))
	for _, entry := range env {
		key, _, _ := strings.Cut(entry, "=")
		key = strings.ToUpper(key)
		// In particular OMO_SENPI_PATCH_ROOT redirects omo-ai's postinstall
		// patcher. Launch markers and inherited runtime preloads must not leak
		// into installation scripts; registry/proxy/credential settings remain.
		if strings.HasPrefix(key, "OMO_") || strings.HasPrefix(key, "SENPI_") || key == "NODE_OPTIONS" || key == "BUN_OPTIONS" {
			continue
		}
		clean = append(clean, entry)
	}
	return clean
}

// os/exec serializes writes when stdout and stderr share the same writer.
// Keep the diagnostic tail, where package managers normally put their failure.
type updateOutput struct{ tail []byte }

func (w *updateOutput) Write(p []byte) (int, error) {
	n := len(p)
	if len(p) >= updateOutputLimit {
		w.tail = append(w.tail[:0], p[len(p)-updateOutputLimit:]...)
		return n, nil
	}
	if excess := len(w.tail) + len(p) - updateOutputLimit; excess > 0 {
		w.tail = w.tail[excess:]
	}
	w.tail = append(w.tail, p...)
	return n, nil
}
