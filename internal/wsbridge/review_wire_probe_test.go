package wsbridge

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestReviewNoCursorWire(t *testing.T) {
	for _, version := range []int{2, 3} {
		t.Run(fmt.Sprint(version), func(t *testing.T) {
			h := newHistoryBridgeHarness(t, historyE2ETestBudget)
			path := filepath.Join(t.TempDir(), "review.jsonl")
			body := "{\"type\":\"session\",\"version\":3,\"id\":\"review-durable\",\"cwd\":\"/tmp\"}\n"
			for i := 0; i < 300; i++ {
				var parent any
				if i > 0 {
					parent = fmt.Sprintf("e-%03d", i-1)
				}
				raw, err := json.Marshal(map[string]any{"type": "message", "id": fmt.Sprintf("e-%03d", i), "parentId": parent, "message": map[string]any{"role": "user", "content": "fixture"}})
				if err != nil {
					t.Fatal(err)
				}
				body += string(raw) + "\n"
			}
			if err := os.WriteFile(path, []byte(body), 0600); err != nil {
				t.Fatal(err)
			}
			if err := h.daemon.LoadSessionFile(path); err != nil {
				t.Fatal(err)
			}
			h.saveChat(t, "review-chat", path)
			conn, frames := connectHistoryVersion(t, h, version, 0)
			writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": h.workspace.ID, "chatId": "review-chat"})
			deadline := time.Now().Add(historyE2ETestBudget)
			scanned := 0
			var wire bytes.Buffer
			complete := false
			for !complete {
				batch, closed, signal := frames.takeDecoded(scanned)
				scanned += len(batch)
				for _, f := range batch {
					if f.typ == "error" {
						t.Fatalf("wire error: %s", f.raw)
					}
					if f.typ != "entries" {
						continue
					}
					wire.Write(f.raw)
					wire.WriteByte('\n')
					var data map[string]any
					if err := json.Unmarshal(f.raw, &data); err != nil {
						t.Fatal(err)
					}
					if version == 2 && f.final || version == 3 && data["historyComplete"] == true {
						complete = true
					}
				}
				if complete {
					break
				}
				if closed {
					t.Fatal("closed")
				}
				if err := frames.waitAfter(signal, time.Until(deadline)); err != nil {
					t.Fatal(err)
				}
			}
			out := os.Getenv("REVIEW_WIRE_DIR")
			if out != "" {
				if err := os.WriteFile(filepath.Join(out, fmt.Sprintf("wire-v%d.jsonl", version)), wire.Bytes(), 0600); err != nil {
					t.Fatal(err)
				}
			}
			baseline, err := os.ReadFile(filepath.Join("testdata", "resume-wire", fmt.Sprintf("wire-v%d.jsonl", version)))
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(baseline, wire.Bytes()) {
				t.Fatalf("v%d no-cursor wire changed: baseline=%d actual=%d bytes", version, len(baseline), wire.Len())
			}
		})
	}
}
