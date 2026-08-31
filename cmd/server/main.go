package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/DevNewbie1826/omo-webchat/internal/api"
	"github.com/DevNewbie1826/omo-webchat/internal/config"
	"github.com/DevNewbie1826/omo-webchat/internal/daemon"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	cfg, err := config.Load(ctx, os.Args[1:])
	if errors.Is(err, flag.ErrHelp) {
		return
	}
	if err != nil {
		logger.Error("configuration error", "err", err)
		os.Exit(1)
	}
	if cfg.Stop {
		pid, err := daemon.Stop(cfg.StateDir)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Printf("omo-webchat stopped (pid %d)\n", pid)
		return
	}
	if cfg.Status {
		pid, err := daemon.Status(cfg.StateDir)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		if pid == 0 {
			fmt.Println("omo-webchat is running (pid unknown)")
			return
		}
		fmt.Printf("omo-webchat is running (pid %d)\n", pid)
		return
	}
	if cfg.DaemonChild {
		child, err := daemon.PrepareChild(cfg.StateDir)
		if err != nil {
			logger.Error("preparing daemon child", "err", err)
			os.Exit(1)
		}
		runErr := api.Run(ctx, cfg, logger, child.Ready)
		if err := daemon.RemoveChildPIDFile(cfg.StateDir); err != nil {
			logger.Warn("removing daemon pid file", "err", err)
		}
		if err := child.Close(); err != nil {
			logger.Warn("closing daemon lock file", "err", err)
		}
		if runErr != nil {
			logger.Error("server exited with error", "err", runErr)
			os.Exit(1)
		}
		return
	}
	if cfg.Daemon {
		pid, addr, err := daemon.Start(cfg, os.Args[1:])
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Printf("omo-webchat started (pid %d, http://%s)\n", pid, addr)
		return
	}
	if err := api.Run(ctx, cfg, logger, nil); err != nil {
		logger.Error("server exited with error", "err", err)
		os.Exit(1)
	}
}
