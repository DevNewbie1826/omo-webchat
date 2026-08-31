//go:build !darwin && !linux

package api

func cpuPercent() float64 { return 0 }

func systemMemory() (total, used uint64) { return 0, 0 }
