package daemon

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestPIDFileRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), pidFileName)
	const pid = 4242
	if err := writePIDFile(path, pid); err != nil {
		t.Fatalf("writePIDFile() error = %v", err)
	}
	got, err := readPIDFile(path)
	if err != nil {
		t.Fatalf("readPIDFile() error = %v", err)
	}
	if got != pid {
		t.Fatalf("readPIDFile() = %d, want %d", got, pid)
	}
}

func TestDaemonPathsHonorsExplicitDir(t *testing.T) {
	// Given
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_STATE_HOME", "")
	defaultDir := filepath.Join(home, ".local", "state", "omo-webchat")

	// Then — without an explicit dir, paths resolve under the store default
	pidPath, logPath, lockPath, err := daemonPaths("")
	if err != nil {
		t.Fatalf("daemonPaths(\"\") error = %v", err)
	}
	if pidPath != filepath.Join(defaultDir, pidFileName) {
		t.Fatalf("daemonPaths(\"\") pid = %q, want %q", pidPath, filepath.Join(defaultDir, pidFileName))
	}
	if logPath != filepath.Join(defaultDir, logFileName) {
		t.Fatalf("daemonPaths(\"\") log = %q, want %q", logPath, filepath.Join(defaultDir, logFileName))
	}
	if lockPath != filepath.Join(defaultDir, lockFileName) {
		t.Fatalf("daemonPaths(\"\") lock = %q, want %q", lockPath, filepath.Join(defaultDir, lockFileName))
	}

	// Then — an explicit dir wins over the store default
	pidPath, logPath, lockPath, err = daemonPaths("/explicit/x")
	if err != nil {
		t.Fatalf("daemonPaths(\"/explicit/x\") error = %v", err)
	}
	if pidPath != filepath.Join("/explicit/x", pidFileName) {
		t.Fatalf("daemonPaths(\"/explicit/x\") pid = %q, want %q", pidPath, filepath.Join("/explicit/x", pidFileName))
	}
	if logPath != filepath.Join("/explicit/x", logFileName) {
		t.Fatalf("daemonPaths(\"/explicit/x\") log = %q, want %q", logPath, filepath.Join("/explicit/x", logFileName))
	}
	if lockPath != filepath.Join("/explicit/x", lockFileName) {
		t.Fatalf("daemonPaths(\"/explicit/x\") lock = %q, want %q", lockPath, filepath.Join("/explicit/x", lockFileName))
	}
}

func TestReadPIDFileMalformedIsNotRunning(t *testing.T) {
	for _, content := range []string{"", "not-a-pid\n", "-1\n"} {
		t.Run(content, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), pidFileName)
			if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
				t.Fatal(err)
			}
			_, err := readPIDFile(path)
			if !errors.Is(err, ErrNotRunning) {
				t.Fatalf("readPIDFile() error = %v, want ErrNotRunning", err)
			}
		})
	}
}
