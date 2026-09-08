//go:build windows && realomo

package omorpc

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// Run the unchanged installed-engine contract with a compiler-only observation
// of our transport. No installed package or production source is modified.
func TestWindowsRealOmoReconnectTrace(t *testing.T) {
	dir := t.TempDir()
	replacements := make(map[string]string)
	originals := make(map[string][]byte)
	for _, name := range []string{"pipe_io_windows.go", "ensure_peercred_windows.go"} {
		source, err := filepath.Abs(name)
		if err != nil {
			t.Fatal(err)
		}
		original, err := os.ReadFile(source)
		if err != nil {
			t.Fatal(err)
		}
		originals[source] = original
		patched := string(original)
		replace := func(old, next string) {
			t.Helper()
			if strings.Count(patched, old) != 1 {
				t.Fatalf("transport observation boundary changed in %s", name)
			}
			patched = strings.Replace(patched, old, next, 1)
		}
		if name == "pipe_io_windows.go" {
			replace("import (", "import (\n\"encoding/json\"\n\"fmt\"\n\"golang.org/x/sys/windows\"")
			replace("return n, pipeIOError(\"read\", err)", `if err != nil {
				var peek uintptr
				var peekErr error
				if errors.Is(err, io.EOF) {
					fd := p.Conn.(interface { Fd() uintptr }).Fd()
					peek, _, peekErr = windows.NewLazySystemDLL("kernel32.dll").NewProc("PeekNamedPipe").Call(fd, 0, 0, 0, 0, 0)
				}
				fmt.Fprintf(os.Stderr, "NATIVE_READ conn=%p peer=%d bytes=%d error=%v peek=%d peek-error=%v\n", p, p.pid, n, err, peek, peekErr)
			}
			return n, pipeIOError("read", err)`)
			replace("return n, pipeIOError(\"write\", err)", `var request struct { ID string; Type string }
			decoded := json.Unmarshal(data, &request) == nil
			fmt.Fprintf(os.Stderr, "NATIVE_WRITE conn=%p peer=%d bytes=%d wanted=%d error=%v request=%t type=%s id=%s\n", p, p.pid, n, len(data), err, decoded, request.Type, request.ID)
			return n, pipeIOError("write", err)`)
		} else {
			replace("p.closeErr = errors.Join(p.Conn.Close(), windows.CloseHandle(p.process))", `fmt.Fprintf(os.Stderr, "NATIVE_CLOSE conn=%p peer=%d local-close-start=true\n", p, p.pid)
			p.closeErr = errors.Join(p.Conn.Close(), windows.CloseHandle(p.process))`)
		}
		target := filepath.Join(dir, name)
		if err := os.WriteFile(target, []byte(patched), 0600); err != nil {
			t.Fatal(err)
		}
		replacements[source] = target
	}
	encoded, err := json.Marshal(map[string]any{"Replace": replacements})
	if err != nil {
		t.Fatal(err)
	}
	overlay := filepath.Join(dir, "overlay.json")
	if err := os.WriteFile(overlay, encoded, 0600); err != nil {
		t.Fatal(err)
	}
	exe := filepath.Join(dir, "reconnect.test.exe")
	build := exec.CommandContext(t.Context(), "go", "test", "-tags=realomo", "-c", "-overlay", overlay, "-o", exe, ".")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build transport observation: %v\n%s", err, output)
	}
	cmd := exec.CommandContext(t.Context(), exe, "-test.run=^TestWindowsRealOmoReconnect$", "-test.v", "-test.timeout=2m")
	output, runErr := cmd.CombinedOutput()
	t.Logf("native transport observation: exit=%v\n%s", runErr, output)
	for source, original := range originals {
		after, err := os.ReadFile(source)
		if err != nil || !bytes.Equal(after, original) {
			t.Errorf("transport observation changed source: %v", err)
		}
	}
	t.Log("cleanup: observation child joined; compiler overlay/executable owned by TempDir cleanup")
	if runErr != nil {
		t.Fatal("installed-engine reconnect contract failed with native observation")
	}
}
