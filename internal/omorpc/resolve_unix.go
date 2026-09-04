//go:build darwin || linux

package omorpc

import (
	"fmt"
	"os/exec"
)

// resolveOmoBinary preserves the unix supervisor contract: cfgPath resolves
// through exec.LookPath with no platform candidate scan.
func resolveOmoBinary(cfgPath string) (string, error) {
	binary, err := exec.LookPath(cfgPath)
	if err != nil {
		return "", fmt.Errorf("omorpc: resolve supervisor %q: %w", cfgPath, err)
	}
	return binary, nil
}
