package main

import (
	"errors"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestCommandLineExitCodes(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "omo-webchat")
	build := exec.Command("go", "build", "-o", binary, ".")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build server executable: %v\n%s", err, output)
	}

	t.Run("help succeeds without a configuration error", func(t *testing.T) {
		output, err := exec.Command(binary, "--help").CombinedOutput()
		if err != nil {
			t.Fatalf("run --help: %v\n%s", err, output)
		}
		if !strings.Contains(string(output), "Usage of omo-webchat:") {
			t.Errorf("--help output does not contain usage:\n%s", output)
		}
		if strings.Contains(string(output), "configuration error") {
			t.Errorf("--help output contains configuration error:\n%s", output)
		}
	})

	t.Run("invalid flags fail", func(t *testing.T) {
		output, err := exec.Command(binary, "--not-a-flag").CombinedOutput()
		var exitErr *exec.ExitError
		if !errors.As(err, &exitErr) {
			t.Fatalf("run invalid flag: %v\n%s", err, output)
		}
		if exitErr.ExitCode() == 0 {
			t.Errorf("invalid flag exit code = 0, want nonzero\n%s", output)
		}
		if !strings.Contains(string(output), "configuration error") {
			t.Errorf("invalid flag output does not contain configuration error:\n%s", output)
		}
	})
}
