package main

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/wscontract"
)

func TestQuestionRequestRoundTripsWhenStructured(t *testing.T) {
	// Given
	raw := `{"type":"approval","sessionId":"s","id":"ask","method":"question","questions":[{"id":"q1","header":"Stack","question":"Which stack?","multiSelect":true,"options":[{"label":"Go","description":"Backend"},{"label":"TS"}]},{"id":"q2","question":"Notes?"}]}`
	// When
	frame, err := wscontract.ParseServerFrame([]byte(raw))
	// Then
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.ValueOf(frame).Elem().FieldByName("Questions").IsValid() {
		t.Fatal("questions must be a typed contract field")
	}
	assertQuestionJSON(t, frame, raw)
}

func TestApprovalRoundTripsWhenQuestionFieldsAbsent(t *testing.T) {
	// Given
	raw := `{"type":"approval","sessionId":"s","id":"a","method":"select","options":["yes","no"],"title":"Confirm","timeout":30}`
	// When
	frame, err := wscontract.ParseServerFrame([]byte(raw))
	// Then
	if err != nil {
		t.Fatal(err)
	}
	assertQuestionJSON(t, frame, raw)
}

func TestQuestionResponseSerializesWhenAnswersKeyedByID(t *testing.T) {
	// Given
	raw := `{"type":"approval.respond","sessionId":"s","id":"ask","answers":{"q1":{"selected":["Go","TS"]},"q2":{"selected":[],"text":"custom"}},"comment":"overall"}`
	// When
	frame, err := wscontract.ParseClientFrame([]byte(raw))
	// Then
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.ValueOf(frame).Elem().FieldByName("Answers").IsValid() {
		t.Fatal("answers must be a typed contract field")
	}
	assertQuestionJSON(t, frame, raw)
}

func TestQuestionResponseRejectsWhenAnswerMalformed(t *testing.T) {
	// Given
	raw := `{"type":"approval.respond","sessionId":"s","id":"ask","answers":{"q1":{"selected":[42]}}}`
	// When
	_, err := wscontract.ParseClientFrame([]byte(raw))
	// Then
	if err == nil {
		t.Fatal("accepted malformed selected option")
	}
}

func assertQuestionJSON(t *testing.T, frame any, raw string) {
	t.Helper()
	encoded, err := json.Marshal(frame)
	if err != nil {
		t.Fatal(err)
	}
	var got, want any
	if err := json.Unmarshal(encoded, &got); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(raw), &want); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("round trip = %s, want %s", encoded, raw)
	}
}
