// Command windowsprobe exercises the production daemon lifecycle with real omo.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func main() {
	expectFailure := flag.Bool("expect-startup-failure", false, "capture the pre-fix production startup failure")
	flag.Parse()
	if err := runProbe(*expectFailure); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func runProbe(expectFailure bool) (resultErr error) {
	dir, err := os.MkdirTemp("", "wp")
	if err != nil {
		return err
	}
	defer func() {
		err := os.RemoveAll(dir)
		fmt.Printf("cleanup: profile=%s error=%v\n", dir, err)
		resultErr = errors.Join(resultErr, err)
	}()
	home := filepath.Join(dir, "h")
	agent := filepath.Join(home, ".omo", "agent")
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	cfg := omorpc.EnsureConfig{
		AgentDir: agent, StateDir: filepath.Join(dir, "state"), WorkingDir: dir,
		Env: isolatedEnv(home, agent), ReadyTimeout: 35 * time.Second,
	}
	daemon, err := omorpc.EnsureDaemon(ctx, cfg)
	if err != nil {
		if expectFailure {
			fmt.Printf("WINDOWS_PRODUCTION_RED: EnsureDaemon failed: %v\n", err)
			return nil
		}
		return fmt.Errorf("production EnsureDaemon: %w", err)
	}
	defer func() {
		err := daemon.StopBounded(10 * time.Second)
		fmt.Printf("cleanup: daemon owned=%t error=%v\n", daemon.Owned, err)
		resultErr = errors.Join(resultErr, err)
	}()
	if expectFailure {
		return errors.New("production startup unexpectedly passed; RED not reproduced")
	}
	if !daemon.Owned {
		return errors.New("fresh isolated daemon was not owned")
	}
	fmt.Printf("production: fresh owned=%t protocol=%d serverVersion=%s\n", daemon.Owned, daemon.ProtocolInfo.ProtocolVersion, daemon.ProtocolInfo.ServerVersion)
	resp, err := daemon.Client.Call(ctx, omorpc.OpenSession{CWD: dir})
	if err != nil {
		return fmt.Errorf("open_session: %w", err)
	}
	var opened omorpc.OpenSessionData
	if err := json.Unmarshal(resp.Data, &opened); err != nil {
		return err
	}
	if !resp.Success || opened.SessionID == "" {
		return errors.New("open_session returned no successful session identity")
	}
	if _, err := daemon.Client.Call(ctx, omorpc.CloseSession{SessionID: opened.SessionID}); err != nil {
		return fmt.Errorf("close_session: %w", err)
	}
	fmt.Println("production: session open/close passed")
	shared, err := omorpc.EnsureDaemon(ctx, cfg)
	if err != nil {
		return fmt.Errorf("reuse: %w", err)
	}
	if shared.Owned {
		return errors.Join(errors.New("reuse claimed shared ownership"), shared.StopBounded(10*time.Second))
	}
	if err := shared.StopBounded(10 * time.Second); err != nil {
		return err
	}
	if _, err := daemon.Client.Call(ctx, omorpc.GetProtocolInfo{}); err != nil {
		return fmt.Errorf("owned daemon after shared Stop: %w", err)
	}
	fmt.Println("production: reuse unowned; shared Stop preserved daemon")
	return nil
}
