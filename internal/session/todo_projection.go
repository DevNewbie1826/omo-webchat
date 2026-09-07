package session

import (
	"encoding/json"
	"errors"

	"github.com/DevNewbie1826/omo-webchat/internal/coldhistory"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

var ErrInvalidTodoState = errors.New("invalid canonical todo state")
var ErrTodoProjectionOversized = errors.New("canonical todo state exceeds budget")

// TodoPhase is an atomic whole-list member, not a text-keyed merge unit.
type TodoPhase struct {
	Name  string     `json:"name"`
	Tasks []TodoTask `json:"tasks"`
}
type TodoTask struct {
	Content string `json:"content"`
	Status  string `json:"status"`
}
type TodoSource struct {
	LeafID     *string `json:"leafId"`
	EntryID    *string `json:"entryId"`
	EntryIndex *int    `json:"entryIndex"`
	Kind       string  `json:"kind"`
}

// TodoProjection is returned only for a complete, fenced selected-branch read.
// Nil Phases proves absence; a nonnil empty slice is an intentional clear.
// Diagnostics flags invalid carriers without retaining unbounded record IDs.
type TodoProjection struct {
	Source      TodoSource  `json:"source"`
	Phases      []TodoPhase `json:"phases"`
	Diagnostics []string    `json:"diagnostics,omitempty"`
}

// TodoProjectionErrorCode classifies unavailable reads for the chat.todo wire.
func TodoProjectionErrorCode(err error) string {
	switch {
	case errors.Is(err, ErrTodoProjectionOversized), errors.Is(err, omorpc.ErrFrameTooLarge), errors.Is(err, coldhistory.ErrLineTooLong), errors.Is(err, coldhistory.ErrIndexBudgetExceeded):
		return "oversized"
	case errors.Is(err, ErrInvalidTodoState):
		return "invalid-state"
	default:
		return "history-unavailable"
	}
}

type todoFold struct {
	custom, legacy         TodoProjection
	customSeen, legacySeen bool
	invalid                bool
	customErr, legacyErr   error
}

func (f *todoFold) consume(metadata coldhistory.Metadata, page coldhistory.Page) error {
	for i, raw := range page.Entries {
		var entry struct {
			ID         string          `json:"id"`
			Type       string          `json:"type"`
			CustomType string          `json:"customType"`
			Data       json.RawMessage `json:"data"`
			ToolName   string          `json:"toolName"`
			Details    json.RawMessage `json:"details"`
			Result     struct {
				Details json.RawMessage `json:"details"`
			} `json:"result"`
			Message struct {
				ToolName string          `json:"toolName"`
				Details  json.RawMessage `json:"details"`
			} `json:"message"`
		}
		// Other transcript domains can carry arbitrary result/message shapes.
		// Decode only envelope coordinates first, then the candidate carrier.
		var envelope struct {
			ID, Type, CustomType string
			ToolName             string
			Message              json.RawMessage
		}
		if err := json.Unmarshal(raw, &envelope); err != nil {
			return err
		}
		custom := envelope.Type == "custom" && envelope.CustomType == "senpi.todo-state"
		if !custom && envelope.ToolName != "todo" {
			var message struct{ ToolName string }
			if json.Unmarshal(envelope.Message, &message) != nil || message.ToolName != "todo" {
				continue
			}
		}
		kind := "legacy-tool"
		if custom {
			f.customSeen = true
			kind = "custom"
		} else {
			f.legacySeen = true
		}
		parseErr := json.Unmarshal(raw, &entry)
		data := entry.Details
		if entry.Result.Details != nil {
			data = entry.Result.Details
		}
		if entry.Message.ToolName == "todo" {
			data = entry.Message.Details
		}
		if custom {
			data = entry.Data
		}
		var phases []TodoPhase
		if parseErr == nil {
			phases, parseErr = parseTodoPhases(data, custom)
		}
		if parseErr != nil {
			f.invalid = true
			if custom {
				f.customErr = parseErr
				if errors.Is(parseErr, ErrTodoProjectionOversized) {
					f.custom = TodoProjection{}
				}
			} else {
				f.legacyErr = parseErr
				if errors.Is(parseErr, ErrTodoProjectionOversized) {
					f.legacy = TodoProjection{}
				}
			}
			continue
		}
		index := page.Start + i
		candidate := TodoProjection{Source: TodoSource{EntryID: &entry.ID, EntryIndex: &index, Kind: kind}, Phases: phases}
		if custom {
			f.custom = candidate
		} else {
			f.legacy = candidate
		}
	}
	return nil
}

func (f *todoFold) finish(leaf string) (TodoProjection, error) {
	out := TodoProjection{Source: TodoSource{Kind: "absent"}}
	switch {
	case f.customSeen:
		if f.custom.Source.EntryID == nil {
			return TodoProjection{}, f.customErr
		}
		out = f.custom
	case f.legacySeen:
		if f.legacy.Source.EntryID == nil {
			return TodoProjection{}, f.legacyErr
		}
		out = f.legacy
	}
	if leaf != "" {
		out.Source.LeafID = &leaf
	}
	if f.invalid {
		out.Diagnostics = []string{"invalid-carrier"}
	}
	encoded, err := json.Marshal(out)
	if err != nil {
		return TodoProjection{}, err
	}
	if len(encoded) > maxActivitySnapshotBytes {
		return TodoProjection{}, ErrTodoProjectionOversized
	}
	return out, nil
}

func parseTodoPhases(raw json.RawMessage, custom bool) ([]TodoPhase, error) {
	var wire struct {
		Schema json.RawMessage
		Phases json.RawMessage
	}
	if json.Unmarshal(raw, &wire) != nil {
		return nil, ErrInvalidTodoState
	}
	if custom {
		var schema string
		if json.Unmarshal(wire.Schema, &schema) != nil || schema != "v2" {
			return nil, ErrInvalidTodoState
		}
	}
	if len(wire.Phases) > maxActivitySnapshotBytes {
		return nil, ErrTodoProjectionOversized
	}
	var phases []struct {
		Name  *string
		Tasks []struct {
			Content *string
			Status  string
		}
	}
	if json.Unmarshal(wire.Phases, &phases) != nil || phases == nil {
		return nil, ErrInvalidTodoState
	}
	out := make([]TodoPhase, 0, len(phases))
	for _, p := range phases {
		if p.Name == nil || p.Tasks == nil {
			return nil, ErrInvalidTodoState
		}
		phase := TodoPhase{Name: *p.Name, Tasks: make([]TodoTask, 0, len(p.Tasks))}
		for _, task := range p.Tasks {
			if task.Content == nil {
				return nil, ErrInvalidTodoState
			}
			switch task.Status {
			case "pending", "in_progress", "completed", "abandoned":
			default:
				return nil, ErrInvalidTodoState
			}
			phase.Tasks = append(phase.Tasks, TodoTask{Content: *task.Content, Status: task.Status})
		}
		out = append(out, phase)
	}
	return out, nil
}
