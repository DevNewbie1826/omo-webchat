//go:build windows

package main

import (
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

// CREATE_NEW_PROCESS_GROUP (0x200) starts a new Win32 process group.
// CREATE_NO_WINDOW (0x8000000) skips allocating a console on interactive hosts.
const (
	createNewProcessGroup = 0x00000200
	createNoWindow        = 0x08000000
)

func configureSpawn(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: createNewProcessGroup | createNoWindow,
		HideWindow:    true,
	}
}

func killProcessTree(cmd *exec.Cmd) error {
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	// taskkill /T walks the child tree via CreateToolhelp32Snapshot /
	// Process32First, the public Win32 process-tree walk.
	kill := exec.Command("taskkill", "/F", "/T", "/PID", strconv.Itoa(cmd.Process.Pid))
	kill.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	out, err := kill.CombinedOutput()
	if err != nil {
		if cmd.ProcessState != nil && cmd.ProcessState.Exited() {
			return nil
		}
		return fmt.Errorf("taskkill: %v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}
