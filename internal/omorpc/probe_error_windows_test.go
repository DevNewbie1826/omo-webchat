//go:build windows

package omorpc

import (
	"context"
	"fmt"
	"golang.org/x/sys/windows"
	"testing"
)

func TestWindowsNamedPipeProbeErrors(t *testing.T) {
	for _, tc := range []struct {
		name   string
		err    error
		absent bool
	}{
		{"missing", windows.ERROR_FILE_NOT_FOUND, true},
		{"missing_parent", windows.ERROR_PATH_NOT_FOUND, true},
		{"busy", windows.ERROR_PIPE_BUSY, false},
		{"denied", windows.ERROR_ACCESS_DENIED, false},
		{"timeout", context.DeadlineExceeded, false},
		{"canceled", context.Canceled, false},
		{"legacy_winsock", windows.WSAENETDOWN, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := fmt.Errorf("dial: %w", tc.err)
			if isSpawnableProbeError(err) != tc.absent || isDialAbsentError(err) != tc.absent {
				t.Fatalf("wrong endpoint classification for %v", err)
			}
		})
	}
}
