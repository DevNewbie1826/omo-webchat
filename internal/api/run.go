package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/auth"
	"github.com/DevNewbie1826/omo-webchat/internal/config"
	"github.com/DevNewbie1826/omo-webchat/internal/store"
)

// Run initializes the store, session store, and HTTP server, then serves until
// ctx is cancelled.
func Run(ctx context.Context, cfg *config.Config, logger *slog.Logger, onReady func() error) error {
	var (
		st  *store.Store
		err error
	)
	if cfg.StateDir != "" {
		st, err = store.LoadDir(cfg.StateDir, logger)
	} else {
		st, err = store.Load(ctx, logger)
	}
	if err != nil {
		return fmt.Errorf("loading store: %w", err)
	}
	sessions := auth.NewSessionStore(ctx, cfg.Password, logger)
	apiServer := New(ctx, cfg, st, sessions, logger)
	srv := &http.Server{
		Addr:              net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port)),
		Handler:           apiServer.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		<-ctx.Done()
		// Settle and close logical provider sessions before the HTTP shutdown
		// returns. CloseAll marks shared-provider termination intentional, so a
		// normal server stop never leaks a synthetic pi_eof to clients.
		apiServer.chats.CloseAll()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			logger.Error("graceful shutdown failed", "err", err)
		}
	}()

	logger.Info("listening", "addr", srv.Addr, "root", cfg.Root)
	ln, err := net.Listen("tcp", srv.Addr)
	if err != nil {
		return fmt.Errorf("http server: %w", err)
	}
	if onReady != nil {
		if err := onReady(); err != nil {
			_ = ln.Close()
			return fmt.Errorf("daemon readiness: %w", err)
		}
	}
	if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("http server: %w", err)
	}
	return nil
}
