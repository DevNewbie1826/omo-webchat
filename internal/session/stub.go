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
	ErrNotImplemented     = errors.New("not implemented")
	ErrPromptInFlight     = errors.New("session: prompt in flight")
	ErrCompactionInFlight = errors.New("session: compaction in flight")
)

const (
	DefaultQueueSize    = 64
	DefaultIdleAfter    = 30 * time.Minute
	DefaultRetryAttempt = 3
	DefaultRetryBackoff = 500 * time.Millisecond
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
	Kind      FrameKind
	SessionID string
	Resumed   bool
	Command   string
	RequestID string
	Data      any
}

type Subscriber interface{ Deliver(Frame) }

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
type Model struct{ Provider, ModelID, Name string }
type CommandInfo struct{ Name, Description, Source, Syntax, SourceInfo string }
