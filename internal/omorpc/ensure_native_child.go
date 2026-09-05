package omorpc

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// windowsNativeChildContext carries the launcher's context through the native
// supervisor's brand scrub without inserting a process between it and its host.
// NODE_OPTIONS preloads run before the engine imports its brand configuration in
// both Node and Bun. The host consumes this one-hop handoff and restores the
// caller's NODE_OPTIONS before extensions or tools can spawn anything else.
func windowsNativeChildContext(cfg EnsureConfig) ([]string, string, error) {
	options, present := lookupEnv(cfg.Env, "NODE_OPTIONS")
	var original any
	if present {
		original = options
	}
	encoded, err := json.Marshal(original)
	if err != nil {
		return nil, "", err
	}
	file, err := os.CreateTemp(cfg.StateDir, ".daemon-child-*.cjs")
	if err != nil {
		return nil, "", err
	}
	path := file.Name()
	_, writeErr := fmt.Fprintf(file, windowsNativeChildPreload, encoded)
	err = file.Close()
	if writeErr != nil || err != nil {
		removeErr := os.Remove(path)
		return nil, "", errors.Join(writeErr, err, removeErr)
	}
	quoted, err := json.Marshal(filepath.ToSlash(path))
	if err != nil {
		return nil, "", errors.Join(err, os.Remove(path))
	}
	env := setEnv(cfg.Env, "NODE_OPTIONS", strings.TrimSpace(options+" --require="+string(quoted)))
	return env, path, nil
}

const windowsNativeChildPreload = `
const path = require("node:path");
const entry = (process.argv[1] || "").replaceAll("\\", "/");
if (/\/senpi\/dist\/cli(?:-main)?\.js$/.test(entry)) {
  const key = "OMO_WEBCHAT_RPC_LAUNCH_CONTEXT";
  const supervisor = process.argv.indexOf("--internal-rpc-host-supervisor");
  if (supervisor >= 0) {
    // Only the actual product launcher supplies these authoritative values.
    if (process.env.SENPI_BRAND && process.env.OMO_AGENT_TOOLKIT_BIN) {
      process.env[key] = JSON.stringify({brand: process.env.SENPI_BRAND,
        extension: path.join(path.dirname(path.dirname(process.env.OMO_AGENT_TOOLKIT_BIN)), "plugin")});
    }
    if (process.env[key]) {
      const context = JSON.parse(process.env[key]);
      const args = process.argv.slice(supervisor + 1);
      if (!args.some((arg, i) => arg === "--extension" && args[i + 1] === context.extension)) {
        process.argv.push("--extension", context.extension);
      }
    }
  } else if (process.env[key] && process.env.SENPI_RPC_HOST_WATCH_PPID &&
      process.argv.includes("--multi-session") && process.argv.includes("--listen")) {
    process.env.SENPI_BRAND = JSON.parse(process.env[key]).brand;
    delete process.env[key];
    const original = %s;
    if (original === null) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = original;
  }
}
`
