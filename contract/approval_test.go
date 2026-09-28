package main

import (
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/wscontract"
)

func TestApprovalFrameDeadlinesDecodeWithAndWithoutOptionalFields(t *testing.T) {
	tests := []struct {
		name             string
		data             string
		wantDeadlineAtMs *int64
		wantRemainingMs  *int64
	}{
		{
			name:             "with deadlines",
			data:             `{"type":"approval","sessionId":"s","id":"a","method":"confirm","deadlineAtMs":1700000000000,"remainingMs":2500}`,
			wantDeadlineAtMs: ptr(int64(1700000000000)),
			wantRemainingMs:  ptr(int64(2500)),
		},
		{name: "without deadlines", data: `{"type":"approval","sessionId":"s","id":"a","method":"confirm"}`},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			frame, err := wscontract.ParseServerFrame([]byte(tt.data))
			if err != nil {
				t.Fatalf("decode approval frame: %v", err)
			}
			approval, ok := frame.(*wscontract.ApprovalFrame)
			if !ok {
				t.Fatalf("decoded frame type = %T, want *ApprovalFrame", frame)
			}
			if !sameInt64Pointer(approval.DeadlineAtMs, tt.wantDeadlineAtMs) {
				t.Errorf("deadlineAtMs = %v, want %v", approval.DeadlineAtMs, tt.wantDeadlineAtMs)
			}
			if !sameInt64Pointer(approval.RemainingMs, tt.wantRemainingMs) {
				t.Errorf("remainingMs = %v, want %v", approval.RemainingMs, tt.wantRemainingMs)
			}
		})
	}
}

func TestQuestionDeliveryContractFields(t *testing.T) {
	frame, err := wscontract.ParseServerFrame([]byte(`{"type":"approval","sessionId":"s","id":"new-dialog","method":"question","requestId":"tool-1","delivery":"failed","deliveryError":"unconfirmed","submittedAnswer":{"answers":{"q1":{"selected":[],"text":"hello"}},"comment":"draft"}}`))
	if err != nil {
		t.Fatalf("decode question delivery: %v", err)
	}
	approval, ok := frame.(*wscontract.ApprovalFrame)
	if !ok || approval.RequestID == nil || *approval.RequestID != "tool-1" ||
		approval.Delivery == nil || *approval.Delivery != "failed" ||
		approval.SubmittedAnswer == nil || approval.SubmittedAnswer.Answers["q1"].Text == nil ||
		*approval.SubmittedAnswer.Answers["q1"].Text != "hello" {
		t.Fatalf("question delivery = %#v", frame)
	}
	for _, invalid := range []string{
		`{"type":"approval","sessionId":"s","id":"a","method":"question","delivery":"expired"}`,
		`{"type":"approval","sessionId":"s","id":"a","method":"question","submittedAnswer":{"comment":"draft"}}`,
	} {
		if _, err := wscontract.ParseServerFrame([]byte(invalid)); err == nil {
			t.Errorf("invalid delivery was accepted: %s", invalid)
		}
	}
}

func TestQuestionSnapshotAndProgressContract(t *testing.T) {
	snapshot, err := wscontract.ParseServerFrame([]byte(`{"type":"questions.snapshot","sessionId":"s","ids":["tool-1","dialog-2"]}`))
	if err != nil {
		t.Fatalf("decode snapshot: %v", err)
	}
	if frame, ok := snapshot.(*wscontract.QuestionsSnapshotFrame); !ok || len(frame.Ids) != 2 ||
		frame.Ids[0] != "tool-1" || frame.Ids[1] != "dialog-2" {
		t.Fatalf("snapshot = %#v", snapshot)
	}
	resolved, err := wscontract.ParseServerFrame([]byte(`{"type":"approval.resolved","sessionId":"s","id":"dialog-2","outcome":"closed_while_disconnected"}`))
	if err != nil {
		t.Fatalf("decode reconciled resolution: %v", err)
	}
	if frame, ok := resolved.(*wscontract.ApprovalResolvedFrame); !ok || frame.Outcome != "closed_while_disconnected" {
		t.Fatalf("reconciled resolution = %#v", resolved)
	}
	progress, err := wscontract.ParseClientFrame([]byte(`{"type":"approval.progress","sessionId":"s","id":"dialog-1","answers":{"q1":{"selected":[]}},"comment":"draft"}`))
	if err != nil {
		t.Fatalf("decode progress: %v", err)
	}
	if frame, ok := progress.(*wscontract.ApprovalProgressFrame); !ok || frame.Answers == nil || frame.Comment == nil ||
		*frame.Comment != "draft" {
		t.Fatalf("progress = %#v", progress)
	}
}

func ptr(value int64) *int64 { return &value }

func sameInt64Pointer(got, want *int64) bool {
	if got == nil || want == nil {
		return got == want
	}
	return *got == *want
}
