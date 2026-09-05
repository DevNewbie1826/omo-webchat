//go:build windows && realomo

package omorpc

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Run only in the authoritative job with the pinned actual omo installed:
// go test -tags=realomo ./internal/omorpc -run '^TestWindowsRealOmoReconnect$' -count=1 -v -timeout=2m
// The build tag keeps this required integration entry separate from the normal
// fixture suite, without skips or a public production fault-injection API.
func TestWindowsRealOmoReconnect(t *testing.T) {
	t.Run("native_holder_cleanup", testWindowsReconnectDirectoryHolderCleanup)
	dir, err := os.MkdirTemp("", "wr")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := waitReconnectDirectoryHolders(t, dir, nil); err != nil {
			t.Errorf("join isolated directory holders: %v", err)
		}
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
	// This actual extension reports machine-consumed context from the session
	// host, not the public supervisor. No secrets or raw command lines leave it.
	extensions := filepath.Join(agent, "extensions")
	if err := os.MkdirAll(extensions, 0700); err != nil {
		t.Fatal(err)
	}
	const contextExtension = `import { fstatSync } from "node:fs";
export default function(pi) {
  let fd3 = false;
  try { fstatSync(3); fd3 = true; } catch (error) { fd3 = error.code; }
  pi.registerCommand("win65-context", {
    description: JSON.stringify({pid:process.pid, ppid:process.ppid,
      watchPpid:Number(process.env.SENPI_RPC_HOST_WATCH_PPID), fd3,
      brand:process.title, runtime:process.versions.bun ? "bun" : "node",
      native:/[\\/]senpi[\\/]dist[\\/]cli(?:-main)?\.js$/.test(process.argv[1])}),
    handler:async () => {}
  });
}
`
	if err := os.WriteFile(filepath.Join(extensions, "context.js"), []byte(contextExtension), 0600); err != nil {
		t.Fatal(err)
	}
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
	requestedRuntime := os.Getenv("OMORPC_REAL_RUNTIME")
	if requestedRuntime != "" {
		if requestedRuntime != "node" && requestedRuntime != "bun" {
			t.Fatalf("invalid diagnostic runtime selection %q", requestedRuntime)
		}
		env = setEnv(env, "OMO_RUNTIME", requestedRuntime)
		env = setEnv(env, "SENPI_RUNTIME", requestedRuntime)
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
		if t.Failed() && peer != 0 {
			// Failure-only diagnostics: native process events/codes and a fixed
			// marker allowlist, never runtime source, secrets, paths or raw logs.
			state, waitErr := windows.WaitForSingleObject(peer, 5000)
			var code uint32
			codeErr := windows.GetExitCodeProcess(peer, &code)
			t.Logf("failure: real peer exit state=%d wait-error=%v code=%d code-error=%v", state, waitErr, code, codeErr)
		}
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
		// Stop joins cmd.Wait and publishes the bounded log before it is read.
		if t.Failed() {
			data, err := os.ReadFile(filepath.Join(cfg.StateDir, "daemon-spawn.log"))
			if err != nil {
				t.Errorf("read bounded runtime diagnostics: %v", err)
			} else {
				for _, marker := range []string{"EPIPE", "ENOENT", "ERR_STREAM_DESTROYED", "TypeError:", "ReferenceError:", "panic:", "Segmentation fault", "shutting down", "rpc host child exit observed by identity watchdog", "supervisor pid", "supervisor pipe fd", "Bun v", "Node.js v"} {
					t.Logf("failure: runtime marker=%q present=%t", marker, strings.Contains(string(data), marker))
				}
			}
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
	recordReconnectRuntime(t, owner, ownerEpoch.epoch.conn.(*identifiedPipe), requestedRuntime)
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
	assertReconnectHostContext(t, ctx, shared.Client, current, session.SessionID, pipe.pid, requestedRuntime)
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

// get_commands observes the real loaded extensions and the native session host.
func assertReconnectHostContext(t *testing.T, ctx context.Context, client *Client, epoch EpochToken, session string, supervisor uint32, requested string) {
	t.Helper()
	response, gotEpoch, err := client.CallInEpochToken(ctx, epoch, GetCommands{SessionID: session})
	if err != nil || gotEpoch != epoch || response == nil || !response.Success || response.ID == "" || response.Command != "get_commands" {
		t.Fatalf("recovered get_commands correlation: %v", err)
	}
	var data struct {
		Commands []struct {
			Name        string `json:"name"`
			Description string `json:"description"`
			Source      string `json:"source"`
			SourceInfo  struct {
				Source string `json:"source"`
			} `json:"sourceInfo"`
		} `json:"commands"`
	}
	if err := json.Unmarshal(response.Data, &data); err != nil {
		t.Fatal(err)
	}
	var names []string
	found := false
	for _, command := range data.Commands {
		if command.Source == "extension" && command.SourceInfo.Source == "cli" {
			names = append(names, command.Name)
		}
		if command.Name != "win65-context" {
			continue
		}
		found = true
		var host struct {
			PID       uint32
			PPID      uint32
			WatchPPID uint32
			FD3       any
			Brand     string
			Runtime   string
			Native    bool
		}
		if err := json.Unmarshal([]byte(command.Description), &host); err != nil {
			t.Fatal(err)
		}
		t.Logf("native host contract: pid=%d parent=%d supervisor=%d watch-ppid=%d fd3=%v brand=%s runtime=%s native=%t", host.PID, host.PPID, supervisor, host.WatchPPID, host.FD3, host.Brand, host.Runtime, host.Native)
		if host.PPID != supervisor || host.WatchPPID != supervisor || host.FD3 != true || host.Brand != "OmO" || !host.Native {
			t.Errorf("native host lost direct parent, FD3, or brand context")
		}
		if requested != "" && host.Runtime != requested {
			t.Errorf("native host runtime=%s, requested=%s", host.Runtime, requested)
		}
	}
	if !found {
		t.Fatal("native session did not load context extension")
	}
	slices.Sort(names)
	for _, name := range []string{"doctor", "memory", "dag", "tasks", "task-kill"} {
		if !slices.Contains(names, name) {
			t.Errorf("packaged CLI extension command %s missing", name)
		}
	}
	encoded, err := json.Marshal(names)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("extension command parity: %s", encoded)
}

// Native image observations avoid confusing the requested environment with the
// effective engine. Only sandbox-owned processes are reported, never command
// lines, profile contents or full executable paths. Descendant labels do not
// assert which launcher layer hosts sessions.
func recordReconnectRuntime(t *testing.T, owner *EnsuredDaemon, pipe *identifiedPipe, requested string) {
	t.Helper()
	if requested == "" {
		requested = "automatic"
	}
	imageName := func(process windows.Handle) (string, error) {
		var image [32768]uint16
		size := uint32(len(image))
		if err := windows.QueryFullProcessImageName(process, 0, &image[0], &size); err != nil {
			return "", err
		}
		return strings.ToLower(filepath.Base(windows.UTF16ToString(image[:size]))), nil
	}
	pipe.mu.Lock()
	image, err := imageName(pipe.process)
	pipe.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	effective := strings.TrimSuffix(image, ".exe")
	if effective != "node" && effective != "bun" {
		effective = "unclassified"
	}
	t.Logf("runtime comparison: requested=%s role=public-pipe-server pid=%d image=%s effective=%s", requested, pipe.pid, image, effective)
	if requested != "automatic" && effective != requested {
		t.Fatalf("requested %s but actual public server image is %s", requested, image)
	}
	queryCtx, queryCancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer queryCancel()
	query := exec.CommandContext(queryCtx, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '[\\/]senpi[\\/]dist[\\/]cli(?:-main)?\.js' -and $_.CommandLine -match '--multi-session' -and $_.CommandLine -match '--listen' } | ForEach-Object { [pscustomobject]@{pid=$_.ProcessId;parent=$_.ParentProcessId} })`)
	query.WaitDelay = time.Second
	output, err := query.Output()
	if err != nil {
		t.Fatalf("bounded native host-role query: %v", err)
	}
	var hosts []struct {
		PID    uint32
		Parent uint32
	}
	if err := json.Unmarshal(output, &hosts); err != nil {
		t.Fatalf("native host-role result: %v", err)
	}
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := windows.CloseHandle(snapshot); err != nil {
			t.Error(err)
		}
	}()
	entry := windows.ProcessEntry32{Size: uint32(unsafe.Sizeof(windows.ProcessEntry32{}))}
	var entries []windows.ProcessEntry32
	for err = windows.Process32First(snapshot, &entry); err == nil; err = windows.Process32Next(snapshot, &entry) {
		entries = append(entries, entry)
	}
	if !errors.Is(err, windows.ERROR_NO_MORE_FILES) {
		t.Fatal(err)
	}
	descendants := map[uint32]bool{pipe.pid: true}
	for changed := true; changed; {
		changed = false
		for _, entry := range entries {
			if descendants[entry.ParentProcessID] && !descendants[entry.ProcessID] {
				descendants[entry.ProcessID] = true
				changed = true
			}
		}
	}
	domain := owner.supervisor.tracked.(interface{ ContainsProcess(uintptr) (bool, error) })
	for _, entry := range entries {
		if entry.ProcessID == pipe.pid || !descendants[entry.ProcessID] {
			continue
		}
		h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, entry.ProcessID)
		if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
			continue // This snapshot member has already exited; no live image claimed.
		}
		if err != nil {
			t.Fatal(err)
		}
		owned, memberErr := domain.ContainsProcess(uintptr(h))
		if memberErr == nil && owned {
			for _, host := range hosts {
				if host.PID == entry.ProcessID {
					t.Logf("native command role: host=%d parent=%d public-supervisor=%d direct=%t", host.PID, host.Parent, pipe.pid, host.Parent == pipe.pid)
					if host.Parent != pipe.pid {
						t.Errorf("native session host parent=%d, supervisor requires %d", host.Parent, pipe.pid)
					}
				}
			}
			image, memberErr = imageName(h)
			if memberErr == nil {
				t.Logf("runtime comparison: requested=%s role=owned-descendant pid=%d parent=%d image=%s", requested, entry.ProcessID, entry.ParentProcessID, image)
			}
		}
		if err := errors.Join(memberErr, windows.CloseHandle(h)); err != nil {
			t.Fatal(err)
		}
	}
}

// A native query observed an external PowerShell holder after tracked-job drain.
// Its ancestry was not established. Confirm only the relationship we can prove:
// the retained process still holds this sandbox directory. Join that process's
// exit event under one overall bound, without termination, polling or retries.
func waitReconnectDirectoryHolders(t *testing.T, dir string, observed func(uint32)) error {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	deadline, _ := ctx.Deadline()
	return endpointIO(ctx, func() (resultErr error) {
		path, err := windows.UTF16PtrFromString(dir)
		if err != nil {
			return err
		}
		h, err := windows.CreateFile(path, windows.FILE_READ_ATTRIBUTES, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
			nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
		if err != nil {
			return err
		}
		defer func() { resultErr = errors.Join(resultErr, windows.CloseHandle(h)) }()
		query := func() ([]uintptr, error) {
			var info struct {
				Count uint32
				IDs   [128]uintptr
			}
			var status windows.IO_STATUS_BLOCK
			const fileProcessIdsUsingFileInformation = 47
			if err := windows.NtQueryInformationFile(h, &status, (*byte)(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)), fileProcessIdsUsingFileInformation); err != nil {
				return nil, err
			}
			if info.Count > uint32(len(info.IDs)) {
				return nil, fmt.Errorf("directory holder list overflow: %d", info.Count)
			}
			return info.IDs[:info.Count], nil
		}
		ids, err := query()
		if err != nil {
			return err
		}
		type holder struct {
			pid    uintptr
			handle windows.Handle
		}
		var holders []holder
		defer func() {
			for _, holder := range holders {
				if holder.handle != 0 {
					resultErr = errors.Join(resultErr, windows.CloseHandle(holder.handle))
				}
			}
		}()
		for _, pid := range ids {
			if pid == uintptr(os.Getpid()) {
				continue // The query owns h; self-only output proves no application leak.
			}
			p, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
			if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
				t.Logf("cleanup: directory-holder pid=%d already exited before native handle open", pid)
				continue
			}
			if err != nil {
				return err
			}
			holders = append(holders, holder{pid, p})
		}
		// Confirm membership AFTER retaining the process handles; the first PID
		// snapshot alone is not a safe identity across process exit/PID reuse.
		confirmed, err := query()
		if err != nil {
			return err
		}
		for i, holder := range holders {
			stillHolds := false
			for _, pid := range confirmed {
				stillHolds = stillHolds || pid == holder.pid
			}
			if !stillHolds {
				continue // Native confirmation shows this process released the resource.
			}
			var code uint32
			if err := windows.GetExitCodeProcess(holder.handle, &code); err != nil {
				return err
			}
			t.Logf("cleanup: directory-holder pid=%d native-membership-confirmed=true exit-handle-retained=true", holder.pid)
			if observed != nil {
				observed(uint32(holder.pid))
			}
			remaining := time.Until(deadline)
			if remaining <= 0 {
				return context.DeadlineExceeded
			}
			milliseconds := uint32((remaining + time.Millisecond - 1) / time.Millisecond)
			state, waitErr := windows.WaitForSingleObject(holder.handle, milliseconds)
			closeErr := windows.CloseHandle(holder.handle)
			holders[i].handle = 0
			if err := errors.Join(waitErr, closeErr); err != nil {
				return err
			}
			if state != windows.WAIT_OBJECT_0 {
				return fmt.Errorf("directory-holder pid=%d exit event did not signal: %d: %w", holder.pid, state, context.DeadlineExceeded)
			}
			t.Logf("cleanup: directory-holder pid=%d initial-exit-code=%d process-exit-signaled=true handle-closed=true", holder.pid, code)
		}
		return nil
	})
}

// This child owns no descendants. Its cwd retains the directory until stdin EOF
// releases it; the parent releases only after native holder/handle observation.
func TestWindowsReconnectHolderProcess(t *testing.T) {
	if os.Getenv("OMORPC_RECONNECT_HOLDER") != "1" {
		return
	}
	if _, err := fmt.Fprintln(os.Stdout, "HOLDER_READY"); err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(io.Discard, os.Stdin); err != nil {
		t.Fatal(err)
	}
}

func testWindowsReconnectDirectoryHolderCleanup(t *testing.T) {
	dir := t.TempDir()
	cmd := exec.Command(os.Args[0], "-test.run=^TestWindowsReconnectHolderProcess$")
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "OMORPC_RECONNECT_HOLDER=1")
	input, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	ready := make(chan error, 1)
	readerDone := make(chan struct{})
	go func() {
		defer close(readerDone)
		line, err := bufio.NewReader(output).ReadString('\n')
		if err == nil && strings.TrimSpace(line) != "HOLDER_READY" {
			err = errors.New("invalid holder readiness sentinel")
		}
		ready <- err
	}()
	done := make(chan struct{})
	var waitErr error
	go func() {
		waitErr = cmd.Wait()
		close(done)
	}()
	release := func() {
		if input != nil {
			if err := input.Close(); err != nil {
				t.Error(err)
			}
			input = nil
		}
	}
	t.Cleanup(func() {
		release()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("owned holder fixture failed to exit after release")
			if err := cmd.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
				t.Error(err)
			}
			// Only this explicitly started fixture can be terminated on failure.
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				t.Error("owned holder fixture failed to join after termination")
				return
			}
		}
		select {
		case <-readerDone:
		case <-time.After(5 * time.Second):
			t.Error("holder readiness reader failed to join")
		}
		if waitErr != nil {
			t.Errorf("join holder fixture: %v", waitErr)
		}
	})
	select {
	case err := <-ready:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("holder fixture readiness did not arrive")
	}
	observed := false
	if err := waitReconnectDirectoryHolders(t, dir, func(pid uint32) {
		if pid != uint32(cmd.Process.Pid) {
			return
		}
		observed = true
		release()
	}); err != nil {
		t.Fatal(err)
	}
	if !observed {
		t.Fatal("native query did not confirm the owned sandbox holder before release")
	}
	select {
	case <-done:
		if waitErr != nil {
			t.Fatalf("join holder fixture before removal: %v", waitErr)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("holder cmd.Wait did not join before removal")
	}
	if err := os.RemoveAll(dir); err != nil {
		t.Fatal(err)
	}
	t.Log("cleanup fixture: exact owned holder observed before release; native exit joined; single RemoveAll passed")
}
