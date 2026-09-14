package omorpc

// Media placeholders contract tests: the executable specification for the
// media_placeholders capability advertisement and the get_media command.
// These tests are RED until the client advertises the capability and can
// fetch a placeholder's media block.

import (
	"slices"
	"strings"
	"testing"
)

// TestEnsureMediaPlaceholdersAdvertisedInBothSpellings pins the capability
// advertisement: media_placeholders travels alongside extension_events in
// BOTH capability variables, after any capabilities the caller pre-seeded.
func TestEnsureMediaPlaceholdersAdvertisedInBothSpellings(t *testing.T) {
	env := EnsureExtensionEventsCapability([]string{
		"SENPI_RPC_CLIENT_CAPABILITIES=custom_one",
		"OMO_RPC_CLIENT_CAPABILITIES=custom_two,extension_events",
	})
	for key, want := range map[string]string{
		"SENPI_RPC_CLIENT_CAPABILITIES": "custom_one,extension_events,media_placeholders",
		"OMO_RPC_CLIENT_CAPABILITIES":   "custom_two,extension_events,media_placeholders",
	} {
		if got, _ := lookupEnv(env, key); got != want {
			t.Fatalf("%s = %q, want %q", key, got, want)
		}
	}

	// A bare environment still advertises the capability under both spellings.
	bare := EnsureExtensionEventsCapability([]string{"PATH=/bin"})
	for _, key := range []string{"SENPI_RPC_CLIENT_CAPABILITIES", "OMO_RPC_CLIENT_CAPABILITIES"} {
		got, _ := lookupEnv(bare, key)
		for _, capability := range []string{"extension_events", "media_placeholders"} {
			if !slices.Contains(strings.Split(got, ","), capability) {
				t.Fatalf("%s = %q, want to contain %s", key, got, capability)
			}
		}
	}
}

// TestEnsureMediaPlaceholdersIdempotentAndDedupe pins idempotence: applying
// the injection twice yields the same environment, and pre-seeded duplicate
// or padded entries collapse to one occurrence.
func TestEnsureMediaPlaceholdersIdempotentAndDedupe(t *testing.T) {
	env := EnsureExtensionEventsCapability([]string{
		"SENPI_RPC_CLIENT_CAPABILITIES=media_placeholders, , media_placeholders,extension_events",
		"OMO_RPC_CLIENT_CAPABILITIES=media_placeholders",
	})
	env = EnsureExtensionEventsCapability(env)
	for key, want := range map[string]string{
		"SENPI_RPC_CLIENT_CAPABILITIES": "media_placeholders,extension_events",
		"OMO_RPC_CLIENT_CAPABILITIES":   "media_placeholders,extension_events",
	} {
		if got, _ := lookupEnv(env, key); got != want {
			t.Fatalf("%s = %q, want %q", key, got, want)
		}
	}
}

// TestProtocolSetClientInfoWireShape pins the client handshake record's
// wire shape: the capability list serializes completely beside the render
// width. On the daemon path this record is the only capability
// advertisement a connecting client's peer reads.
func TestProtocolSetClientInfoWireShape(t *testing.T) {
	got, err := EncodeRequest("r1", SetClientInfo{
		Width:        80,
		Capabilities: []string{capExtensionEvents, capMediaPlaceholders},
	})
	if err != nil {
		t.Fatalf("EncodeRequest: %v", err)
	}
	want := `{"capabilities":["extension_events","media_placeholders"],"id":"r1","type":"set_client_info","width":80}` + "\n"
	if string(got) != want {
		t.Fatalf("wire mismatch\n got: %s\nwant: %s", got, want)
	}
}

// TestProtocolGetMediaRequestShape pins the get_media wire request: the
// command fields flatten beside id/type, and contentIndex serializes even
// when zero — the placeholder ref is positional, so an omitted index would
// change which block the engine resolves.
func TestProtocolGetMediaRequestShape(t *testing.T) {
	cases := []struct {
		name string
		cmd  Command
		want string
	}{
		{"zero_index", GetMedia{SessionID: "rpc-1", ToolCallID: "tool-9"}, `{"contentIndex":0,"id":"r1","sessionId":"rpc-1","toolCallId":"tool-9","type":"get_media"}`},
		{"index", GetMedia{SessionID: "rpc-1", ToolCallID: "tool-9", ContentIndex: 2}, `{"contentIndex":2,"id":"r1","sessionId":"rpc-1","toolCallId":"tool-9","type":"get_media"}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := EncodeRequest("r1", tc.cmd)
			if err != nil {
				t.Fatalf("EncodeRequest: %v", err)
			}
			if string(got) != tc.want+"\n" {
				t.Fatalf("wire mismatch\n got: %s\nwant: %s", got, tc.want+"\n")
			}
		})
	}
}
