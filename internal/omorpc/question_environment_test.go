//go:build unix || darwin || linux

package omorpc

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestClientCapabilitiesMatchHandshakeWhenEnvironmentMerged(t *testing.T) {
	// Given
	env := []string{"SENPI_RPC_CLIENT_CAPABILITIES=host_only,question,question", "OMO_RPC_CLIENT_CAPABILITIES=host_only"}
	// When
	merged := EnsureClientCapabilities(env)
	// Then
	for _, key := range []string{"SENPI_RPC_CLIENT_CAPABILITIES", "OMO_RPC_CLIENT_CAPABILITIES"} {
		value, _ := lookupEnv(merged, key)
		got := strings.Split(value, ",")
		want := append([]string{"host_only"}, clientHandshakeCapabilities()...)
		if len(got) != len(want) {
			t.Fatalf("%s = %v, want exactly %v", key, got, want)
		}
		for _, capability := range want {
			if !slices.Contains(got, capability) {
				t.Fatalf("%s lacks %q: %v", key, capability, got)
			}
		}
	}
}

func TestQuestionCapabilityPreservesHostValuesWhenSpawned(t *testing.T) {
	for _, tc := range []struct{ name, senpi, omo, want string }{
		{"empty", "", "", "extension_events,media_placeholders,question\nextension_events,media_placeholders,question"},
		{"host values", "custom_one,question, question,extension_events", "custom_two,media_placeholders,custom_two", "custom_one,question,extension_events,media_placeholders\ncustom_two,media_placeholders,extension_events,question"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// Given
			dir := shortEnsureTempDir(t)
			marker := filepath.Join(dir, "capabilities")
			script := writeFakeSupervisor(t, fmt.Sprintf("printf '%%s\\n%%s' \"$SENPI_RPC_CLIENT_CAPABILITIES\" \"$OMO_RPC_CLIENT_CAPABILITIES\" > %q\nexec \"$OMORPC_ENSURE_TEST_BINARY\" -test.run='^TestEnsureHelperProcess$'", marker))
			cfg := helperEnsureConfig(dir, filepath.Join(dir, "rpc.sock"), script, "serve")
			cfg.Env = setEnv(setEnv(cfg.Env, "SENPI_RPC_CLIENT_CAPABILITIES", tc.senpi), "OMO_RPC_CLIENT_CAPABILITIES", tc.omo)
			// When
			daemon, err := EnsureDaemon(t.Context(), cfg)
			if err != nil {
				t.Fatal(err)
			}
			defer stopEnsuredDaemons(t, []*EnsuredDaemon{daemon})
			// Then
			got, err := os.ReadFile(marker)
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != tc.want {
				t.Fatalf("spawned capabilities = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestQuestionCapabilityIsIdempotentWhenHostAlreadyAdvertises(t *testing.T) {
	// Given
	env := []string{"PATH=/bin", "SENPI_RPC_CLIENT_CAPABILITIES=question,custom,question", "OMO_RPC_CLIENT_CAPABILITIES=custom,question,question"}
	// When
	got := EnsureClientCapabilities(EnsureClientCapabilities(env))
	// Then
	for key, want := range map[string]string{
		"SENPI_RPC_CLIENT_CAPABILITIES": "question,custom,extension_events,media_placeholders",
		"OMO_RPC_CLIENT_CAPABILITIES":   "custom,question,extension_events,media_placeholders",
		"PATH":                          "/bin",
	} {
		if value, _ := lookupEnv(got, key); value != want {
			t.Fatalf("%s = %q, want %q", key, value, want)
		}
	}
}
