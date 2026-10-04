//go:build darwin || linux

package rpcwatch_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/rpcwatch"
)

func TestWatcherUnixSocket(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "rpc.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	serverDone := make(chan error, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			serverDone <- err
			return
		}
		defer conn.Close()
		decoder, encoder := json.NewDecoder(conn), json.NewEncoder(conn)
		for {
			var req struct {
				ID        string `json:"id"`
				Type      string `json:"type"`
				SessionID string `json:"sessionId"`
			}
			if err := decoder.Decode(&req); err != nil {
				if errors.Is(err, io.EOF) {
					err = nil
				}
				serverDone <- err
				return
			}
			data := `{}`
			switch req.Type {
			case "get_protocol_info", "set_client_info":
			case "list_sessions":
				data = oneSession
			case "get_state":
				if req.SessionID != "rpc-5" {
					serverDone <- errors.New("wrong route")
					return
				}
				data = blocked
			default:
				serverDone <- errors.New("watcher mutated daemon: " + req.Type)
				return
			}
			resp := map[string]any{"type": "response", "id": req.ID, "command": req.Type, "success": true, "data": json.RawMessage(data)}
			if err := encoder.Encode(resp); err != nil {
				serverDone <- err
				return
			}
		}
	}()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	client, err := omorpc.Dial(ctx, socket)
	if err != nil {
		t.Fatal(err)
	}
	w := rpcwatch.New(client)
	w.Tick(ctx)
	s, ok := w.Lookup("rpc-5")
	closeErr := client.Close()
	select {
	case err := <-serverDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("socket peer did not terminate")
	}
	if closeErr != nil {
		t.Fatal(closeErr)
	}
	if !ok || s.Status != "blocked" || !reflect.DeepEqual(s.Questions, []string{"Continue?"}) {
		t.Fatalf("real NDJSON snapshot = %+v, found=%v", s, ok)
	}
	t.Logf("NDJSON PASS: rpc-5 blocked questions=%q; client/peer closed, temporary socket removed by TempDir cleanup", s.Questions)
}
