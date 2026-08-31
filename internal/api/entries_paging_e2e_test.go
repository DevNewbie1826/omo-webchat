package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/lxzan/gws"

	"github.com/DevNewbie1826/omo-webchat/internal/auth"
	"github.com/DevNewbie1826/omo-webchat/internal/config"
	"github.com/DevNewbie1826/omo-webchat/internal/store"
)

func TestWebSocketEntriesPagedDelivery(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skipf("node not in PATH: %v", err)
	}
	const historyPairs = 300
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	t.Setenv("CHAT_PI_BINARY", "node")
	t.Setenv("CHAT_PI_ARGS", mockPiPath(t))
	t.Setenv("MOCK_PI_HISTORY_SIZE", "300")

	ctx := context.Background()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	st, err := store.Load(ctx, logger)
	if err != nil {
		t.Fatalf("load store: %v", err)
	}
	workspace, err := st.CreateWorkspace("paging-demo", tmp)
	if err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	chat, err := st.NewChat(workspace.ID, "paging", workspace.Path, "", "omo")
	if err != nil {
		t.Fatalf("create chat: %v", err)
	}
	sessions := auth.NewSessionStore(ctx, "pw", logger)
	apiServer := New(ctx, &config.Config{Root: tmp, Provider: "omo"}, st, sessions, logger)
	server := httptest.NewServer(http.HandlerFunc(apiServer.handleWS))
	defer server.Close()
	defer server.CloseClientConnections()

	collector := &frameCollector{notify: make(chan struct{}, 512)}
	client, _, err := gws.NewClient(collector, &gws.ClientOption{Addr: "ws" + strings.TrimPrefix(server.URL, "http")})
	if err != nil {
		t.Fatalf("connect ws: %v", err)
	}
	t.Cleanup(func() { _ = client.WriteClose(1000, nil) })
	go client.ReadLoop()

	writeFrame(t, client, map[string]any{"type": "chat.create", "wsId": workspace.ID, "chatId": chat.ID})
	collector.waitFor(t, "ready", 3*time.Second)

	deadline := time.After(6 * time.Second)
	var entriesFrames [][]byte
	for {
		entriesFrames = nil
		sawFinal := false
		for _, b := range collector.snapshot() {
			var env struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(b, &env) != nil || env.Type != "entries" {
				continue
			}
			entriesFrames = append(entriesFrames, b)
			var ef struct {
				Final bool `json:"final"`
			}
			if json.Unmarshal(b, &ef) == nil && ef.Final {
				sawFinal = true
			}
		}
		if sawFinal {
			break
		}
		select {
		case <-collector.notify:
		case <-deadline:
			t.Fatalf("timed out waiting for final entries page; got %d entries frames: %s", len(entriesFrames), collector.types())
		}
	}

	if len(entriesFrames) < 2 {
		t.Fatalf("entries frames = %d, want >= 2 (history must be paged)", len(entriesFrames))
	}
	totalEntries := 0
	finalCount := 0
	leafCount := 0
	for _, b := range entriesFrames {
		var ef struct {
			Entries []json.RawMessage `json:"entries"`
			Final   bool              `json:"final"`
			LeafID  string            `json:"leafId"`
		}
		if json.Unmarshal(b, &ef) != nil {
			t.Fatalf("failed to unmarshal entries page")
		}
		if len(ef.Entries) > 100 {
			t.Fatalf("page has %d entries, want <= 100", len(ef.Entries))
		}
		totalEntries += len(ef.Entries)
		if ef.Final {
			finalCount++
		}
		if ef.LeafID != "" {
			leafCount++
		}
	}
	if finalCount != 1 {
		t.Fatalf("final pages = %d, want exactly 1", finalCount)
	}
	if leafCount != 1 {
		t.Fatalf("pages carrying leafId = %d, want exactly 1 (final only)", leafCount)
	}
	wantEntries := historyPairs * 2
	if totalEntries != wantEntries {
		t.Fatalf("reconstructed entry count = %d, want %d", totalEntries, wantEntries)
	}
	if collector.hasType("error") {
		t.Fatalf("unexpected error frame during paged delivery: %s", collector.types())
	}
}
