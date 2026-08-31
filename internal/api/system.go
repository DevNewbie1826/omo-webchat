package api

import (
	"net/http"
	"runtime"
	"time"
)

var serverStart = time.Now()

type systemStats struct {
	CPUPercent       float64 `json:"cpuPercent"`
	MemTotalBytes    uint64  `json:"memTotalBytes"`
	MemUsedBytes     uint64  `json:"memUsedBytes"`
	MemPercent       float64 `json:"memPercent"`
	NumGoroutine     int     `json:"numGoroutine"`
	GoHeapAllocBytes uint64  `json:"goHeapAllocBytes"`
	UptimeSeconds    float64 `json:"uptimeSeconds"`
	OS               string  `json:"os"`
	Arch             string  `json:"arch"`
	NumCPU           int     `json:"numCpu"`
}

func (s *Server) handleSystemStats(w http.ResponseWriter, r *http.Request) {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)

	memTotal, memUsed := systemMemory()
	if memTotal == 0 {
		// Fall back to runtime memory when host memory is unavailable.
		memTotal = m.Sys
		memUsed = m.HeapAlloc + m.StackInuse
	}
	memPercent := 0.0
	if memTotal > 0 {
		memPercent = float64(memUsed) / float64(memTotal) * 100
	}

	writeJSON(w, http.StatusOK, systemStats{
		CPUPercent:       cpuPercent(),
		MemTotalBytes:    memTotal,
		MemUsedBytes:     memUsed,
		MemPercent:       memPercent,
		NumGoroutine:     runtime.NumGoroutine(),
		GoHeapAllocBytes: m.HeapAlloc,
		UptimeSeconds:    time.Since(serverStart).Seconds(),
		OS:               runtime.GOOS,
		Arch:             runtime.GOARCH,
		NumCPU:           runtime.NumCPU(),
	})
}
