package chat

import "strings"

// EnsureExtensionEventsCapability is the single seam where the backend
// advertises extension-event support to the provider: the returned env's
// SENPI_RPC_CLIENT_CAPABILITIES list carries "extension_events". A preset
// list is comma-merged in place (no duplicate token); an absent or empty
// variable is set; later duplicate entries of the variable are dropped so
// the child process sees exactly one merged value.
func EnsureExtensionEventsCapability(env []string) []string {
	const key = "SENPI_RPC_CLIENT_CAPABILITIES"
	const capability = "extension_events"
	out := make([]string, 0, len(env)+1)
	merged := false
	for _, entry := range env {
		name, value, found := strings.Cut(entry, "=")
		if !found || name != key {
			out = append(out, entry)
			continue
		}
		if merged {
			continue
		}
		merged = true
		hasCapability := false
		for _, token := range strings.Split(value, ",") {
			if strings.TrimSpace(token) == capability {
				hasCapability = true
				break
			}
		}
		switch {
		case hasCapability:
			out = append(out, entry)
		case strings.TrimSpace(value) == "":
			out = append(out, key+"="+capability)
		default:
			out = append(out, key+"="+value+","+capability)
		}
	}
	if !merged {
		out = append(out, key+"="+capability)
	}
	return out
}
