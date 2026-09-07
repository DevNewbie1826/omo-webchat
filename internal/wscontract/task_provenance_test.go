package wscontract

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestTaskProvenanceTypedBoundaryRoundtrip(t *testing.T) {
	// Given a webchat-derived correction of an unchanged raw task revision.
	const name = "server-sessions.activity-task-correction.json"
	data, err := os.ReadFile(filepath.Join(fixturesDir(t), name))
	if err != nil {
		t.Fatal(err)
	}

	// When the actual wire decoder projects it into its generated DTO.
	frame, err := ParseServerFrame(data)
	if err != nil {
		t.Fatal(err)
	}
	activity, ok := frame.(*SessionsActivityFrame)
	if !ok || activity.TaskDigest == nil || len(activity.TaskDigest.Tasks) != 1 {
		t.Fatalf("missing task membership: %#v", frame)
	}

	// Then provenance is a typed optional field, not merely opaque extras.
	// Reflection keeps RED executable against the pre-addition DTO.
	row := activity.TaskDigest.Tasks[0]
	raw := reflect.ValueOf(row).FieldByName("RawStatus")
	if !raw.IsValid() || raw.Kind() != reflect.Pointer || raw.IsNil() || raw.Elem().Kind() != reflect.String || raw.Elem().String() != "running" {
		t.Fatalf("typed raw_status lost at decode boundary: %+v", row)
	}
	if row.Status != "completed" || row.UpdatedAt == nil || *row.UpdatedAt != "2026-09-07T10:01:00Z" {
		t.Fatalf("effective status/raw clock changed: %+v", row)
	}
	assertRoundtrip(t, name, data, frame, nil)
}
