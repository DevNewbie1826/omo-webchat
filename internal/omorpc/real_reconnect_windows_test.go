//go:build windows && realomo

package omorpc

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// Run only in the authoritative job with the pinned actual omo installed:
// go test -tags=realomo ./internal/omorpc -run '^TestWindowsRealOmoReconnect$' -count=1 -v -timeout=2m
// The build tag keeps this required integration entry separate from the normal
// fixture suite, without skips or a public production fault-injection API.
func TestWindowsRealOmoReconnect(t *testing.T) {
	dir, err := os.MkdirTemp("", "wr")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(dir); err != nil {
			t.Errorf("remove isolated profile: %v", err)
			return
		}
		if _, err := os.Stat(dir); !os.IsNotExist(err) {
			t.Errorf("isolated profile remains: %v", err)
			return
		}
		t.Logf("cleanup: reconnect profile=%s removed=true", dir)
	})
	home := filepath.Join(dir, "h")
	agent := filepath.Join(home, ".omo", "agent")
	env := os.Environ()
	for key, value := range map[string]string{
		"HOME": home, "USERPROFILE": home,
		"APPDATA":              filepath.Join(home, "AppData", "Roaming"),
		"LOCALAPPDATA":         filepath.Join(home, "AppData", "Local"),
		"XDG_CONFIG_HOME":      filepath.Join(home, ".config"),
		"XDG_CACHE_HOME":       filepath.Join(home, ".cache"),
		"OMO_CODING_AGENT_DIR": agent, "SENPI_CODING_AGENT_DIR": agent,
		"OMO_RPC_CLIENT_CAPABILITIES":   "extension_events",
		"SENPI_RPC_CLIENT_CAPABILITIES": "extension_events",
	} {
		env = setEnv(env, key, value)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 90*time.Second)
	defer cancel()
	cfg := EnsureConfig{BinaryPath: "omo", AgentDir: agent, WorkingDir: dir,
		StateDir: filepath.Join(dir, "state"), Env: env, ReadyTimeout: 35 * time.Second}
	owner, err := EnsureDaemon(ctx, cfg)
	if err != nil {
		t.Fatalf("real omo fresh Ensure: %v", err)
	}
	var shared *EnsuredDaemon
	var peer windows.Handle
	var pipes []*identifiedPipe
	t.Cleanup(func() {
		if shared != nil {
			if err := shared.StopBounded(10 * time.Second); err != nil {
				t.Errorf("cleanup shared client: %v", err)
			}
		}
		if err := owner.StopBounded(10 * time.Second); err != nil {
			t.Errorf("cleanup owned daemon: %v", err)
		} else {
			t.Log("cleanup: owned Stop completed; tracked job drained/closed and client workers joined")
		}
		if peer != 0 {
			state, err := windows.WaitForSingleObject(peer, 5000)
			if err != nil || state != windows.WAIT_OBJECT_0 {
				t.Errorf("owned real peer process exit event: state=%d err=%v", state, err)
			} else {
				t.Log("cleanup: retained real peer process exit event signaled")
			}
			if err := windows.CloseHandle(peer); err != nil {
				t.Errorf("close retained peer process handle: %v", err)
			} else {
				t.Log("cleanup: retained peer process handle closed")
			}
		}
		for i, pipe := range pipes {
			if err := pipe.Close(); err != nil {
				t.Errorf("close transport %d: %v", i, err)
			}
			pipe.mu.Lock()
			closed := pipe.process == 0
			pipe.mu.Unlock()
			if !closed {
				t.Errorf("transport %d retained its peer handle", i)
			}
		}
		if !t.Failed() {
			t.Logf("cleanup: %d real pipe/identity handles closed; both Clients joined", len(pipes))
		}
	})
	if !owner.Owned || owner.supervisor == nil {
		t.Fatal("fresh sandbox daemon is not tracked/owned")
	}
	if owner.ProtocolInfo.ServerVersion != "2026.9.5" {
		t.Fatalf("real runtime version=%q, want 2026.9.5", owner.ProtocolInfo.ServerVersion)
	}
	ownerEpoch, _ := owner.Client.CurrentEpoch()
	pipes = append(pipes, ownerEpoch.epoch.conn.(*identifiedPipe))
	shared, err = EnsureDaemon(ctx, cfg)
	if err != nil {
		t.Fatalf("real omo compatible Ensure: %v", err)
	}
	if shared.Owned || shared.supervisor != nil || shared.waitCh != nil {
		t.Fatal("compatible Ensure claimed shared ownership")
	}
	// Subscribe to the exact epoch's death stream BEFORE closing only this
	// sandbox client's real transport. Neither Client.Close nor invalidate is
	// called: readLoop must discover the loss and retire this epoch itself.
	old, death := shared.Client.CurrentEpoch()
	pipe := old.epoch.conn.(*identifiedPipe)
	pipes = append(pipes, pipe)
	if connectionPeerProvenance(pipe, owner.supervisor.process.Pid) != peerOwned {
		t.Fatal("loss target is not in the sandbox's owned process domain")
	}
	if err := windows.DuplicateHandle(windows.CurrentProcess(), pipe.process,
		windows.CurrentProcess(), &peer, 0, false, windows.DUPLICATE_SAME_ACCESS); err != nil {
		t.Fatal(err)
	}
	t.Logf("real reconnect: runtime=%s owned=true shared=false peer=%d epoch=%d death-subscribed=true",
		owner.ProtocolInfo.ServerVersion, pipe.pid, old.epoch.number)
	if err := old.epoch.conn.Close(); err != nil {
		t.Fatalf("induce sandbox transport loss: %v", err)
	}
	lossCtx, lossCancel := context.WithTimeout(ctx, 5*time.Second)
	defer lossCancel()
	for death != nil {
		select {
		case _, open := <-death:
			if !open {
				death = nil
			}
		case <-lossCtx.Done():
			t.Fatalf("real transport death was not observed: %v", lossCtx.Err())
		}
	}
	if shared.Client.EpochCurrent(old) {
		t.Fatal("dead real transport retained its epoch")
	}
	t.Logf("real reconnect: loss observed epoch=%d stream-closed=true current=false", old.epoch.number)
	resp, current, err := shared.Client.CallInEpoch(ctx, GetProtocolInfo{})
	if err != nil {
		t.Fatalf("real reconnect get_protocol_info: %v", err)
	}
	if current == old || current.epoch == nil || !shared.Client.EpochCurrent(current) {
		t.Fatal("protocol response did not come from a new live epoch")
	}
	recovered := current.epoch.conn.(*identifiedPipe)
	pipes = append(pipes, recovered)
	if recovered.identity != pipe.identity {
		t.Fatal("reconnect changed the shared daemon process identity")
	}
	var info ProtocolInfo
	if err := json.Unmarshal(resp.Data, &info); err != nil {
		t.Fatal(err)
	}
	if !resp.Success || resp.ID == "" || resp.Command != "get_protocol_info" ||
		info.ProtocolVersion != 1 || info.ServerVersion != "2026.9.5" {
		t.Fatal("reconnect lacked a correlated compatible protocol response")
	}
	t.Logf("real reconnect: old=%d new=%d peer=%d get_protocol_info id=%s success=true protocol=%d runtime=%s",
		old.epoch.number, current.epoch.number, recovered.pid, resp.ID, info.ProtocolVersion, info.ServerVersion)
	opened, sessionEpoch, err := shared.Client.CallInEpoch(ctx, OpenSession{CWD: dir})
	if err != nil {
		t.Fatalf("real reconnect open_session: %v", err)
	}
	var session OpenSessionData
	if err := json.Unmarshal(opened.Data, &session); err != nil {
		t.Fatal(err)
	}
	if sessionEpoch != current || !opened.Success || opened.ID == "" ||
		opened.Command != "open_session" || session.SessionID == "" {
		t.Fatal("real session did not open successfully in the recovered epoch")
	}
	closed, closeEpoch, err := shared.Client.CallInEpochToken(ctx, current, CloseSession{SessionID: session.SessionID})
	if err != nil || closeEpoch != current || closed == nil || !closed.Success ||
		closed.ID == "" || closed.Command != "close_session" {
		t.Fatalf("real reconnect close_session: %v", err)
	}
	t.Logf("real reconnect: epoch=%d session=%s open-id=%s close-id=%s success=true",
		current.epoch.number, session.SessionID, opened.ID, closed.ID)
	if shared.Owned || shared.supervisor != nil || shared.waitCh != nil {
		t.Fatal("reconnect claimed shared ownership")
	}
	if err := shared.StopBounded(10 * time.Second); err != nil {
		t.Fatalf("shared Stop: %v", err)
	}
	state, err := windows.WaitForSingleObject(peer, 0)
	if err != nil || state != uint32(windows.WAIT_TIMEOUT) {
		t.Fatalf("shared Stop killed the daemon: state=%d err=%v", state, err)
	}
	preserved, preservedEpoch, err := owner.Client.CallInEpoch(ctx, GetProtocolInfo{})
	if err != nil || preservedEpoch != ownerEpoch || preserved == nil || !preserved.Success ||
		preserved.ID == "" || preserved.Command != "get_protocol_info" {
		t.Fatalf("daemon unusable after shared Stop: %v", err)
	}
	t.Logf("real reconnect: shared owned=false Stop preserved peer=%d owner-epoch=%d protocol-id=%s success=true",
		pipe.pid, ownerEpoch.epoch.number, preserved.ID)
}
