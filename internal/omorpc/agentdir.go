package omorpc

import (
	"os"
	"path/filepath"
)

// CodingAgentDir returns the coding-agent state directory.
// Observed engine behavior - an explicit directory wins over the default,
// several legacy variable spellings are read with first defined winning,
// default is ~/.omo/agent.
func CodingAgentDir() string {
	for _, key := range []string{
		"OMO_CODING_AGENT_DIR",
		"SENPI_CODING_AGENT_DIR",
		"PI_CODING_AGENT_DIR",
	} {
		if v := os.Getenv(key); v != "" {
			return v
		}
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".omo", "agent")
}
