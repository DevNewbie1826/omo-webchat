package wsbridge

import (
	"encoding/json"
	"strconv"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/session"
)

func TestAttachedRevisionMappingRejectsProviderAuthority(t *testing.T) {
	for _, revision := range []int64{0, 42} {
		t.Run(strconv.FormatInt(revision, 10), func(t *testing.T) {
			// Given provider payload attempting to spoof server provenance.
			frame := session.Frame{
				Kind: session.FrameExtensionEvent, BindingID: "server-binding",
				Data: map[string]any{"name": "omo.dag.activity", "revision": 999999, "bindingId": "spoofed"},
			}
			raw, err := json.Marshal(map[string]any{"Revision": revision})
			if err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(raw, &frame); err != nil {
				t.Fatal(err)
			}
			// When delivery occurs later, only the frozen frame owns authority.
			mapped, err := mapFrame(frame, "chat", false)
			if err != nil {
				t.Fatal(err)
			}
			out := mapped.(map[string]any)
			// Then zero stays optional and a server revision replaces spoofing.
			if revision == 0 {
				if _, exists := out["revision"]; exists {
					t.Fatalf("provider revision escaped: %v", out)
				}
			} else if out["revision"] != revision {
				t.Fatalf("production revision lost: %v", out)
			}
			if out["bindingId"] != "server-binding" {
				t.Fatalf("binding provenance changed: %v", out)
			}
		})
	}
}
