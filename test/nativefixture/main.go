// Command nativefixture owns an isolated RPC fixture and one smoke worker.
// Its private stdin is an EOF shutdown channel; it never starts a user engine.
package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"

	"github.com/DevNewbie1826/omo-webchat/frontend"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
	"github.com/DevNewbie1826/omo-webchat/internal/procexec"
)

type asset struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	Size   int    `json:"size"`
}

func emit(v any) error { return json.NewEncoder(os.Stdout).Encode(v) }

func run() error {
	root := flag.String("root", "", "private root (required)")
	flag.Parse()
	if *root == "" || flag.NArg() != 0 {
		return errors.New("--root is required; positional arguments are forbidden")
	}
	rpc := filepath.Join(*root, "agent", "rpc")
	if err := os.MkdirAll(rpc, 0700); err != nil {
		return err
	}
	daemon := omorpctest.NewAt(rpc, filepath.Join(rpc, "rpc.sock"))
	if err := daemon.Start(); err != nil {
		return err
	}
	defer daemon.Stop()
	var assets []asset
	err := fs.WalkDir(frontend.Dist, "dist", func(name string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		bytes, err := frontend.Dist.ReadFile(name)
		if err != nil {
			return err
		}
		sum := sha256.Sum256(bytes)
		assets = append(assets, asset{Path: name[len("dist/"):], SHA256: hex.EncodeToString(sum[:]), Size: len(bytes)})
		return nil
	})
	if err != nil {
		return err
	}
	if err := emit(map[string]any{"event": "fixture-ready", "pid": os.Getpid(), "platform": runtime.GOOS, "arch": runtime.GOARCH, "assets": assets}); err != nil {
		return err
	}
	// One JSON launch record, followed only by EOF. bufio retains any read-ahead.
	input := bufio.NewReader(os.Stdin)
	line, err := input.ReadBytes('\n')
	if errors.Is(err, io.EOF) {
		return nil
	}
	if err != nil {
		return err
	}
	var launch struct {
		Command []string `json:"command"`
	}
	if err := json.Unmarshal(line, &launch); err != nil {
		return err
	}
	if len(launch.Command) == 0 {
		return errors.New("empty worker command")
	}
	cmd := exec.Command(launch.Command[0], launch.Command[1:]...)
	workerInput, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	defer workerInput.Close()
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	procexec.SetupCommand(cmd)
	tracked, err := procexec.StartTracked(cmd)
	if err != nil {
		return err
	}
	defer tracked.Close()
	joined := make(chan error, 1)
	go func() { joined <- cmd.Wait() }()
	eof := make(chan error, 1)
	go func() { _, err := io.Copy(io.Discard, input); eof <- err }()
	var waitErr error
	forced := false
	select {
	case waitErr = <-joined:
	case inputErr := <-eof:
		forced = true
		closeErr := workerInput.Close()
		select {
		case waitErr = <-joined:
		case <-time.After(25 * time.Second):
			killErr := tracked.TerminateTree()
			select {
			case waitErr = <-joined:
			case <-time.After(10 * time.Second):
				return errors.Join(killErr, errors.New("worker did not join after EOF shutdown"))
			}
			waitErr = errors.Join(waitErr, killErr, errors.New("worker required forced EOF cleanup"))
		}
		waitErr = errors.Join(waitErr, inputErr, closeErr)
	}
	// This is the production process-domain completion barrier, not a test sleep.
	drainErr := tracked.WaitTreeGone(10 * time.Second)
	if drainErr != nil {
		forced = true
		drainErr = errors.Join(drainErr, tracked.TerminateTree(), tracked.WaitTreeGone(10*time.Second))
	}
	closeErr := tracked.Close()
	daemon.Stop()
	receiptErr := emit(map[string]any{"event": "fixture-stopped", "pid": os.Getpid(), "workerPID": cmd.Process.Pid, "workerExit": cmd.ProcessState.ExitCode(), "treeGone": drainErr == nil, "forced": forced, "handshakes": daemon.Handshakes()})
	return errors.Join(waitErr, drainErr, closeErr, receiptErr)
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
