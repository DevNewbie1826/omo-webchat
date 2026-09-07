package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
)

func testCustom(name string) map[string]any {
	return map[string]any{"type": "custom", "customType": "senpi.todo-state", "data": map[string]any{"schema": "v2", "phases": []any{map[string]any{"name": name, "tasks": []any{}}}}}
}
func TestTodoFixtureResidentDiskLagAndBranch(t *testing.T) {
	j, err := newJournal(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(j.path)
	if err != nil {
		t.Fatal(err)
	}
	anchor := j.leaf
	live, err := j.append(testCustom("resident"), "", false)
	if err != nil {
		t.Fatal(err)
	}
	disk, err := os.ReadFile(j.path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(disk), live) {
		t.Fatal("resident-only source leaked to disk")
	}
	selected, err := j.append(testCustom("selected"), anchor, true)
	if err != nil {
		t.Fatal(err)
	}
	after, err := os.Stat(j.path)
	if err != nil {
		t.Fatal(err)
	}
	if !os.SameFile(before, after) {
		t.Fatal("normal persistence replaced the session identity")
	}
	response, _ := j.response(map[string]any{"id": "r", "sessionId": "rpc-1", "since": live})
	body := response["data"].(map[string]any)
	if body["leafId"] != selected {
		t.Fatalf("selected leaf=%v", body)
	}
	rows := body["entries"].([]any)
	if len(rows) != 1 || rows[0].(map[string]any)["parentId"] != anchor {
		t.Fatalf("tail did not retain non-linear branch parent: %v", rows)
	}
	response, _ = j.response(map[string]any{"since": "not-a-cursor"})
	if response["success"] != false {
		t.Fatal("unknown cursor became empty success")
	}
}
func TestTodoFixtureHeldReadCapturesBeforeReplacement(t *testing.T) {
	j, err := newJournal(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	token, err := j.arm()
	if err != nil {
		t.Fatal(err)
	}
	response, gate := j.response(map[string]any{"id": "held", "sessionId": "rpc-1"})
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	select {
	case <-gate.entered:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	captured := j.leaf
	if _, err := j.append(testCustom("replacement"), "", true); err != nil {
		t.Fatal(err)
	}
	if response["data"].(map[string]any)["leafId"] != captured {
		t.Fatal("held response read replacement state")
	}
	_, second := j.response(map[string]any{"id": "replacement"})
	if second != nil {
		t.Fatal("one-shot barrier captured replacement acquisition")
	}
	if got, err := j.getGate(token); err != nil || got != gate {
		t.Fatalf("token lookup: %v %v", got, err)
	}
	if _, err := j.getGate("unknown"); err == nil {
		t.Fatal("unknown token accepted")
	}
	j.releaseAll()
	select {
	case <-gate.release:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}
func TestTodoFixtureRealRPCProxy(t *testing.T) {
	root := t.TempDir()
	j, err := newJournal(root)
	if err != nil {
		t.Fatal(err)
	}
	d := omorpctest.New(root)
	if err := d.LoadSessionFile(j.path); err != nil {
		t.Fatal(err)
	}
	if err := d.Start(); err != nil {
		t.Fatal(err)
	}
	defer d.Stop()
	p, err := startProvider(filepath.Join(root, "proxy.sock"), d, j)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := p.close(); err != nil {
			t.Error(err)
		}
	}()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	client, err := omorpc.Dial(ctx, filepath.Join(root, "proxy.sock"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := client.Close(); err != nil {
			t.Error(err)
		}
	}()
	// Use the real protocol request shape, preserving shared daemon routing.
	opened, err := client.Call(ctx, omorpc.OpenSession{SessionPath: j.path})
	if err != nil {
		t.Fatal(err)
	}
	var open struct{ SessionID string }
	if err := json.Unmarshal(opened.Data, &open); err != nil {
		t.Fatal(err)
	}
	if open.SessionID == "" {
		t.Fatalf("open response=%s", opened.Data)
	}
	token, err := j.arm()
	if err != nil {
		t.Fatal(err)
	}
	gate, err := j.getGate(token)
	if err != nil {
		t.Fatal(err)
	}
	type result struct {
		response *omorpc.Response
		err      error
	}
	completed := make(chan result, 1)
	go func() {
		response, err := client.Call(ctx, omorpc.GetEntries{SessionID: open.SessionID})
		completed <- result{response, err}
	}()
	select {
	case <-gate.entered:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	old := j.leaf
	next, err := j.append(testCustom("next"), "", false)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-completed:
		t.Fatal("held RPC completed before release")
	default:
	}
	j.releaseAll()
	var first result
	select {
	case first = <-completed:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if first.err != nil {
		t.Fatal(first.err)
	}
	var history struct{ LeafID string }
	if err := json.Unmarshal(first.response.Data, &history); err != nil {
		t.Fatal(err)
	}
	if history.LeafID != old {
		t.Fatalf("old read=%s want=%s", history.LeafID, old)
	}
	later, err := client.Call(ctx, omorpc.GetEntries{SessionID: open.SessionID})
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(later.Data, &history); err != nil {
		t.Fatal(err)
	}
	if history.LeafID != next {
		t.Fatalf("next read=%s", history.LeafID)
	}
	d.EvictSessionSilently(j.path)
	if _, err := client.Call(ctx, omorpc.GetEntries{SessionID: open.SessionID}); err == nil {
		t.Fatal("proxy falsely served unloaded route")
	}
	if d.OpenCount() != 1 {
		t.Fatalf("history machinery reopened provider: %d", d.OpenCount())
	}
}
