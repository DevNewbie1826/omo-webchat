// Command todofixture serves the actual embedded App/API/Go WebSocket bridge
// against an owned temporary observed-contract provider. Never uses EnsureDaemon.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/api"
	"github.com/DevNewbie1826/omo-webchat/internal/auth"
	"github.com/DevNewbie1826/omo-webchat/internal/config"
	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
	"github.com/DevNewbie1826/omo-webchat/internal/wsbridge"
)

func serve(ctx context.Context) (failure error) {
	root, err := os.MkdirTemp("", "cli-webchat-todo-provider-")
	if err != nil {
		return err
	}
	defer func() { failure = errors.Join(failure, os.RemoveAll(root)) }()
	j, err := newJournal(root)
	if err != nil {
		return err
	}
	d := omorpctest.New(root)
	if err := d.LoadSessionFile(j.path); err != nil {
		return err
	}
	if err := d.Start(); err != nil {
		return err
	}
	defer d.Stop()
	proxy, err := startProvider(filepath.Join(root, "provider.sock"), d, j)
	if err != nil {
		return err
	}
	defer func() { failure = errors.Join(failure, proxy.close()) }()
	client, err := omorpc.Dial(ctx, filepath.Join(root, "provider.sock"))
	if err != nil {
		return err
	}
	defer func() { failure = errors.Join(failure, client.Close()) }()
	store, err := cursorstore.Open(filepath.Join(root, "state-v2.json"))
	if err != nil {
		return err
	}
	if err := store.SaveWorkspace(cursorstore.Workspace{ID: workspaceID, Name: "Todo authority QA", Path: root}); err != nil {
		return err
	}
	if err := store.SaveChat(cursorstore.Chat{ID: chatID, WorkspaceID: workspaceID, CWD: root, SessionFile: j.path, DurableSessionID: durableID, SessionProvenance: cursorstore.SessionProvenanceNative, Name: "전체 작업 목록 검증", NameSource: cursorstore.NameSourceUser}); err != nil {
		return err
	}
	if err := store.SetLayout(json.RawMessage(`{"kind":"leaf","id":"todo-pane","sessionId":"todo-qa-chat"}`)); err != nil {
		return err
	}
	manager := session.NewManager(session.Config{Client: client, Store: (*wsbridge.CursorStore)(store)})
	defer func() {
		j.releaseAll()
		closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		failure = errors.Join(failure, manager.CloseAll(closeCtx))
	}()
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	bridge := wsbridge.New(wsbridge.Config{Context: ctx, Manager: manager, Store: store, Logger: logger, ServerVersion: client.ServerVersion()})
	defer bridge.CloseConnections()
	sessions := auth.NewSessionStore(ctx, "todo-qa-password", logger)
	app := api.New(ctx, &config.Config{Root: root, StateDir: root, Password: "todo-qa-password", Provider: "omo"}, store, sessions, manager, bridge, logger)
	appListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	defer appListener.Close()
	controlListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	defer controlListener.Close()
	appServer := &http.Server{Handler: app.Handler(), ReadHeaderTimeout: 5 * time.Second}
	controlServer := &http.Server{Handler: (&controls{j, proxy, d}).handler(), ReadHeaderTimeout: 5 * time.Second}
	exited := make(chan error, 2)
	go func() { exited <- appServer.Serve(appListener) }()
	go func() { exited <- controlServer.Serve(controlListener) }()
	defer func() { j.releaseAll(); failure = errors.Join(failure, appServer.Close(), controlServer.Close()) }()
	if err := json.NewEncoder(os.Stdout).Encode(map[string]any{"type": "todo-fixture-ready", "url": "http://" + appListener.Addr().String(), "controlURL": "http://" + controlListener.Addr().String(), "root": root, "chatId": chatID, "wsId": workspaceID, "durableSessionId": durableID}); err != nil {
		return err
	}
	select {
	case <-ctx.Done():
		return nil
	case err := <-exited:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}
func main() {
	flag.Parse()
	if flag.NArg() != 0 {
		fmt.Fprintln(os.Stderr, "todofixture takes no arguments; all data is disposable")
		os.Exit(2)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := serve(ctx); err != nil {
		slog.Error("todo fixture failed", "error", err)
		os.Exit(1)
	}
}
