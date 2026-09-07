package wsbridge

import (
	"encoding/json"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/session"
	"github.com/DevNewbie1826/omo-webchat/internal/wscontract"
)

func TestTaskStateOrderingOverviewFrame(t *testing.T) {
	for _, raw := range []string{"", "running"} {
		name := "PIN_raw"
		if raw != "" {
			name = "derived"
		}
		t.Run(name, func(t *testing.T) {
			const stamp = "2026-09-07T10:02:00Z"
			summary := session.Summary{ChatID: "chat", DurableSessionID: "durable", TaskOversized: true, TaskDigest: &session.TaskDigest{Tasks: []session.TaskDigestEntry{{TaskID: "t", Status: "completed", RawStatus: raw, UpdatedAt: stamp}}, Truncated: true}}
			payload, err := json.Marshal(activityFrame(summary, false))
			if err != nil {
				t.Fatal(err)
			}
			parsed, err := wscontract.ParseServerFrame(payload)
			if err != nil {
				t.Fatal(err)
			}
			frame, ok := parsed.(*wscontract.SessionsActivityFrame)
			if !ok {
				t.Fatalf("frame type %T", parsed)
			}
			if frame.TaskDigest == nil || len(frame.TaskDigest.Tasks) != 1 {
				t.Fatalf("digest lost: %s", payload)
			}
			row := frame.TaskDigest.Tasks[0]
			if row.UpdatedAt == nil || *row.UpdatedAt != stamp || row.Status != "completed" {
				t.Fatalf("authority lost: %s", payload)
			}
			if raw == "" {
				if row.RawStatus != nil {
					t.Fatalf("raw row invented provenance: %s", payload)
				}
			} else if row.RawStatus == nil || *row.RawStatus != raw {
				t.Fatalf("overview mapper lost derived provenance: %s", payload)
			}
			if !frame.TaskDigest.Truncated || len(frame.Snapshots) != 1 || !frame.Snapshots[0].Oversized {
				t.Fatalf("partial disclosure lost: %s", payload)
			}
		})
	}
}
