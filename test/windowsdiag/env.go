package main

import (
	"os"
	"runtime"
	"strings"
)

func isolatedEnv(home, agent string) []string {
	// HOME is POSIX getpwuid/getenv; USERPROFILE is Win32
	// GetUserProfileDirectoryW. Both are pointed at the temp tree so the
	// runner profile is not written. OMO_/SENPI_ CODING_AGENT_DIR are the
	// agent-dir overrides referenced by normalizeEnsureConfig and
	// session.CodingAgentDir. Capability env matches EnsureExtensionEventsCapability.
	env := os.Environ()
	env = setEnv(env, "HOME", home)
	env = setEnv(env, "USERPROFILE", home)
	env = setEnv(env, "OMO_CODING_AGENT_DIR", agent)
	env = setEnv(env, "SENPI_CODING_AGENT_DIR", agent)
	env = setEnv(env, "SENPI_RPC_CLIENT_CAPABILITIES", "extension_events")
	env = setEnv(env, "OMO_RPC_CLIENT_CAPABILITIES", "extension_events")
	return env
}

func setEnv(env []string, key, value string) []string {
	out := make([]string, 0, len(env)+1)
	for _, kv := range env {
		if envKeyMatch(kv, key) {
			continue
		}
		out = append(out, kv)
	}
	return append(out, key+"="+value)
}

func envKeyMatch(kv, key string) bool {
	if len(kv) < len(key)+1 || kv[len(key)] != '=' {
		return false
	}
	got := kv[:len(key)]
	if runtime.GOOS == "windows" {
		return strings.EqualFold(got, key)
	}
	return got == key
}
