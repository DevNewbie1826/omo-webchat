package wsbridge

import (
	"encoding/json"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/session"
	"github.com/DevNewbie1826/omo-webchat/internal/wscontract"
)

// The per-object mapping no longer exists on sessions.activity. The retained
// chat activity digest still crosses this typed JSON boundary unchanged.
func TestTaskStateOrderingRetainedDigest(t *testing.T) {
	for _, raw := range []string{"", "running"} {
		name := "PIN_raw"
		if raw != "" {
			name = "derived"
		}
		t.Run(name, func(t *testing.T) {
			// Given either raw completion or a derived correction of a running revision.
			const stamp = "2026-09-07T10:02:00Z"
			digest := session.TaskDigest{Tasks: []session.TaskDigestEntry{{TaskID: "t", Status: "completed", RawStatus: raw, UpdatedAt: stamp}}, Truncated: true}
			// When the retained session digest is serialized through its actual codec.
			payload, err := json.Marshal(digest)
			if err != nil {
				t.Fatal(err)
			}
			var parsed wscontract.TaskDigest
			if err := json.Unmarshal(payload, &parsed); err != nil {
				t.Fatal(err)
			}
			// Then clock, effective status, provenance and partial disclosure survive.
			if len(parsed.Tasks) != 1 || !parsed.Truncated {
				t.Fatalf("digest lost: %s", payload)
			}
			row := parsed.Tasks[0]
			if row.UpdatedAt == nil || *row.UpdatedAt != stamp || row.Status != "completed" {
				t.Fatalf("authority lost: %s", payload)
			}
			if raw == "" {
				if row.RawStatus != nil {
					t.Fatalf("raw row invented provenance: %s", payload)
				}
			} else if row.RawStatus == nil || *row.RawStatus != raw {
				t.Fatalf("derived provenance lost: %s", payload)
			}
		})
	}
}
