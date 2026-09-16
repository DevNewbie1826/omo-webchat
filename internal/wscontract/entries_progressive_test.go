package wscontract

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestEntriesFrameProgressiveHydrationRoundTrips(t *testing.T) {
	withBoth := []byte(`{"type":"entries","sessionId":"sess-1","entries":[],"final":false,"segment":"head","historyComplete":true}`)
	frame, err := ParseServerFrame(withBoth)
	assertRoundtrip(t, "entries-head", withBoth, frame, err)

	v := reflect.ValueOf(frame).Elem()
	segment := v.FieldByName("Segment")
	if !segment.IsValid() || segment.Kind() != reflect.Pointer || segment.IsNil() || segment.Elem().Kind() != reflect.String || segment.Elem().String() != "head" {
		t.Fatalf("typed segment lost at decode boundary: %+v", frame)
	}
	historyComplete := v.FieldByName("HistoryComplete")
	if !historyComplete.IsValid() || historyComplete.Kind() != reflect.Pointer || historyComplete.IsNil() || historyComplete.Elem().Kind() != reflect.Bool || historyComplete.Elem().Bool() != true {
		t.Fatalf("typed historyComplete lost at decode boundary: %+v", frame)
	}
	if extra, ok := v.FieldByName("ExtraFields").Interface().(map[string]json.RawMessage); ok {
		if _, leaked := extra["segment"]; leaked {
			t.Fatalf("segment leaked into ExtraFields: %+v", extra)
		}
		if _, leaked := extra["historyComplete"]; leaked {
			t.Fatalf("historyComplete leaked into ExtraFields: %+v", extra)
		}
	}

	without := []byte(`{"type":"entries","sessionId":"sess-1","entries":[],"final":true}`)
	absent, err := ParseServerFrame(without)
	assertRoundtrip(t, "entries-absent", without, absent, err)
	av := reflect.ValueOf(absent).Elem()
	if s := av.FieldByName("Segment"); s.IsValid() && !(s.Kind() == reflect.Pointer && s.IsNil()) {
		t.Fatalf("Segment must be absent, got %+v", s)
	}
	if h := av.FieldByName("HistoryComplete"); h.IsValid() && !(h.Kind() == reflect.Pointer && h.IsNil()) {
		t.Fatalf("HistoryComplete must be absent, got %+v", h)
	}
}
