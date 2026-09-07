//go:build ignore

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
)

func TestRPC46QAControlsCarryRealSocketEventsAndHolds(t *testing.T) {
	// Given: an isolated Unix daemon and the exact HTTP handler shipped by QA.
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("source path unavailable")
	}
	base := filepath.Join(filepath.Dir(source), "../../.omo/rpc46-qa/r1")
	if err := os.MkdirAll(base, 0700); err != nil {
		t.Fatal(err)
	}
	root, err := os.MkdirTemp(base, "t")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(root); err != nil {
			t.Error(err)
		}
	})
	d := omorpctest.NewAt(root, filepath.Join(root, "d.sock"))
	if err := d.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(d.Stop)
	c := &controls{daemon: d, root: root, releases: make(map[string]func())}
	t.Cleanup(c.releaseAll)
	server := httptest.NewServer(c.handler())
	t.Cleanup(server.Close)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	client, err := omorpc.Dial(ctx, d.SocketPath())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := client.Close(); err != nil {
			t.Error(err)
		}
	})
	call := func(cmd omorpc.Command) *omorpc.Response {
		t.Helper()
		response, err := client.Call(ctx, cmd)
		if err != nil {
			t.Fatal(err)
		}
		if !response.Success {
			t.Fatal(response.Error)
		}
		return response
	}
	var opened omorpc.OpenSessionData
	if err := json.Unmarshal(call(omorpc.OpenSession{CWD: root}).Data, &opened); err != nil {
		t.Fatal(err)
	}
	path, sid := opened.State.SessionFile, opened.SessionID
	post := func(route string, request controlRequest) {
		t.Helper()
		body, err := json.Marshal(request)
		if err != nil {
			t.Fatal(err)
		}
		req, err := http.NewRequestWithContext(ctx, "POST", server.URL+route, bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		response, err := server.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer func() {
			if err := response.Body.Close(); err != nil {
				t.Error(err)
			}
		}()
		if response.StatusCode != 200 {
			t.Fatalf("%s status=%d", route, response.StatusCode)
		}
	}
	next := func(kind string) *omorpc.Event {
		t.Helper()
		select {
		case event := <-client.Events():
			if event == nil || event.Type != kind || event.SessionID != sid {
				t.Fatalf("event=%+v want %s", event, kind)
			}
			return event
		case <-ctx.Done():
			t.Fatal(ctx.Err())
			return nil
		}
	}
	// When: seed the transcript and emit the precise recovery contract over RPC.
	post("/history", controlRequest{Path: path, Count: 240})
	if got := d.SessionSnapshots()[0].EntryCount; got != 240 {
		t.Fatalf("history=%d", got)
	}
	// B must not remain header-only, and its content must be distinguishable
	// from A even though both sessions use entry-1/entry-2 IDs.
	var sibling omorpc.OpenSessionData
	if err := json.Unmarshal(call(omorpc.OpenSession{CWD: root}).Data, &sibling); err != nil {
		t.Fatal(err)
	}
	bpath, bsid := sibling.State.SessionFile, sibling.SessionID
	post("/history", controlRequest{Path: bpath, Count: 2, Prefix: "rpc46-sibling-selfcheck"})
	wantEntries := []map[string]any{
		{"id": "entry-1", "parentId": nil, "type": "message", "message": map[string]any{"role": "user", "content": "rpc46-sibling-selfcheck-001"}},
		{"id": "entry-2", "parentId": "entry-1", "type": "message", "message": map[string]any{"role": "assistant", "content": "rpc46-sibling-selfcheck-002"}},
	}
	var siblingBaseline *omorpctest.SessionSnapshot
	verifySibling := func(stage string) {
		t.Helper()
		var got struct {
			Entries []map[string]any `json:"entries"`
			LeafID  string           `json:"leafId"`
		}
		if err := json.Unmarshal(call(omorpc.GetEntries{SessionID: bsid}).Data, &got); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(got.Entries, wantEntries) || got.LeafID != "entry-2" {
			t.Fatalf("%s B RPC history=%+v", stage, got)
		}
		raw, err := os.ReadFile(bpath)
		if err != nil {
			t.Fatal(err)
		}
		lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
		if len(lines) != 3 {
			t.Fatalf("%s B JSONL lines=%d, want header + two entries", stage, len(lines))
		}
		for i, line := range lines[1:] {
			var entry map[string]any
			if err := json.Unmarshal([]byte(line), &entry); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(entry, wantEntries[i]) {
				t.Fatalf("%s B disk entry=%+v", stage, entry)
			}
		}
		var current *omorpctest.SessionSnapshot
		for _, value := range d.SessionSnapshots() {
			if value.Path == bpath {
				current = &value
			}
		}
		if current == nil || !current.Live || current.EntryCount != 2 || current.LeafID != "entry-2" || len(current.Prompts) != 0 {
			t.Fatalf("%s B snapshot=%+v", stage, current)
		}
		if siblingBaseline == nil {
			siblingBaseline = current
		} else if !reflect.DeepEqual(current, siblingBaseline) {
			t.Fatalf("%s B owner changed: %+v != %+v", stage, current, siblingBaseline)
		}
	}
	verifySibling("before A recovery")
	post("/configure", controlRequest{Path: path})
	post("/events", controlRequest{Path: path, Events: []map[string]any{
		{"type": "agent_start"},
		{"type": "compaction_start", "reason": "overflow", "requestId": "auto-1"},
		{"type": "compaction_end", "reason": "overflow", "requestId": "auto-1", "willRetry": true},
		{"type": "compaction_end", "reason": "overflow", "willRetry": false, "errorMessage": "QA_OVERFLOW_RECOVERY_EXHAUSTED"},
		{"type": "state_changed", "qaBarrier": "selfcheck"},
	}})
	// Then: the actual socket transports the diagnostic and ordering unchanged.
	next("agent_start")
	next("compaction_start")
	next("compaction_end")
	terminal := next("compaction_end")
	if !strings.Contains(string(terminal.Raw), "QA_OVERFLOW_RECOVERY_EXHAUSTED") {
		t.Fatal(string(terminal.Raw))
	}
	next("state_changed")
	verifySibling("after A recovery")
	post("/events", controlRequest{Path: path, Events: []map[string]any{
		{"type": "compaction_end", "reason": "overflow", "willRetry": false, "errorMessage": "QA_OVERFLOW_RECOVERY_EXHAUSTED"},
		{"type": "agent_settled", "reason": "end_turn"},
		{"type": "state_changed", "qaBarrier": "sibling-settled"},
	}})
	next("compaction_end")
	next("agent_settled")
	next("state_changed")
	verifySibling("after A replay and settlement")
	post("/hold-compact", controlRequest{Path: path})
	completed := make(chan error, 1)
	go func() { _, err := client.Call(ctx, omorpc.Compact{SessionID: sid}); completed <- err }()
	post("/await-request", controlRequest{Path: path, Command: "compact", Count: 1})
	select {
	case err := <-completed:
		t.Fatalf("compact escaped its hold: %v", err)
	default:
	}
	post("/release", controlRequest{Path: path, Command: "compact"})
	select {
	case err := <-completed:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	call(omorpc.Prompt{SessionID: sid, Message: "selfcheck-head"})
	post("/await-request", controlRequest{Path: path, Command: "prompt", Count: 1})
	select {
	case event := <-client.Events():
		t.Fatalf("prompt escaped its hold: %+v", event)
	default:
	}
	post("/release", controlRequest{Path: path, Command: "prompt"})
	next("agent_start")
	post("/silent", controlRequest{Path: path})
	post("/fail-open", controlRequest{Path: path, Error: omorpc.ErrCodeSessionPathInUse, Attempts: 1})
	_, err = client.Call(ctx, omorpc.OpenSession{SessionPath: path})
	var stable *omorpc.StableError
	if !errors.As(err, &stable) || stable.Code != omorpc.ErrCodeSessionPathInUse {
		t.Fatalf("failure=%v", err)
	}
	call(omorpc.OpenSession{SessionPath: path})
	verifySibling("after A reopen")
}
