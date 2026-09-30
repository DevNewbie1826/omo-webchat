package omorpc

import (
	"os"
	"path/filepath"
	"strings"
)

// CodingAgentDir returns the coding-agent state directory.
// Observed engine behavior - an explicit directory wins over the default,
// several legacy variable spellings are read with first nonblank winning,
// default is ~/.omo/agent.
func CodingAgentDir() string {
	for _, key := range []string{
		"OMO_CODING_AGENT_DIR",
		"SENPI_CODING_AGENT_DIR",
		"PI_CODING_AGENT_DIR",
	} {
		if v := strings.TrimSpace(os.Getenv(key)); v != "" {
			absolute, err := filepath.Abs(v)
			if err != nil {
				return ""
			}
			return absolute
		}
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".omo", "agent")
}
