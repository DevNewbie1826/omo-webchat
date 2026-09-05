package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/DevNewbie1826/omo-webchat/test/windowsprobe/profile"
)

func runServerProbe(binary, runtimeName string) (resultErr error) {
	dir, err := os.MkdirTemp("", "wh")
	if err != nil {
		return err
	}
	defer func() {
		err := profile.RemoveAll(dir)
		fmt.Printf("cleanup: server-profile=%s error=%v\n", dir, err)
		resultErr = errors.Join(resultErr, err)
	}()
	home := filepath.Join(dir, "home")
	agent := filepath.Join(home, ".omo", "agent")
	cmd := exec.Command(binary, "--host", "127.0.0.1", "--port", "0", "--root", dir, "--state-dir", filepath.Join(dir, "state"))
	cmd.Env = isolatedEnv(home, agent)
	cmd.Env = setEnv(cmd.Env, "TH_PASSWORD", "isolated-http-probe")
	cmd.Env = setEnv(cmd.Env, "OMO_RUNTIME", runtimeName)
	// A nested server must re-enter the product launcher, not accidentally
	// consume a parent's unrelated native-host brand profile.
	cmd.Env = setEnv(cmd.Env, "SENPI_BRAND", `{"name":"unrelated-parent"}`)
	logs := &serverReadiness{ready: make(chan string, 1)}
	cmd.Stdout = logs
	cmd.Stderr = logs
	fmt.Printf("server: runtime=%s command=%q\n", runtimeName, cmd.Args)
	done, stop, err := startProbeServer(cmd)
	if err != nil {
		return err
	}
	defer func() {
		err := stop()
		fmt.Printf("cleanup: server pid=%d tree-drained=%t error=%v\n", cmd.Process.Pid, err == nil, err)
		resultErr = errors.Join(resultErr, err)
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	var address string
	select {
	case address = <-logs.ready:
	case err := <-done:
		return fmt.Errorf("server exited before readiness: %w; %s", err, logs.String())
	case <-ctx.Done():
		return fmt.Errorf("server readiness: %w; %s", ctx.Err(), logs.String())
	}
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return fmt.Errorf("server readiness address: %w", err)
	}
	number, err := strconv.Atoi(port)
	if err != nil || host != "127.0.0.1" || number < 1 || number > 65535 {
		return fmt.Errorf("invalid bound loopback address %q", address)
	}
	url := "http://" + address + "/"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("GET %s: %w", url, err)
	}
	body, readErr := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	closeErr := resp.Body.Close()
	if err := errors.Join(readErr, closeErr); err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/html") || !bytes.Contains(body, []byte("<html")) {
		return fmt.Errorf("GET %s: status=%d content-type=%q, expected HTML 200", url, resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	fmt.Printf("server: runtime=%s GET %s status=%d\n", runtimeName, url, resp.StatusCode)
	return nil
}

// The production structured listening record is emitted only after bind. This
// subscribes before Start and joins that exact event, with no polling/sleeps.
type serverReadiness struct {
	mu      sync.Mutex
	pending []byte
	tail    []byte
	ready   chan string
	once    sync.Once
}

func (w *serverReadiness) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.tail = append(w.tail, p...)
	if len(w.tail) > 8192 {
		w.tail = w.tail[len(w.tail)-8192:]
	}
	w.pending = append(w.pending, p...)
	for {
		end := bytes.IndexByte(w.pending, '\n')
		if end < 0 {
			break
		}
		line := string(w.pending[:end])
		w.pending = w.pending[end+1:]
		if !strings.Contains(line, "msg=listening ") {
			continue
		}
		for _, field := range strings.Fields(line) {
			if address, ok := strings.CutPrefix(field, "addr="); ok {
				w.once.Do(func() { w.ready <- strings.Trim(address, `"`) })
			}
		}
	}
	if len(w.pending) > 8192 {
		w.pending = nil
	}
	return len(p), nil
}

func (w *serverReadiness) String() string { w.mu.Lock(); defer w.mu.Unlock(); return string(w.tail) }
