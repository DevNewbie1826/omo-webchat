package session

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

const sessionTitleMaxRunes = 50

// DeriveSessionTitle mirrors the legacy engine's pure first-prompt title rule.
func DeriveSessionTitle(prompt string) string {
	prompt = strings.TrimSpace(prompt)
	if prompt == "" {
		return ""
	}
	if first, _ := utf8.DecodeRuneInString(prompt); first == '/' {
		return ""
	}
	title := collapseTitleWhitespace(stripLeadingTitleMarkdown(firstNonEmptyTitleLine(prompt)))
	title = clampTitleRunes(title, sessionTitleMaxRunes)
	return strings.TrimSpace(title)
}

func firstNonEmptyTitleLine(prompt string) string {
	for line := range strings.SplitSeq(prompt, "\n") {
		line = strings.TrimRight(line, "\r")
		if strings.TrimSpace(line) != "" {
			return line
		}
	}
	return ""
}

func stripLeadingTitleMarkdown(line string) string {
	for line != "" {
		r, size := utf8.DecodeRuneInString(line)
		if strings.ContainsRune("#>*-+`~ ", r) {
			line = line[size:]
			continue
		}
		i := 0
		for i < len(line) && line[i] >= '0' && line[i] <= '9' {
			i++
		}
		if i > 0 && i < len(line) && (line[i] == '.' || line[i] == ')') {
			line = line[i+1:]
			continue
		}
		break
	}
	return line
}

func collapseTitleWhitespace(value string) string {
	var b strings.Builder
	b.Grow(len(value))
	space := false
	for _, r := range value {
		if unicode.IsSpace(r) {
			if !space {
				b.WriteByte(' ')
				space = true
			}
			continue
		}
		b.WriteRune(r)
		space = false
	}
	return b.String()
}

func clampTitleRunes(value string, max int) string {
	runes := []rune(value)
	if len(runes) <= max {
		return value
	}
	return string(runes[:max]) + "…"
}
