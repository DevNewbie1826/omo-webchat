package chat

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

const sessionTitleMaxRunes = 50

func DeriveSessionTitle(prompt string) string {
	prompt = strings.TrimSpace(prompt)
	if prompt == "" {
		return ""
	}
	if first, _ := utf8.DecodeRuneInString(prompt); first == '/' {
		return ""
	}
	title := collapseWhitespace(stripLeadingMarkdown(firstNonEmptyLine(prompt)))
	title = clampRunes(title, sessionTitleMaxRunes)
	title = strings.TrimSpace(title)
	return title
}

func firstNonEmptyLine(prompt string) string {
	for line := range strings.SplitSeq(prompt, "\n") {
		line = strings.TrimRight(line, "\r")
		if strings.TrimSpace(line) != "" {
			return line
		}
	}
	return ""
}

func stripLeadingMarkdown(line string) string {
	for line != "" {
		r, size := utf8.DecodeRuneInString(line)
		if strings.ContainsRune("#>*-+`~ ", r) {
			line = line[size:]
			continue
		}
		if n := orderedListPrefixLen(line); n > 0 {
			line = line[n:]
			continue
		}
		break
	}
	return line
}

func orderedListPrefixLen(line string) int {
	i := 0
	for i < len(line) && line[i] >= '0' && line[i] <= '9' {
		i++
	}
	if i == 0 || i >= len(line) {
		return 0
	}
	if line[i] == '.' || line[i] == ')' {
		return i + 1
	}
	return 0
}

func collapseWhitespace(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	prevSpace := false
	for _, r := range s {
		if unicode.IsSpace(r) {
			if !prevSpace {
				b.WriteByte(' ')
				prevSpace = true
			}
			continue
		}
		b.WriteRune(r)
		prevSpace = false
	}
	return b.String()
}

func clampRunes(s string, max int) string {
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	return string(runes[:max]) + "…"
}
