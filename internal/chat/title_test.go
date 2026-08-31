package chat

import (
	"strings"
	"testing"
)

func Test_DeriveSessionTitle(t *testing.T) {
	cjk50 := strings.Repeat("字", 50)
	cjk60 := strings.Repeat("字", 60)
	tests := []struct {
		name   string
		prompt string
		want   string
	}{
		{"plain prompt uses first line", "Fix the login bug", "Fix the login bug"},
		{"slash command is empty", "/compact do stuff", ""},
		{"whitespace only is empty", "   \n\t  ", ""},
		{"heading markers stripped", "## Fix the login bug", "Fix the login bug"},
		{"bullet marker stripped", "- bullet item", "bullet item"},
		{"ordered list marker stripped", "1. step one", "step one"},
		{"blockquote marker stripped", "> quoted", "quoted"},
		{"backtick fence first line stripped", "```Fix the parser", "Fix the parser"},
		{"multi-line uses only line 1", "first line\nsecond line", "first line"},
		{"exactly 50 CJK runes unchanged", cjk50, cjk50},
		{"60 CJK runes clamped with ellipsis", cjk60, cjk50 + "…"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// When
			got := DeriveSessionTitle(tt.prompt)

			// Then
			if got != tt.want {
				t.Fatalf("DeriveSessionTitle(%q) = %q, want %q", tt.prompt, got, tt.want)
			}
		})
	}
}
