package wsbridge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/coldhistory"
	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/wscontract"
)

func savePreviewChat(t *testing.T, h *historyBridgeHarness, count int) cursorstore.Chat {
	t.Helper()
	path, _ := writeBridgeHistory(t, count)
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	var header struct{ ID string }
	if err := json.NewDecoder(file).Decode(&header); err != nil {
		t.Fatal(err)
	}
	rec := cursorstore.Chat{
		ID: "preview-chat", WorkspaceID: h.workspace.ID, CWD: h.workspace.Path,
		SessionFile: path, DurableSessionID: header.ID,
		Name: "preview", NameSource: cursorstore.NameSourceAuto,
	}
	if err := h.store.SaveChat(rec); err != nil {
		t.Fatal(err)
	}
	if err := h.daemon.LoadSessionFile(path); err != nil {
		t.Fatal(err)
	}
	return rec
}

// Observe the actual wire without consuming/reordering matching frames.
func previewFramesThroughOutcome(t *testing.T, frames *collector, expectedError string) []map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), historyE2ETestBudget)
	defer cancel()
	var out []map[string]any
	for {
		batch, closed, _ := frames.takeDecoded(len(out))
		for _, item := range batch {
			var frame map[string]any
			if err := json.Unmarshal(item.raw, &frame); err != nil {
				t.Fatal(err)
			}
			out = append(out, frame)
			if item.typ == "error" {
				if expectedError != "" && frame["code"] == expectedError {
					return out
				}
				t.Fatalf("create error: %s", item.raw)
			}
			if item.typ == "entries" && item.final {
				if expectedError != "" {
					t.Fatalf("terminal arrived instead of %s", expectedError)
				}
				return out
			}
		}
		if closed {
			t.Fatal("socket closed before terminal")
		}
		select {
		case <-frames.notify:
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
}

func TestPreviewPrecedesBlockedEngineReadyAndTail(t *testing.T) {
	for _, count := range []int{0, 4, 75} {
		t.Run(fmt.Sprint(count), func(t *testing.T) {
			// Given a stored durable branch and an engine that cannot finish opening.
			h := newHistoryBridgeHarness(t, historyE2ETestBudget)
			rec := savePreviewChat(t, h, count)
			release := h.daemon.BlockHandler(omorpc.CmdOpenSession)
			t.Cleanup(release)
			socket, frames := connectHistoryVersion(t, h, onDemandHistoryVersion, 0)

			// When the browser opens without committed-history anchors.
			writeClient(t, socket, map[string]any{"type": "chat.create", "wsId": rec.WorkspaceID, "chatId": rec.ID})

			// Then preview is available while engine acquisition remains blocked.
			ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
			defer cancel()
			var preview map[string]any
			for preview == nil {
				batch, _, _ := frames.takeDecoded(0)
				for _, item := range batch {
					if item.typ == "ready" || item.typ == "error" {
						t.Fatalf("unexpected frame before preview: %s", item.raw)
					}
					if item.typ == "entries" {
						if err := json.Unmarshal(item.raw, &preview); err != nil {
							t.Fatal(err)
						}
						break
					}
				}
				if preview != nil {
					break
				}
				select {
				case <-frames.notify:
				case <-ctx.Done():
					t.Fatal("preview did not arrive within 3 seconds while engine was blocked")
				}
			}
			wantCount := min(count, 60)
			if preview["segment"] != "preview" || preview["final"] != false ||
				preview["sessionId"] != rec.ID || preview["historySessionId"] != rec.DurableSessionID ||
				preview["historyComplete"] != (count <= 60) {
				t.Fatalf("invalid preview: %v", preview)
			}
			ids := wirePageIDs(t, preview)
			if len(ids) != wantCount {
				t.Fatalf("preview entries = %d, want %d", len(ids), wantCount)
			}
			for i, id := range ids {
				if want := fmt.Sprintf("entry-%04d", count-wantCount+i); id != want {
					t.Fatalf("preview id = %q, want %q", id, want)
				}
			}
			if h.daemon.OpenCount() != 0 {
				t.Fatal("engine opened before its barrier was released")
			}
			release()
			expectedError := ""
			if count == 0 {
				// Existing hydration rejects a durable file without an entry
				// cursor. Preview must not suppress that authoritative error.
				expectedError = "decode_failed"
			}
			wire := previewFramesThroughOutcome(t, frames, expectedError)
			previews, ready, tail := 0, -1, -1
			for i, frame := range wire {
				switch frame["type"] {
				case "ready":
					ready = i
				case "entries":
					if frame["segment"] == "preview" {
						previews++
						if i != 0 {
							t.Fatalf("preview did not precede ready: %v", wire)
						}
					} else if frame["final"] == false {
						tail = i
					}
				}
			}
			if previews != 1 || ready <= 0 || (count > 0 && tail <= ready) {
				t.Fatalf("ordering: previews=%d ready=%d tail=%d", previews, ready, tail)
			}
		})
	}
}

func TestPreviewUsesActiveBranch(t *testing.T) {
	// Given an abandoned leaf followed by a fork from an earlier entry.
	h := newHistoryBridgeHarness(t, historyE2ETestBudget)
	rec := savePreviewChat(t, h, 4)
	file, err := os.OpenFile(rec.SessionFile, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	_, err = file.WriteString("{\"type\":\"message\",\"id\":\"branch-tip\",\"parentId\":\"entry-0001\",\"message\":{\"role\":\"user\",\"content\":\"fork\"}}\n")
	file.Close()
	if err != nil {
		t.Fatal(err)
	}
	if err := h.daemon.LoadSessionFile(rec.SessionFile); err != nil {
		t.Fatal(err)
	}
	socket, frames := connectHistoryVersion(t, h, onDemandHistoryVersion, 0)
	// When opening the chat.
	writeClient(t, socket, wscontract.ChatCreateFrame{Type: "chat.create", WsID: rec.WorkspaceID, ChatID: rec.ID})
	wire := previewFramesThroughOutcome(t, frames, "")
	// Then the preview excludes the abandoned file-order tail.
	if wire[0]["segment"] != "preview" {
		t.Fatalf("first frame is not preview: %v", wire[0])
	}
	if got, want := wirePageIDs(t, wire[0]), []string{"entry-0000", "entry-0001", "branch-tip"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("active branch = %v, want %v", got, want)
	}
}

func TestPreviewEligibilityOnCreate(t *testing.T) {
	for _, tc := range []struct {
		name    string
		version int
		resume  *wscontract.HistoryResumeCursor
		want    bool
	}{
		{name: "v2", version: 2},
		{name: "v3", version: 3},
		{name: "v4 resume", version: 4, resume: &wscontract.HistoryResumeCursor{FirstEntryID: "entry-0000", LastEntryID: "entry-0003"}},
		{name: "v4 empty anchors", version: 4, resume: &wscontract.HistoryResumeCursor{}, want: true},
		{name: "v4 missing first anchor", version: 4, resume: &wscontract.HistoryResumeCursor{LastEntryID: "entry-0003"}, want: true},
		{name: "v4 missing last anchor", version: 4, resume: &wscontract.HistoryResumeCursor{FirstEntryID: "entry-0000"}, want: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// Given a versioned client, optionally with resume coverage.
			h := newHistoryBridgeHarness(t, historyE2ETestBudget)
			rec := savePreviewChat(t, h, 4)
			if tc.resume != nil {
				tc.resume.SessionID = rec.DurableSessionID
			}
			socket, frames := connectHistoryVersion(t, h, tc.version, 0)
			// When opening via the real socket.
			writeClient(t, socket, wscontract.ChatCreateFrame{
				Type: "chat.create", WsID: rec.WorkspaceID, ChatID: rec.ID, Resume: tc.resume,
			})
			wire := previewFramesThroughOutcome(t, frames, "")
			// Then only an eligible client receives the provisional frame.
			count := 0
			for _, frame := range wire {
				if frame["segment"] == "preview" {
					count++
				}
			}
			if (count == 1) != tc.want || count > 1 {
				t.Fatalf("preview count=%d, want preview=%v", count, tc.want)
			}
		})
	}
}

func TestPreviewReadFailureWritesNothing(t *testing.T) {
	for _, failure := range []string{"missing file", "header mismatch", "missing durable identity", "corrupt branch", "expired context"} {
		t.Run(failure, func(t *testing.T) {
			// Given a real file but no socket: any attempted write is a failure.
			path, _ := writeBridgeHistory(t, 4)
			file, err := os.Open(path)
			if err != nil {
				t.Fatal(err)
			}
			var header struct{ ID string }
			err = json.NewDecoder(file).Decode(&header)
			file.Close()
			if err != nil {
				t.Fatal(err)
			}
			rec := cursorstore.Chat{ID: "preview", SessionFile: path, DurableSessionID: header.ID}
			ctx := t.Context()
			switch failure {
			case "missing file":
				rec.SessionFile = filepath.Join(t.TempDir(), "missing.jsonl")
			case "header mismatch":
				rec.DurableSessionID = "wrong-session"
			case "missing durable identity":
				rec.DurableSessionID = ""
			case "corrupt branch":
				file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
				if err != nil {
					t.Fatal(err)
				}
				_, err = file.WriteString("{\"type\":\"message\",\"id\":\"broken\",\"parentId\":\"missing\"}\n")
				file.Close()
				if err != nil {
					t.Fatal(err)
				}
			case "expired context":
				var cancel context.CancelFunc
				ctx, cancel = context.WithDeadline(ctx, time.Unix(0, 0))
				defer cancel()
			}
			c := &connection{helloVersion: 4}
			sub := newSubscriber(c)
			c.sub = sub
			// When preview is attempted, then no frame reaches the missing socket.
			c.previewHistory(ctx, &wscontract.ChatCreateFrame{}, rec, sub)
		})
	}
}

func TestPreviewTimeoutWritesNothing(t *testing.T) {
	// Given a disk read held until its bounded context expires.
	original := streamPreviewHistory
	t.Cleanup(func() { streamPreviewHistory = original })
	streamPreviewHistory = func(ctx context.Context, _ string, _ coldhistory.Options, _, _ int, _ func(coldhistory.Metadata, coldhistory.Page) error) (coldhistory.Metadata, error) {
		<-ctx.Done()
		return coldhistory.Metadata{}, ctx.Err()
	}
	synctest.Test(t, func(t *testing.T) {
		c := &connection{helloVersion: 4}
		sub := newSubscriber(c)
		c.sub = sub
		start := time.Now()
		// When preview times out, then it writes nothing and returns at 750 ms.
		c.previewHistory(t.Context(), &wscontract.ChatCreateFrame{},
			cursorstore.Chat{ID: "preview", SessionFile: "blocked", DurableSessionID: "durable"}, sub)
		if elapsed := time.Since(start); elapsed != 750*time.Millisecond {
			t.Fatalf("preview timeout = %v, want 750ms", elapsed)
		}
	})
}

func TestPreviewNeverPublishesPartialRead(t *testing.T) {
	// Given a page followed by a read failure.
	original := streamPreviewHistory
	t.Cleanup(func() { streamPreviewHistory = original })
	streamPreviewHistory = func(_ context.Context, _ string, _ coldhistory.Options, _, _ int, emit func(coldhistory.Metadata, coldhistory.Page) error) (coldhistory.Metadata, error) {
		meta := coldhistory.Metadata{Header: coldhistory.Header{ID: "durable"}}
		if err := emit(meta, coldhistory.Page{Entries: []json.RawMessage{json.RawMessage(`{"id":"first"}`)}}); err != nil {
			return meta, err
		}
		return meta, errors.New("late read failure")
	}
	c := &connection{helloVersion: 4}
	sub := newSubscriber(c)
	c.sub = sub
	// When the read fails after a page, then no partial preview reaches the socket.
	c.previewHistory(t.Context(), &wscontract.ChatCreateFrame{},
		cursorstore.Chat{ID: "preview", SessionFile: "partial", DurableSessionID: "durable"}, sub)
}

func TestPreviewDiscardedAfterSupersedingCreateOrUnbind(t *testing.T) {
	for _, action := range []string{"create", "unbind"} {
		t.Run(action, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				// Given an old create whose disk read is paused after returning its tail.
				original := streamPreviewHistory
				t.Cleanup(func() { streamPreviewHistory = original })
				entered, release := make(chan struct{}), make(chan struct{})
				var once sync.Once
				unblock := func() { once.Do(func() { close(release) }) }
				t.Cleanup(unblock)
				streamPreviewHistory = func(ctx context.Context, path string, opts coldhistory.Options, tail, warm int, emit func(coldhistory.Metadata, coldhistory.Page) error) (coldhistory.Metadata, error) {
					meta := coldhistory.Metadata{Header: coldhistory.Header{ID: "durable"}}
					err := emit(meta, coldhistory.Page{Entries: []json.RawMessage{json.RawMessage(`{"id":"old"}`)}})
					close(entered)
					select {
					case <-release:
					case <-ctx.Done():
					}
					return meta, err
				}
				rec := cursorstore.Chat{ID: "preview", WorkspaceID: "workspace", SessionFile: "blocked", DurableSessionID: "durable"}
				h := &Handler{cfg: Config{HistoryTimeout: time.Minute, Logger: slog.Default()}}
				c := &connection{bridge: h, helloVersion: 4, ctx: t.Context()}
				sub := newSubscriber(c)
				c.sub = sub
				start := time.Now()
				done := make(chan struct{})
				go func() {
					defer close(done)
					c.previewHistory(t.Context(), &wscontract.ChatCreateFrame{}, rec, sub)
				}()
				select {
				case <-entered:
				case <-time.After(historyE2ETestBudget):
					t.Fatal("preview read never reached barrier")
				}
				// When a newer create or unbind advances this socket's generation.
				if action == "create" {
					// Stop the newer create after it installs its subscriber, before
					// engine acquisition; no socket is needed for the stale-write check.
					h.cfg.PrepareChat = func(context.Context, string, string) error {
						unblock()
						<-done
						c.closed.Store(true)
						return errors.New("stop replacement after superseding")
					}
					c.create(t.Context(), &wscontract.ChatCreateFrame{WsID: rec.WorkspaceID, ChatID: rec.ID})
				} else {
					c.unbind()
					unblock()
					select {
					case <-done:
					case <-time.After(historyE2ETestBudget):
						t.Fatal("stale preview did not return")
					}
				}
				// Then no stale preview was written to the absent socket.
				if time.Since(start) != 0 {
					t.Fatal("preview was discarded by timeout rather than the superseding binding")
				}
			})
		})
	}
}
