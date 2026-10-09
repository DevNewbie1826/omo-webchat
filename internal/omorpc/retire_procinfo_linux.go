package omorpc

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"syscall"
)

func inspectEngineProcess(pid int) (engineProcessInfo, error) {
	stat, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return engineProcessInfo{}, err
	}
	// comm may contain spaces or ')'. Field 3 begins after the LAST ')'.
	end := strings.LastIndexByte(string(stat), ')')
	if end < 0 {
		return engineProcessInfo{}, fmt.Errorf("invalid process stat for %d", pid)
	}
	fields := strings.Fields(string(stat)[end+1:])
	if len(fields) < 20 {
		return engineProcessInfo{}, fmt.Errorf("incomplete process stat for %d", pid)
	}
	start, err := strconv.ParseUint(fields[19], 10, 64)
	if err != nil {
		return engineProcessInfo{}, err
	}
	status, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid))
	if err != nil {
		return engineProcessInfo{}, err
	}
	uid := -1
	for _, line := range strings.Split(string(status), "\n") {
		if strings.HasPrefix(line, "Uid:") {
			values := strings.Fields(line)
			if len(values) < 3 {
				return engineProcessInfo{}, fmt.Errorf("incomplete process uid for %d", pid)
			}
			uid, err = strconv.Atoi(values[2]) // effective UID, as on Darwin
			if err != nil {
				return engineProcessInfo{}, err
			}
			break
		}
	}
	if uid < 0 {
		return engineProcessInfo{}, fmt.Errorf("missing process uid for %d", pid)
	}
	pgid, err := syscall.Getpgid(pid)
	if err != nil {
		return engineProcessInfo{}, err
	}
	return engineProcessInfo{startTime: start, pgid: pgid, uid: uid}, nil
}
