package omorpc

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCodingAgentDirPrecedence(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	def := filepath.Join(home, ".omo", "agent")
	omoDir := filepath.Join(t.TempDir(), "omo-agent")
	senpiDir := filepath.Join(t.TempDir(), "senpi-agent")
	piDir := filepath.Join(t.TempDir(), "pi-agent")
	for _, dir := range []string{omoDir, senpiDir, piDir} {
		if dir == def {
			t.Fatalf("fixture path %q equals default", dir)
		}
	}

	for _, tc := range []struct {
		name  string
		omo   string
		senpi string
		pi    string
		want  string
	}{
		{name: "only PI_", pi: piDir, want: piDir},
		{name: "only SENPI_", senpi: senpiDir, want: senpiDir},
		{name: "OMO_+SENPI_", omo: omoDir, senpi: senpiDir, want: omoDir},
		{name: "OMO_+SENPI_+PI_", omo: omoDir, senpi: senpiDir, pi: piDir, want: omoDir},
		{name: "none", want: def},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("OMO_CODING_AGENT_DIR", tc.omo)
			t.Setenv("SENPI_CODING_AGENT_DIR", tc.senpi)
			t.Setenv("PI_CODING_AGENT_DIR", tc.pi)
			if got := CodingAgentDir(); got != tc.want {
				t.Fatalf("CodingAgentDir() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestNormalizeEnsureConfigPinsAgentDirEnv(t *testing.T) {
	t.Run("empty AgentDir honors SENPI_", func(t *testing.T) {
		dir := filepath.Join(t.TempDir(), "senpi-only")
		t.Setenv("OMO_CODING_AGENT_DIR", "")
		t.Setenv("SENPI_CODING_AGENT_DIR", dir)
		t.Setenv("PI_CODING_AGENT_DIR", "")
		cfg, err := normalizeEnsureConfig(EnsureConfig{Env: []string{"PATH=/usr/bin"}, AgentDir: ""})
		if err != nil {
			t.Fatal(err)
		}
		if cfg.AgentDir != dir {
			t.Fatalf("AgentDir = %q, want %q", cfg.AgentDir, dir)
		}
		assertSingleAgentDirPin(t, cfg.Env, dir)
		if got, ok := lookupEnv(cfg.Env, "PATH"); !ok || got != "/usr/bin" {
			t.Fatalf("PATH = %q present=%v, want /usr/bin", got, ok)
		}
	})

	t.Run("explicit AgentDir pins OMO_", func(t *testing.T) {
		t.Setenv("OMO_CODING_AGENT_DIR", "")
		t.Setenv("SENPI_CODING_AGENT_DIR", "")
		t.Setenv("PI_CODING_AGENT_DIR", "")
		cfg, err := normalizeEnsureConfig(EnsureConfig{AgentDir: "/tmp/pin-x", Env: []string{}})
		if err != nil {
			t.Fatal(err)
		}
		assertSingleAgentDirPin(t, cfg.Env, "/tmp/pin-x")
	})

	t.Run("nil Env is process env plus pin", func(t *testing.T) {
		t.Setenv("OMO_CODING_AGENT_DIR", "")
		t.Setenv("SENPI_CODING_AGENT_DIR", "")
		t.Setenv("PI_CODING_AGENT_DIR", "")
		t.Setenv("OMORPC_AGENTDIR_MARKER", "keep")
		cfg, err := normalizeEnsureConfig(EnsureConfig{})
		if err != nil {
			t.Fatal(err)
		}
		if cfg.AgentDir == "" {
			t.Fatal("AgentDir empty")
		}
		assertSingleAgentDirPin(t, cfg.Env, cfg.AgentDir)
		if got, ok := lookupEnv(cfg.Env, "OMORPC_AGENTDIR_MARKER"); !ok || got != "keep" {
			t.Fatalf("marker = %q present=%v, want keep from process env", got, ok)
		}
	})
}

func assertSingleAgentDirPin(t *testing.T, env []string, want string) {
	t.Helper()
	var values []string
	for _, entry := range env {
		name, value, found := strings.Cut(entry, "=")
		if found && name == "OMO_CODING_AGENT_DIR" {
			values = append(values, value)
		}
	}
	if len(values) != 1 || values[0] != want {
		t.Fatalf("OMO_CODING_AGENT_DIR entries = %q, want exactly [%q]", values, want)
	}
}
