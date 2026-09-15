package main

import (
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/wscontract"
)

func TestApprovalFrameDeadlinesDecodeWithAndWithoutOptionalFields(t *testing.T) {
	tests := []struct {
		name                  string
		data                  string
		wantDeadlineAtMs      *int64
		wantRemainingMs       *int64
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

func ptr(value int64) *int64 { return &value }

func sameInt64Pointer(got, want *int64) bool {
	if got == nil || want == nil {
		return got == want
	}
	return *got == *want
}
