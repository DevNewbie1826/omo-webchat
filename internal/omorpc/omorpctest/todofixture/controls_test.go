package main

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestTodoFixtureControlsRejectForeignCoordinates(t *testing.T) {
	j, err := newJournal(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	h := (&controls{journal: j}).handler()
	for _, body := range []string{
		`{"entry":{"type":"custom","id":"foreign"},"persist":true}`,
		`{"entry":{"type":"custom"},"parent":"unknown","persist":true}`,
		`{"entry":{"type":"chat.todo"},"persist":true}`,
		`{"entry":{"type":"custom"},"path":"/outside"}`,
		`{} {}`,
	} {
		t.Run(body, func(t *testing.T) {
			before := len(j.entries)
			recorder := httptest.NewRecorder()
			h.ServeHTTP(recorder, httptest.NewRequest("POST", "/append", strings.NewReader(body)))
			if recorder.Code < 400 {
				t.Fatalf("accepted foreign control: %d %s", recorder.Code, recorder.Body.String())
			}
			if len(j.entries) != before {
				t.Fatal("rejected command changed canonical history")
			}
		})
	}
}
func TestTodoFixtureControlsPreserveMalformedCarrierAndClear(t *testing.T) {
	j, err := newJournal(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	h := (&controls{journal: j}).handler()
	for _, phases := range []string{`[{}]`, `[]`, `[{"name":"empty","tasks":[]}]`} {
		body := `{"entry":{"type":"custom","customType":"senpi.todo-state","data":{"schema":"v2","phases":` + phases + `}},"persist":true}`
		recorder := httptest.NewRecorder()
		h.ServeHTTP(recorder, httptest.NewRequest("POST", "/append", strings.NewReader(body)))
		if recorder.Code != 200 {
			t.Fatalf("source rejected before production parser: %d %s", recorder.Code, recorder.Body.String())
		}
		raw, err := json.Marshal(j.entries[len(j.entries)-1]["data"].(map[string]any)["phases"])
		if err != nil {
			t.Fatal(err)
		}
		if string(raw) != phases {
			t.Fatalf("fixture normalized carrier: got=%s want=%s", raw, phases)
		}
	}
}
func TestTodoFixtureDiskFailureRestoresSameIdentity(t *testing.T) {
	j, err := newJournal(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(j.path)
	if err != nil {
		t.Fatal(err)
	}
	h := (&controls{journal: j}).handler()
	for _, enabled := range []string{"true", "false"} {
		recorder := httptest.NewRecorder()
		h.ServeHTTP(recorder, httptest.NewRequest("POST", "/disk/failure", strings.NewReader(`{"enabled":`+enabled+`}`)))
		if recorder.Code != 200 {
			t.Fatalf("disk gate: %d %s", recorder.Code, recorder.Body.String())
		}
	}
	after, err := os.Stat(j.path)
	if err != nil {
		t.Fatal(err)
	}
	if !os.SameFile(before, after) {
		t.Fatal("read failure recovery changed session identity")
	}
}
func TestTodoFixtureReadFailureIsNotAbsence(t *testing.T) {
	j, err := newJournal(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	h := (&controls{journal: j}).handler()
	recorder := httptest.NewRecorder()
	h.ServeHTTP(recorder, httptest.NewRequest("POST", "/read/failure", strings.NewReader(`{"enabled":true}`)))
	if recorder.Code != 200 {
		t.Fatalf("read gate: %d", recorder.Code)
	}
	response, _ := j.response(map[string]any{"id": "failing"})
	if response["success"] != false || response["data"] != nil || response["error"] != "QA_READ_FAILURE" {
		t.Fatalf("read error became history: %v", response)
	}
}
