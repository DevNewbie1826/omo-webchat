package omorpc

import "testing"

func TestParseStableErrorPreservesAcceptedOpenFailedWireSpelling(t *testing.T) {
	tests := []struct {
		name   string
		wire   string
		detail string
	}{
		{name: "no-space", wire: "open_failed:no-space detail", detail: "no-space detail"},
		{name: "multiple-leading-space", wire: "open_failed:  multiple-space detail", detail: "multiple-space detail"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			se, ok := ParseStableError(tc.wire)
			if !ok {
				t.Fatalf("ParseStableError(%q) ok=false, want true", tc.wire)
			}
			if se.Code != ErrCodeOpenFailed {
				t.Fatalf("Code=%q, want %q", se.Code, ErrCodeOpenFailed)
			}
			if se.Detail != tc.detail {
				t.Fatalf("Detail=%q, want %q", se.Detail, tc.detail)
			}
			if se.Error() != tc.wire {
				t.Fatalf("Error()=%q, want exact wire %q", se.Error(), tc.wire)
			}
		})
	}
}

func TestConstructedStableErrorErrorUsesCanonicalSpace(t *testing.T) {
	se := &StableError{Code: ErrCodeOpenFailed, Detail: "constructed detail"}
	want := "open_failed: constructed detail"
	if se.Error() != want {
		t.Fatalf("Error()=%q, want %q", se.Error(), want)
	}
}
