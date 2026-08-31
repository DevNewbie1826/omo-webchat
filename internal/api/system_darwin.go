//go:build darwin

package api

import (
	"bufio"
	"context"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

var topCPURe = regexp.MustCompile(`CPU usage:.*?([\d.]+)% idle`)

var vmStatPageSizeRe = regexp.MustCompile(`page size of (\d+) bytes`)

const (
	defaultPageSize  uint64 = 4096
	topSampleTimeout        = 5 * time.Second
)

var (
	darwinSampleOnce sync.Once
	darwinSampleMu   sync.Mutex
	darwinCPU        float64
)

func cpuPercent() float64 {
	darwinSampleOnce.Do(func() {
		go darwinCPULoop()
	})
	darwinSampleMu.Lock()
	defer darwinSampleMu.Unlock()
	return darwinCPU
}

func darwinCPULoop() {
	for {
		if v, ok := sampleDarwinCPU(); ok {
			darwinSampleMu.Lock()
			darwinCPU = v
			darwinSampleMu.Unlock()
		}
		time.Sleep(time.Second)
	}
}

// The second top sample measures a one-second interval.
func sampleDarwinCPU() (float64, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), topSampleTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, "top", "-l", "2", "-s", "1", "-n", "0").Output()
	if err != nil {
		return 0, false
	}
	matches := topCPURe.FindAllSubmatch(out, -1)
	if len(matches) == 0 {
		return 0, false
	}
	idle, err := strconv.ParseFloat(string(matches[len(matches)-1][1]), 64)
	if err != nil {
		return 0, false
	}
	return 100 - idle, true
}

func systemMemory() (total, used uint64) {
	totalOut, err := exec.Command("sysctl", "-n", "hw.memsize").Output()
	if err != nil {
		return 0, 0
	}
	total, err = strconv.ParseUint(strings.TrimSpace(string(totalOut)), 10, 64)
	if err != nil || total == 0 {
		return 0, 0
	}
	used = darwinUsedMemory()
	if used > total {
		used = total
	}
	return total, used
}

// Used memory is active, wired, and compressed pages.
func darwinUsedMemory() uint64 {
	out, err := exec.Command("vm_stat").Output()
	if err != nil {
		return 0
	}
	pageSize := defaultPageSize
	var active, wired, compressor uint64
	sc := bufio.NewScanner(strings.NewReader(string(out)))
	for sc.Scan() {
		line := sc.Text()
		if strings.Contains(line, "page size of") {
			if m := vmStatPageSizeRe.FindStringSubmatch(line); len(m) == 2 {
				if v, err := strconv.ParseUint(m[1], 10, 64); err == nil {
					pageSize = v
				}
			}
			continue
		}
		key, valStr, found := strings.Cut(line, ":")
		if !found {
			continue
		}
		valStr = strings.TrimSuffix(strings.TrimSpace(valStr), ".")
		val, err := strconv.ParseUint(valStr, 10, 64)
		if err != nil {
			continue
		}
		switch strings.TrimSpace(key) {
		case "Pages active":
			active = val
		case "Pages wired down":
			wired = val
		case "Pages occupied by compressor":
			compressor = val
		}
	}
	return (active + wired + compressor) * pageSize
}
