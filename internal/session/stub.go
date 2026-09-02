// Package session orchestrates durable chat sessions over one shared omorpc client.
package session

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

var (
	ErrNotImplemented       = errors.New("not implemented")
	ErrPromptInFlight       = errors.New("session: prompt in flight")
	ErrCompactionInFlight   = errors.New("session: compaction in flight")
	ErrSessionClosed        = errors.New("session: closed")
	ErrSessionResumable     = errors.New("session: provider session is resumable")
	ErrManagerClosed        = errors.New("session: manager closed")
	ErrSubscriberOverflow   = errors.New("session: subscriber queue overflow")
	ErrSubscriberDetached   = errors.New("session: subscriber detached")
	ErrSubscriberDelivery   = errors.New("session: subscriber delivery failed")
	ErrSubscriberSessionEnd = errors.New("session: subscriber session ended")
)

const (
	DefaultQueueSize    = 64
	DefaultIdleAfter    = 30 * time.Minute
	DefaultRetryAttempt = 3
	DefaultRetryBackoff = 500 * time.Millisecond
	DefaultCloseTimeout = 5 * time.Second
)

type Cursor struct {
	SessionFile      string
	DurableSessionID string
}

type CursorStore interface {
	CursorFor(context.Context, string) (Cursor, error)
	SaveCursor(context.Context, string, Cursor) error
}

type ChatRef interface {
	ChatID() string
	CWD() string
}

type Config struct {
	Client        *omorpc.Client
	Store         CursorStore
	IdleAfter     time.Duration
	QueueSize     int
	RetryAttempts int
	RetryBackoff  time.Duration
	CloseTimeout  time.Duration
	// OnDetach is called exactly once after a subscription pump exits.
	OnDetach func(Subscriber, error)
}

type FrameKind string

const (
	FrameReady           FrameKind = "ready"
	FrameRunStarted      FrameKind = "run.started"
	FrameRunDone         FrameKind = "run.done"
	FrameMessage         FrameKind = "message"
	FrameMessageDelta    FrameKind = "message.delta"
	FrameTool            FrameKind = "tool"
	FrameState           FrameKind = "state"
	FrameName            FrameKind = "name"
	FrameStats           FrameKind = "stats"
	FrameModels          FrameKind = "models"
	FrameCommands        FrameKind = "commands"
	FrameEntries         FrameKind = "entries"
	FrameCompactionStart FrameKind = "compaction.started"
	FrameCompactionDone  FrameKind = "compaction.done"
	FrameControlResult   FrameKind = "control.result"
	FrameAck             FrameKind = "ack"
	FrameApproval        FrameKind = "approval"
	FrameNotice          FrameKind = "notice"
	FrameExtensionEvent  FrameKind = "extensionEvent"
	FrameError           FrameKind = "error"
)

type ErrorInfo struct {
	Code             string
	Message          string
	Dangling         bool
	StoredIdentity   Cursor
	BranchCandidates []string
}

type EntriesFrame struct {
	Entries []json.RawMessage
	LeafID  string
	Final   bool
}

type RunInfo struct{ Reason string }
type CompactionInfo struct{ Phase, Error string }

type Frame struct {
	Kind       FrameKind
	SessionID  string
	Resumed    bool
	Command    string
	RequestID  string
	ApprovalID string
	Data       any
}

// Subscriber receives frames serially. Cancel must release any blocked
// Deliver call; session shutdown waits for the delivery pump to exit.
type Subscriber interface {
	Deliver(Frame)
	Cancel() error
}

type Summary struct {
	ChatID           string
	DurableSessionID string
	SessionFile      string
	CWD              string
	Active           bool
	Attachments      int
}

type Stats struct {
	Tokens             int64
	Cost, ContextUsage float64
}

// UnmarshalJSON normalizes the provider's structured statistics into the
// numeric v1 wire projection. Older numeric responses remain accepted.
func (s *Stats) UnmarshalJSON(data []byte) error {
	var raw struct {
		Tokens       json.RawMessage `json:"tokens"`
		Cost         float64         `json:"cost"`
		ContextUsage json.RawMessage `json:"contextUsage"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	s.Cost = raw.Cost
	if len(raw.Tokens) > 0 {
		if err := json.Unmarshal(raw.Tokens, &s.Tokens); err != nil {
			var tokens struct {
				Input, Output json.RawMessage
			}
			if err := json.Unmarshal(raw.Tokens, &tokens); err != nil {
				return err
			}
			s.Tokens = numericTokenCount(tokens.Input) + numericTokenCount(tokens.Output)
		}
	}
	if len(raw.ContextUsage) > 0 {
		if err := json.Unmarshal(raw.ContextUsage, &s.ContextUsage); err != nil {
			var usage struct {
				Used, Total           json.RawMessage
				Tokens, ContextWindow json.RawMessage
			}
			if err := json.Unmarshal(raw.ContextUsage, &usage); err != nil {
				return err
			}
			used, total := float64(numericTokenCount(usage.Used)), float64(numericTokenCount(usage.Total))
			if total > 0 {
				s.ContextUsage = used / total
			} else {
				tokens, window := float64(numericTokenCount(usage.Tokens)), float64(numericTokenCount(usage.ContextWindow))
				if window > 0 {
					s.ContextUsage = tokens / window
				}
			}
		}
	}
	return nil
}

func numericTokenCount(raw json.RawMessage) int64 {
	var number int64
	if json.Unmarshal(raw, &number) == nil {
		return number
	}
	var object map[string]json.RawMessage
	if json.Unmarshal(raw, &object) != nil {
		return 0
	}
	for _, key := range []string{"total", "tokens", "count"} {
		if value, ok := object[key]; ok {
			return numericTokenCount(value)
		}
	}
	var total int64
	for _, value := range object {
		total += numericTokenCount(value)
	}
	return total
}

type RunSnapshot struct {
	Streaming  bool
	Compacting bool
}

type Model struct{ Provider, ModelID, Name string }
type CommandSourceInfo struct {
	Path, BaseDir, Source, Scope, Origin string
}
type CommandInfo struct {
	Name, Description, Source, Syntax string
	SourceInfo                        *CommandSourceInfo
}
