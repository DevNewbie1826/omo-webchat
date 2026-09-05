package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
)

const fixtureAwait = 2 * time.Second

type openResult struct {
	data omorpc.OpenSessionData
	err  error
}

type fixture struct {
	t      *testing.T
	daemon *omorpctest.Daemon
	lead   *omorpc.Client
	second *omorpc.Client
	base   string
	pathA  string
	pathB  string
	rpcA   string
	rpcB   string
}

func startFixture(t *testing.T) *fixture {
	t.Helper()
	root, err := os.MkdirTemp("", "omofx-*")
	if err != nil {
		t.Fatalf("temp dir: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	daemon := omorpctest.NewAt(filepath.Join(root, "engine"), filepath.Join(root, "s"))
	if err := daemon.Start(); err != nil {
		t.Fatalf("daemon start: %v", err)
	}
	t.Cleanup(daemon.Stop)
	lead, err := omorpc.DialWithConfig(context.Background(), daemon.SocketPath(), omorpc.Config{})
	if err != nil {
		t.Fatalf("dial lead: %v", err)
	}
	t.Cleanup(func() { _ = lead.Close() })
	second, err := omorpc.DialWithConfig(context.Background(), daemon.SocketPath(), omorpc.Config{})
	if err != nil {
		t.Fatalf("dial second: %v", err)
	}
	t.Cleanup(func() { _ = second.Close() })
	control := &controls{daemon: daemon, root: root, barriers: make(map[string]finalBarrier)}
	server := httptest.NewServer(control.handler())
	t.Cleanup(server.Close)
	env := &fixture{t: t, daemon: daemon, lead: lead, second: second, base: server.URL}
	env.pathA, env.rpcA = env.open(lead, filepath.Join(root, "a"))
	env.pathB, env.rpcB = env.open(lead, filepath.Join(root, "b"))
	return env
}

func (f *fixture) open(client *omorpc.Client, cwd string) (path, rpc string) {
	f.t.Helper()
	var opened omorpc.OpenSessionData
	f.callData(client, omorpc.OpenSession{CWD: cwd}, &opened)
	return opened.State.SessionFile, opened.SessionID
}

func (f *fixture) resume(client *omorpc.Client, path string) string {
	f.t.Helper()
	var opened omorpc.OpenSessionData
	f.callData(client, omorpc.OpenSession{SessionPath: path}, &opened)
	return opened.SessionID
}

func (f *fixture) call(client *omorpc.Client, cmd omorpc.Command) *omorpc.Response {
	f.t.Helper()
	resp := f.callMaybe(client, cmd)
	if !resp.Success {
		f.t.Fatalf("Call %T: %v", cmd, resp.Err())
	}
	return resp
}

func (f *fixture) callMaybe(client *omorpc.Client, cmd omorpc.Command) *omorpc.Response {
	f.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), fixtureAwait)
	defer cancel()
	resp, err := client.Call(ctx, cmd)
	if resp == nil {
		f.t.Fatalf("Call %T: %v", cmd, err)
	}
	return resp
}

func (f *fixture) awaitOpen(ch <-chan openResult, what string) omorpc.OpenSessionData {
	f.t.Helper()
	timer := time.NewTimer(fixtureAwait)
	defer timer.Stop()
	select {
	case result := <-ch:
		if result.err != nil {
			f.t.Fatalf("%s: %v", what, result.err)
		}
		return result.data
	case <-timer.C:
		f.t.Fatalf("%s did not complete after release", what)
		return omorpc.OpenSessionData{}
	}
}

func (f *fixture) waitErr(ch <-chan error, what string) {
	f.t.Helper()
	timer := time.NewTimer(fixtureAwait)
	defer timer.Stop()
	select {
	case err := <-ch:
		if err != nil {
			f.t.Fatalf("%s: %v", what, err)
		}
	case <-timer.C:
		f.t.Fatalf("%s did not complete after release", what)
	}
}

func (f *fixture) callData(client *omorpc.Client, cmd omorpc.Command, out any) {
	f.t.Helper()
	resp := f.call(client, cmd)
	if err := json.Unmarshal(resp.Data, out); err != nil {
		f.t.Fatalf("decode %T: %v", cmd, err)
	}
}

func (f *fixture) post(path string, body any) map[string]any {
	f.t.Helper()
	payload, err := json.Marshal(body)
	if err != nil {
		f.t.Fatalf("marshal: %v", err)
	}
	resp, err := http.Post(f.base+path, "application/json", bytes.NewReader(payload))
	if err != nil {
		f.t.Fatalf("POST %s: %v", path, err)
	}
	defer resp.Body.Close()
	var out map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		f.t.Fatalf("decode POST %s: %v", path, err)
	}
	if resp.StatusCode != http.StatusOK {
		f.t.Fatalf("POST %s: status %d body %#v", path, resp.StatusCode, out)
	}
	return out
}

func (f *fixture) postAsync(path string, body any) <-chan map[string]any {
	f.t.Helper()
	done := make(chan map[string]any, 1)
	go func() {
		done <- f.post(path, body)
	}()
	return done
}

func (f *fixture) awaitJSON(ch <-chan map[string]any, what string) map[string]any {
	f.t.Helper()
	timer := time.NewTimer(fixtureAwait)
	defer timer.Stop()
	select {
	case out := <-ch:
		return out
	case <-timer.C:
		f.t.Fatalf("%s did not complete", what)
		return nil
	}
}

func (f *fixture) seedHistory(path string, count int) {
	f.t.Helper()
	out := f.post("/history", historyRequest{Path: path, Count: count})
	if added, _ := out["added"].(float64); int(added) != count {
		f.t.Fatalf("history added=%v want %d", out["added"], count)
	}
}

func TestFinalQueryBarrierIgnoresSiblingHistory(t *testing.T) {
	// Given: two live chats and sibling B already hydrated through get_entries.
	f := startFixture(t)
	f.seedHistory(f.pathA, 4)
	f.seedHistory(f.pathB, 4)
	for i := 0; i < 3; i++ {
		f.call(f.lead, omorpc.GetEntries{SessionID: f.rpcB})
	}
	global := f.daemon.RequestCount(omorpc.CmdGetEntries)
	pathA := f.daemon.RequestCountForPath(omorpc.CmdGetEntries, f.pathA)
	if global <= pathA {
		t.Fatalf("setup did not inflate global get_entries (%d) above path A (%d)", global, pathA)
	}

	// When: A's terminal-query barrier is armed and B issues another history read.
	armed := f.post("/final-query/arm", pathRequest{Path: f.pathA})
	token, _ := armed["token"].(string)
	if token == "" {
		t.Fatalf("arm returned no token: %#v", armed)
	}
	f.call(f.lead, omorpc.GetEntries{SessionID: f.rpcB})
	evict := f.postAsync("/final-query/evict", tokenRequest{Token: token})
	select {
	case out := <-evict:
		t.Fatalf("sibling get_entries tripped A's barrier: %#v", out)
	default:
	}

	// Then: only A's next get_entries enters the barrier and completes eviction.
	parked := f.callMaybe(f.lead, omorpc.GetEntries{SessionID: f.rpcA})
	if parked.Success || parked.Error != omorpc.ErrCodeUnknownSession {
		t.Fatalf("parked A get_entries after evict: success=%v error=%q", parked.Success, parked.Error)
	}
	out := f.awaitJSON(evict, "final-query evict")
	if out["completed"] != true {
		t.Fatalf("evict: %#v", out)
	}
}

func TestFinalQueryBarrierKeepsCountAcrossRoutingRotation(t *testing.T) {
	// Given: two chats, sibling history, and A already observed via its first routing id.
	f := startFixture(t)
	f.seedHistory(f.pathA, 4)
	f.seedHistory(f.pathB, 4)
	f.call(f.lead, omorpc.GetEntries{SessionID: f.rpcB})
	f.call(f.lead, omorpc.GetEntries{SessionID: f.rpcA})
	before := f.daemon.RequestCountForPath(omorpc.CmdGetEntries, f.pathA)
	if before != 1 {
		t.Fatalf("path A get_entries before rotation=%d", before)
	}

	// When: A is silently evicted and resumed under a new routing handle.
	f.post("/silent", pathRequest{Path: f.pathA})
	newRPC := f.resume(f.lead, f.pathA)
	if newRPC == "" || newRPC == f.rpcA {
		t.Fatalf("resume reused routing id %q", newRPC)
	}
	after := f.daemon.RequestCountForPath(omorpc.CmdGetEntries, f.pathA)
	if after != before {
		t.Fatalf("historical routing id dropped path get_entries count from %d to %d (global=%d)", before, after, f.daemon.RequestCount(omorpc.CmdGetEntries))
	}

	// Then: the next A query still trips a path-scoped final-query barrier.
	armed := f.post("/final-query/arm", pathRequest{Path: f.pathA})
	token, _ := armed["token"].(string)
	evict := f.postAsync("/final-query/evict", tokenRequest{Token: token})
	parked := f.callMaybe(f.lead, omorpc.GetEntries{SessionID: newRPC})
	if parked.Success || parked.Error != omorpc.ErrCodeUnknownSession {
		t.Fatalf("parked A get_entries after evict: success=%v error=%q", parked.Success, parked.Error)
	}
	out := f.awaitJSON(evict, "final-query evict after routing rotation")
	if out["completed"] != true {
		t.Fatalf("evict: %#v", out)
	}
}

func TestOpenBarrierHoldsReplacementWhileSecondSocketQueues(t *testing.T) {
	// Given: A is silently evicted and a replacement open is armed.
	f := startFixture(t)
	opens := f.daemon.OpenCount()
	baseline := f.daemon.RequestCountForPath(omorpc.CmdOpenSession, f.pathA)
	f.post("/silent", pathRequest{Path: f.pathA})
	armed := f.post("/open-barrier/arm", pathRequest{Path: f.pathA})
	token, _ := armed["token"].(string)
	if token == "" {
		t.Fatalf("arm returned no token: %#v", armed)
	}

	leadOpen := make(chan openResult, 1)
	go func() {
		resp, err := f.lead.Call(context.Background(), omorpc.OpenSession{SessionPath: f.pathA})
		var data omorpc.OpenSessionData
		if err == nil {
			err = json.Unmarshal(resp.Data, &data)
		}
		leadOpen <- openResult{data: data, err: err}
	}()
	parked := f.post("/open-barrier/await", tokenRequest{Token: token})
	if parked["parked"] != true {
		t.Fatalf("await: %#v", parked)
	}
	if f.daemon.OpenCount() != opens {
		t.Fatal("open barrier released on entry")
	}
	select {
	case result := <-leadOpen:
		t.Fatalf("lead open completed on entry: %v", result.err)
	default:
	}

	// When: a second socket queues another resume open against the held replacement.
	secondOpen := make(chan openResult, 1)
	go func() {
		resp, err := f.second.Call(context.Background(), omorpc.OpenSession{SessionPath: f.pathA})
		var data omorpc.OpenSessionData
		if err == nil {
			err = json.Unmarshal(resp.Data, &data)
		}
		secondOpen <- openResult{data: data, err: err}
	}()
	if !f.daemon.AwaitRequestCountForPath(omorpc.CmdOpenSession, f.pathA, baseline+2, fixtureAwait) {
		t.Fatal("second socket resume open did not queue")
	}
	if f.daemon.OpenCount() != opens {
		t.Fatal("queued second open released the held replacement")
	}
	select {
	case result := <-secondOpen:
		t.Fatalf("second socket open completed while replacement was held: %v", result.err)
	default:
	}

	// Then: release lets both in-flight opens complete.
	released := f.post("/open-barrier/release", tokenRequest{Token: token})
	if released["released"] != true {
		t.Fatalf("release: %#v", released)
	}
	leadResult := f.awaitOpen(leadOpen, "lead open after release")
	secondResult := f.awaitOpen(secondOpen, "second open after release")
	if leadResult.SessionID == "" || secondResult.SessionID == "" || leadResult.SessionID == secondResult.SessionID {
		t.Fatalf("held opens returned routing IDs %q and %q", leadResult.SessionID, secondResult.SessionID)
	}
}
