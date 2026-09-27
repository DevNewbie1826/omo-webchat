package session

import "strings"

// EntryAppendedInfo identifies a persisted live message for v4 clients.
type EntryAppendedInfo struct {
	ID         string  `json:"id"`
	ParentID   *string `json:"parentId"`
	Role       string  `json:"role"`
	TextPrefix string  `json:"textPrefix"`
}

func messageEntryAppendedInfo(entry map[string]any) (EntryAppendedInfo, bool) {
	if entry["type"] != "message" {
		return EntryAppendedInfo{}, false
	}
	message, _ := entry["message"].(map[string]any)
	info := EntryAppendedInfo{
		ID:   stringValue(entry["id"]),
		Role: stringValue(message["role"]),
	}
	if parent, ok := entry["parentId"].(string); ok {
		info.ParentID = &parent
	}
	var text strings.Builder
	switch content := message["content"].(type) {
	case string:
		text.WriteString(content)
	case []any:
		for _, item := range content {
			block, ok := item.(map[string]any)
			if ok && block["type"] == "text" {
				text.WriteString(stringValue(block["text"]))
			}
		}
	}
	runes := []rune(text.String())
	if len(runes) > 128 {
		runes = runes[:128]
	}
	info.TextPrefix = string(runes)
	return info, true
}
