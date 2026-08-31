//go:build linux

package api

import (
	"bufio"
	"os"
	"strconv"
	"strings"
	"sync"
)

var (
	cpuMu        sync.Mutex
	lastCPUTotal uint64
	lastCPUIdle  uint64
)

func cpuPercent() float64 {
	total, idle, ok := readProcStat()
	if !ok {
		return 0
	}
	cpuMu.Lock()
	defer cpuMu.Unlock()
	prevTotal, prevIdle := lastCPUTotal, lastCPUIdle
	lastCPUTotal, lastCPUIdle = total, idle
	if prevTotal == 0 || total <= prevTotal {
		return 0
	}
	deltaTotal := total - prevTotal
	deltaIdle := idle - prevIdle
	if deltaIdle >= deltaTotal {
		return 0
	}
	return float64(deltaTotal-deltaIdle) / float64(deltaTotal) * 100
}

func readProcStat() (total, idle uint64, ok bool) {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return 0, 0, false
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "cpu ") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 5 {
			return 0, 0, false
		}
		// Guest jiffies are already included in user and nice.
		for i := 1; i < len(fields); i++ {
			if i == 9 || i == 10 {
				continue
			}
			v, err := strconv.ParseUint(fields[i], 10, 64)
			if err != nil {
				continue
			}
			total += v
		}
		// Treat iowait as idle.
		idle, _ = strconv.ParseUint(fields[4], 10, 64)
		if len(fields) > 5 {
			iowait, _ := strconv.ParseUint(fields[5], 10, 64)
			idle += iowait
		}
		return total, idle, true
	}
	return 0, 0, false
}

func systemMemory() (total, used uint64) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0, 0
	}
	defer f.Close()
	var memTotal, memAvailable uint64
	var haveTotal, haveAvailable bool
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 2 {
			continue
		}
		kb, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			continue
		}
		switch fields[0] {
		case "MemTotal:":
			memTotal = kb * 1024
			haveTotal = true
		case "MemAvailable:":
			memAvailable = kb * 1024
			haveAvailable = true
		}
	}
	if !haveTotal {
		return 0, 0
	}
	if haveAvailable && memAvailable <= memTotal {
		return memTotal, memTotal - memAvailable
	}
	return memTotal, 0
}
