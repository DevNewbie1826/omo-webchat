// Command windowsprobe live-probes whether the omo RPC supervisor can
// accept an AF_UNIX client on this host. It records evidence and always
// exits 0 unless the process crashes.
package main

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const (
	readyWait    = 60 * time.Second
	pollInterval = 50 * time.Millisecond
	dialTimeout  = 2 * time.Second
	readTimeout  = 10 * time.Second
	killWait     = 5 * time.Second
	excerptLimit = 200
	stderrLimit  = 64 << 10
)

// protocolInfoRequest is the get_protocol_info wire record EncodeRequest
// emits for an empty command (id + type, LF-terminated JSON).
var protocolInfoRequest = []byte(`{"id":"windowsprobe-1","type":"get_protocol_info"}` + "\n")

func main() {
	line, cleanup := runProbe()
	fmt.Println(line)
	cleanup()
}

func runProbe() (string, func()) {
	nop := func() {}
	tempDir, err := os.MkdirTemp("", "omo-windowsprobe-")
	if err != nil {
		return fail("create temp dir: " + err.Error()), nop
	}

	homeDir := filepath.Join(tempDir, "home")
	agentDir := filepath.Join(homeDir, ".omo", "agent")
	socketPath := filepath.Join(agentDir, "rpc", "rpc.sock")
	var (
		cmd    *exec.Cmd
		waitCh <-chan error
	)
	cleanup := func() {
		if cmd != nil {
			killErr := killProcessTree(cmd)
			fmt.Printf("cleanup: process_tree pid=%d killed=%s\n", cmdPID(cmd), errText(killErr))
			if waitCh != nil {
				select {
				case <-waitCh:
				case <-time.After(killWait):
					fmt.Println("cleanup: process_tree wait=timeout")
				}
			}
		}
		fmt.Printf("cleanup: temp_dir %s removed=%s\n", tempDir, errText(removeAllDeadline(tempDir, killWait)))
	}
	if err := os.MkdirAll(filepath.Dir(socketPath), 0o700); err != nil {
		return fail("create rpc dir: " + err.Error()), cleanup
	}

	binary, err := exec.LookPath("omo")
	if err != nil {
		return fail("resolve omo: " + err.Error()), cleanup
	}

	// Mirrors supervisorCommand with empty ChildCommand: native omo
	// supervisor, socket and agent-dir substituted, no --child-*.
	cmd = exec.Command(binary,
		"--internal-rpc-host-supervisor",
		"--socket", socketPath,
		"--agent-dir", agentDir,
	)
	cmd.Env = isolatedEnv(homeDir, agentDir)
	cmd.Dir = "."
	cmd.Stdin = nil
	cmd.Stdout = nil
	stderr := &limitBuffer{limit: stderrLimit}
	cmd.Stderr = io.MultiWriter(os.Stderr, stderr)
	configureSpawn(cmd)
	if err := cmd.Start(); err != nil {
		return fail("start supervisor: " + err.Error()), cleanup
	}
	ch := make(chan error, 1)
	go func() { ch <- cmd.Wait() }()
	waitCh = ch

	return probeSocket(socketPath, waitCh, stderr), cleanup
}

func probeSocket(socketPath string, waitCh <-chan error, stderr *limitBuffer) string {
	deadline := time.Now().Add(readyWait)
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()

	seen := false
	var lastDial error
	for {
		if _, err := os.Stat(socketPath); err == nil {
			seen = true
			conn, err := net.DialTimeout("unix", socketPath, dialTimeout)
			if err == nil {
				return handshake(conn)
			}
			lastDial = err
		}
		select {
		case err := <-waitCh:
			return fail(failAfterDeadline(seen, lastDial, stderr) + " supervisor_exited=" + errText(err))
		case <-ticker.C:
			if !time.Now().Before(deadline) {
				return fail(failAfterDeadline(seen, lastDial, stderr))
			}
		}
	}
}

func handshake(conn net.Conn) string {
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(readTimeout)); err != nil {
		return fail("no response: deadline: " + err.Error())
	}
	if _, err := conn.Write(protocolInfoRequest); err != nil {
		return fail("no response: write: " + err.Error())
	}
	line, err := bufio.NewReader(conn).ReadBytes('\n')
	if err != nil && len(line) == 0 {
		return fail("no response: " + err.Error())
	}
	if len(strings.TrimSpace(string(line))) == 0 {
		return fail("no response")
	}
	return "G1_AF_UNIX=PASS " + excerpt(string(line), excerptLimit)
}

func failAfterDeadline(seen bool, lastDial error, stderr *limitBuffer) string {
	reason := "socket never appeared"
	if seen {
		reason = "dial failed"
		if lastDial != nil {
			reason += ": " + lastDial.Error()
		}
	}
	if extra := strings.TrimSpace(stderr.String()); extra != "" {
		reason += " stderr=" + excerpt(extra, excerptLimit)
	}
	return reason
}

func fail(reason string) string { return "G1_AF_UNIX=FAIL " + reason }

func excerpt(s string, n int) string {
	s = strings.ReplaceAll(s, "\r", "")
	s = strings.ReplaceAll(s, "\n", " ")
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

func cmdPID(cmd *exec.Cmd) int {
	if cmd == nil || cmd.Process == nil {
		return 0
	}
	return cmd.Process.Pid
}

func errText(err error) string {
	if err == nil {
		return "ok"
	}
	return err.Error()
}

func removeAllDeadline(path string, budget time.Duration) error {
	// Win32 handle close after TerminateProcess is not synchronous;
	// retry until the directory unlink succeeds or the budget expires.
	deadline := time.Now().Add(budget)
	var err error
	for {
		err = os.RemoveAll(path)
		if err == nil || !time.Now().Before(deadline) {
			return err
		}
		time.Sleep(pollInterval)
	}
}

type limitBuffer struct {
	limit int
	buf   []byte
}

func (w *limitBuffer) Write(p []byte) (int, error) {
	if remain := w.limit - len(w.buf); remain > 0 {
		if remain > len(p) {
			remain = len(p)
		}
		w.buf = append(w.buf, p[:remain]...)
	}
	return len(p), nil
}

func (w *limitBuffer) String() string { return string(w.buf) }
