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

	"github.com/DevNewbie1826/omo-webchat/test/windowsprobe/profile"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func main() {
	binary := flag.String("omo", "omo", "pinned omo launcher path")
	server := flag.String("server", "", "built server binary for real HTTP startup under node and bun")
	flag.Parse()
	if err := runProbe(*binary); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if *server != "" {
		for _, runtimeName := range []string{"node", "bun"} {
			if err := runServerProbe(*server, runtimeName); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
		}
	}
}

func runProbe(binary string) (resultErr error) {
	dir, err := os.MkdirTemp("", "wp")
	if err != nil {
		return err
	}
	defer func() {
		err := profile.RemoveAll(dir)
		fmt.Printf("cleanup: profile=%s error=%v\n", dir, err)
		resultErr = errors.Join(resultErr, err)
	}()
	home := filepath.Join(dir, "h")
	agent := filepath.Join(home, ".omo", "agent")
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	cfg := omorpc.EnsureConfig{
		BinaryPath: binary, AgentDir: agent, StateDir: filepath.Join(dir, "state"), WorkingDir: dir,
		Env: isolatedEnv(home, agent), ReadyTimeout: 35 * time.Second,
	}
	daemon, err := omorpc.EnsureDaemon(ctx, cfg)
	if err != nil {
		return fmt.Errorf("production EnsureDaemon: %w", err)
	}
	defer func() {
		err := daemon.StopBounded(10 * time.Second)
		fmt.Printf("cleanup: daemon owned=%t error=%v\n", daemon.Owned, err)
		resultErr = errors.Join(resultErr, err)
	}()
	if !daemon.Owned {
		return errors.New("fresh isolated daemon was not owned")
	}
	if daemon.ProtocolInfo.ServerVersion != "2026.9.5" {
		return fmt.Errorf("unexpected runtime version %q, want 2026.9.5", daemon.ProtocolInfo.ServerVersion)
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
