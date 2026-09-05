// Command windowsdiag verifies the Windows RPC daemon boot contract on a live
// runner. Modes:
//
//	bare - spawn the supervisor with no pre-created state; documents the
//	      stage-1 non-recursive mkdir crash inside omo's bootstrap.
//	pipe - pre-create the rpc dirs and a 32-byte <socket>.secret, spawn the
//	      supervisor, derive the \\.\pipe\senpi-rpc-<sha256[:32]> address the
//	      same way senpi's socket-transport.js does, dial it, send the secret
//	      handshake, and complete a get_protocol_info round-trip.
package main

import (
	"bufio"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	secretBytes    = 32
	readyWait      = 60 * time.Second
	pollInterval   = 100 * time.Millisecond
	readTimeout    = 10 * time.Second
	excerptLimit   = 400
	stderrLimit    = 32 << 10
	windowsPipePre = `\\.\pipe\senpi-rpc-`
)

var protocolInfoRequest = []byte(`{"id":"windowsdiag-1","type":"get_protocol_info"}` + "\n")

func main() {
	mode := "pipe"
	if len(os.Args) > 1 {
		mode = os.Args[1]
	}
	var line string
	switch mode {
	case "bare":
		line = runBare()
	case "pipe":
		line = runPipe()
	default:
		line = "G3=FAIL unknown mode " + mode
	}
	fmt.Println(line)
}

// pipeAddress mirrors resolveSocketTransportAddress in senpi's
// socket-transport.js: sha256(lowercased win32-normalized path || secret),
// first 32 hex characters, under the senpi-rpc pipe prefix.
func pipeAddress(socketPath string, secret []byte) string {
	canonical := strings.ToLower(filepath.Clean(socketPath))
	sum := sha256.Sum256(append([]byte(canonical), secret...))
	return windowsPipePre + hex.EncodeToString(sum[:16])
}

type diagEnv struct {
	tempDir  string
	agentDir string
	socket   string
	secret   []byte
	cmd      *exec.Cmd
	stderr   *limitBuffer
	waitCh   chan error
}

func setup(homeSuffix string) (*diagEnv, error) {
	tempDir, err := os.MkdirTemp("", "wd")
	if err != nil {
		return nil, err
	}
	home := filepath.Join(tempDir, homeSuffix)
	agentDir := filepath.Join(home, ".omo", "agent")
	return &diagEnv{
		tempDir:  tempDir,
		agentDir: agentDir,
		socket:   filepath.Join(agentDir, "rpc", "rpc.sock"),
		waitCh:   make(chan error, 1),
	}, nil
}

func (e *diagEnv) spawn() error {
	binary, err := exec.LookPath("omo")
	if err != nil {
		return err
	}
	cmd := exec.Command(binary,
		"--internal-rpc-host-supervisor",
		"--socket", e.socket,
		"--agent-dir", e.agentDir,
	)
	cmd.Env = isolatedEnv(filepath.Dir(filepath.Dir(e.agentDir)), e.agentDir)
	cmd.Dir = "."
	cmd.Stdin = nil
	cmd.Stdout = nil
	e.stderr = &limitBuffer{limit: stderrLimit}
	cmd.Stderr = io.MultiWriter(os.Stderr, e.stderr)
	configureSpawn(cmd)
	if err := cmd.Start(); err != nil {
		return err
	}
	e.cmd = cmd
	go func() { e.waitCh <- cmd.Wait() }()
	return nil
}

func (e *diagEnv) teardown() {
	if e.cmd != nil && e.cmd.Process != nil {
		_ = killProcessTree(e.cmd)
		select {
		case <-e.waitCh:
		case <-time.After(5 * time.Second):
		}
	}
	_ = os.RemoveAll(e.tempDir)
}

func runBare() string {
	e, err := setup("h")
	if err != nil {
		return fail("setup: " + err.Error())
	}
	defer e.teardown()
	if err := e.spawn(); err != nil {
		return fail("spawn: " + err.Error())
	}
	select {
	case err := <-e.waitCh:
		return "G3_BARE=EXITED err=" + errText(err) + " stderr=" + excerpt(e.stderr.String(), excerptLimit)
	case <-time.After(30 * time.Second):
		return "G3_BARE=TIMEOUT supervisor still running without pre-created state"
	}
}

func runPipe() string {
	e, err := setup("h")
	if err != nil {
		return fail("setup: " + err.Error())
	}
	defer e.teardown()
	if err := os.MkdirAll(filepath.Dir(e.socket), 0o700); err != nil {
		return fail("create rpc dir: " + err.Error())
	}
	if err := os.MkdirAll(filepath.Join(e.agentDir, "rpc-host-daemon"), 0o700); err != nil {
		return fail("create rpc-host-daemon dir: " + err.Error())
	}
	e.secret = make([]byte, secretBytes)
	if _, err := rand.Read(e.secret); err != nil {
		return fail("generate secret: " + err.Error())
	}
	if err := os.WriteFile(e.socket+".secret", e.secret, 0o600); err != nil {
		return fail("write secret: " + err.Error())
	}
	if err := e.spawn(); err != nil {
		return fail("spawn: " + err.Error())
	}
	addr := pipeAddress(e.socket, e.secret)
	fmt.Printf("derived_pipe=%s\n", addr)
	deadline := time.Now().Add(readyWait)
	for {
		conn, dialErr := os.OpenFile(addr, os.O_RDWR, 0)
		if dialErr == nil {
			return handshakePipe(conn, e)
		}
		select {
		case err := <-e.waitCh:
			return fail("supervisor exited before listening: " + errText(err) + " stderr=" + excerpt(e.stderr.String(), excerptLimit) + " tree=" + tree(e.agentDir))
		case <-time.After(pollInterval):
			if time.Now().After(deadline) {
				return fail("pipe never accepted dial: " + dialErr.Error() + " stderr=" + excerpt(e.stderr.String(), excerptLimit) + " tree=" + tree(e.agentDir))
			}
		}
	}
}

func handshakePipe(conn *os.File, e *diagEnv) string {
	defer conn.Close()
	if _, err := conn.Write(e.secret); err != nil {
		return fail("handshake write: " + err.Error())
	}
	if _, err := conn.Write(protocolInfoRequest); err != nil {
		return fail("request write: " + err.Error())
	}
	type readResult struct {
		line string
		err  error
	}
	ch := make(chan readResult, 1)
	go func() {
		line, err := bufio.NewReader(conn).ReadBytes('\n')
		ch <- readResult{string(line), err}
	}()
	select {
	case r := <-ch:
		if len(strings.TrimSpace(r.line)) == 0 {
			return fail("no response: " + errText(r.err) + " tree=" + tree(e.agentDir))
		}
		return "G3_PIPE=PASS " + excerpt(strings.TrimSpace(r.line), excerptLimit) + " rpc_sock_file_exists=" + strconv.FormatBool(fileExists(e.socket))
	case <-time.After(readTimeout):
		return fail("response timeout tree=" + tree(e.agentDir))
	}
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func tree(root string) string {
	var b strings.Builder
	_ = filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		if info.IsDir() {
			fmt.Fprintf(&b, "%s/", rel)
		} else {
			fmt.Fprintf(&b, "%s(%d)", rel, info.Size())
		}
		b.WriteByte(' ')
		return nil
	})
	return excerpt(b.String(), 600)
}

func fail(reason string) string { return "G3=FAIL " + reason }

func errText(err error) string {
	if err == nil {
		return "ok"
	}
	return err.Error()
}

func excerpt(s string, n int) string {
	s = strings.ReplaceAll(s, "\r", "")
	s = strings.ReplaceAll(s, "\n", " ")
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
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
