package store

import (
	"encoding/json"
	"strings"

	"github.com/DevNewbie1826/omo-webchat/internal/chat"
)

var (
	chatJSONKeys = map[string]bool{
		"id": true, "name": true, "pisessionid": true, "wsid": true, "cwd": true,
		"sessiondir": true, "provider": true, "model": true, "createdat": true,
		"lastusedat": true, "lastentryid": true, "activitysnapshot": true, "notices": true,
	}
	workspaceJSONKeys = map[string]bool{
		"id": true, "name": true, "path": true, "chats": true, "terminals": true,
	}
	stateJSONKeys = map[string]bool{"workspaces": true, "layout": true}
)

func unknownJSONFields(raw []byte, known map[string]bool) (map[string]json.RawMessage, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil, err
	}
	for key := range fields {
		if known[strings.ToLower(key)] {
			delete(fields, key)
		}
	}
	if len(fields) == 0 {
		return nil, nil
	}
	return fields, nil
}

func mergeUnknownJSONFields(base []byte, extra map[string]json.RawMessage, known map[string]bool) ([]byte, error) {
	if len(extra) == 0 {
		return base, nil
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(base, &fields); err != nil {
		return nil, err
	}
	for key, value := range extra {
		if known[strings.ToLower(key)] {
			continue
		}
		if _, exists := fields[key]; !exists {
			fields[key] = value
		}
	}
	return json.Marshal(fields)
}

func cloneRawMessage(raw json.RawMessage) json.RawMessage {
	if raw == nil {
		return nil
	}
	out := make(json.RawMessage, len(raw))
	copy(out, raw)
	return out
}

func cloneUnknownJSONFields(extra map[string]json.RawMessage) map[string]json.RawMessage {
	if extra == nil {
		return nil
	}
	out := make(map[string]json.RawMessage, len(extra))
	for key, value := range extra {
		out[key] = cloneRawMessage(value)
	}
	return out
}

func cloneChat(c Chat) Chat {
	c.Model = cloneRawMessage(c.Model)
	if c.ActivitySnapshot != nil {
		seed := c.ActivitySnapshot.Clone()
		c.ActivitySnapshot = &seed
	}
	if c.Notices != nil {
		c.Notices = cloneNotices(c.Notices)
	}
	c.extra = cloneUnknownJSONFields(c.extra)
	return c
}

func cloneNotices(records []chat.NoticeRecord) []chat.NoticeRecord {
	out := make([]chat.NoticeRecord, len(records))
	for i, rec := range records {
		out[i] = rec.Clone()
	}
	return out
}

func (c Chat) MarshalJSON() ([]byte, error) {
	type chatFields Chat
	base, err := json.Marshal(chatFields(c))
	if err != nil {
		return nil, err
	}
	return mergeUnknownJSONFields(base, c.extra, chatJSONKeys)
}

func (c *Chat) UnmarshalJSON(raw []byte) error {
	type chatFields Chat
	var fields chatFields
	if err := json.Unmarshal(raw, &fields); err != nil {
		return err
	}
	extra, err := unknownJSONFields(raw, chatJSONKeys)
	if err != nil {
		return err
	}
	*c = Chat(fields)
	if len(c.Notices) > 0 {
		valid := c.Notices[:0]
		for _, notice := range c.Notices {
			if notice.Kind == "" || notice.At.IsZero() || !validStoredNoticePayload(notice.Payload) {
				continue
			}
			valid = append(valid, notice)
		}
		c.Notices = valid
	}
	c.extra = extra
	return nil
}

func validStoredNoticePayload(raw json.RawMessage) bool {
	if len(raw) == 0 {
		return true
	}
	var payload map[string]json.RawMessage
	return json.Unmarshal(raw, &payload) == nil && payload != nil
}

func (ws Workspace) MarshalJSON() ([]byte, error) {
	type workspaceFields Workspace
	base, err := json.Marshal(workspaceFields(ws))
	if err != nil {
		return nil, err
	}
	return mergeUnknownJSONFields(base, ws.extra, workspaceJSONKeys)
}

func (ws *Workspace) UnmarshalJSON(raw []byte) error {
	type workspaceFields Workspace
	var fields workspaceFields
	if err := json.Unmarshal(raw, &fields); err != nil {
		return err
	}

	// terminals is the legacy pre-rename key for chats. Decode it eagerly,
	// preserving Load's previous validation behavior, but only use it when
	// chats is empty and never emit it beside the migrated chats field.
	var legacy struct {
		Terminals json.RawMessage `json:"terminals"`
	}
	if err := json.Unmarshal(raw, &legacy); err != nil {
		return err
	}
	if len(legacy.Terminals) > 0 {
		var terminals []Chat
		if err := json.Unmarshal(legacy.Terminals, &terminals); err != nil {
			return err
		}
		if len(fields.Chats) == 0 && len(terminals) > 0 {
			fields.Chats = terminals
		}
	}
	if fields.Chats == nil {
		fields.Chats = []Chat{}
	}

	extra, err := unknownJSONFields(raw, workspaceJSONKeys)
	if err != nil {
		return err
	}
	*ws = Workspace(fields)
	ws.extra = extra
	return nil
}

func (s state) MarshalJSON() ([]byte, error) {
	type stateFields state
	base, err := json.Marshal(stateFields(s))
	if err != nil {
		return nil, err
	}
	return mergeUnknownJSONFields(base, s.extra, stateJSONKeys)
}

func (s *state) UnmarshalJSON(raw []byte) error {
	type stateFields state
	var fields stateFields
	if err := json.Unmarshal(raw, &fields); err != nil {
		return err
	}
	if fields.Workspaces == nil {
		fields.Workspaces = []Workspace{}
	}
	extra, err := unknownJSONFields(raw, stateJSONKeys)
	if err != nil {
		return err
	}
	*s = state(fields)
	s.extra = extra
	return nil
}
