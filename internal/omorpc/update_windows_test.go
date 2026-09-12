//go:build windows

package omorpc

import (
	"errors"
	"testing"
)

func TestUpdateInstallationWindowsRejected(t *testing.T) {
	// Rejection precedes even launcher lookup: an active engine may lock native
	// modules, so no Windows package manager may be started by this endpoint.
	if err := UpdateInstallation(t.Context(), "missing-launcher.exe"); !errors.Is(err, errWindowsInstallationUpdate) {
		t.Fatalf("Windows in-place update error = %v", err)
	}
}
