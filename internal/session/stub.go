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
	ErrOpenBusy             = errors.New("session: detached open limit reached")
	ErrSendBackpressure     = errors.New("session: detached mutation limit reached")
	ErrSubscriberOverflow   = errors.New("session: subscriber queue overflow")
	ErrSubscriberDetached   = errors.New("session: subscriber detached")
	ErrSubscriberDelivery   = errors.New("session: subscriber delivery failed")
	ErrSubscriberSessionEnd = errors.New("session: subscriber session ended")
)

const (
	DefaultQueueSize      = 64
	DefaultIdleAfter      = 30 * time.Minute
	DefaultRetryAttempt   = 3
	DefaultRetryBackoff   = 500 * time.Millisecond
	DefaultCloseTimeout   = 5 * time.Second
	DefaultHistoryTimeout = 2 * time.Minute
	// DefaultDetachedOpenLimit bounds RPC correlations and cleanup goroutines
	// retained by cancelled open_session calls across all chat IDs.
	DefaultDetachedOpenLimit = 32
	// DetachedMutationLimit bounds response correlations retained by one session.
	DetachedMutationLimit = 16
)

const (
	NameSourceAuto = "auto"
	NameSourceUser = "user"
)

type Cursor struct {
	SessionFile      string
	DurableSessionID string
	Name             string
	NameSource       string
	// TitleIsPlaceholder is true only for the pre-identity default name that
	// the first successful plain prompt may replace with a derived title.
	TitleIsPlaceholder bool
	InPlace            bool
	// WritePrepared reports that CursorForOpen completed the one-time work
	// required before provider initialization can mutate this session.
	WritePrepared bool
}

// WritePreparer is an optional cursor-store capability used for durable work
// that must complete before the first provider-side mutation of a chat.
type WritePreparer interface {
	PrepareWrite(context.Context, string) error
}

type CursorStore interface {
	// CursorForOpen may prepare persisted identity for a provider open. Manager
	// calls it only inside the per-chat flight, after attempting to attach an
	// existing live session.
	CursorForOpen(context.Context, string) (Cursor, error)
	// CursorFor is a read-only lookup used after a route has been established.
	CursorFor(context.Context, string) (Cursor, error)
	SaveCursor(context.Context, string, Cursor) error
	UpdateIdentity(ctx context.Context, chatID, sessionFile, durableID string) error
	UpdateName(ctx context.Context, chatID, name, source string) error
}

type ChatRef interface {
	ChatID() string
	CWD() string
}

type Config struct {
	Client            *omorpc.Client
	Store             CursorStore
	IdleAfter         time.Duration
	QueueSize         int
	RetryAttempts     int
	RetryBackoff      time.Duration
	CloseTimeout      time.Duration
	DetachedOpenLimit int
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
	KnownLeaf        string
	ObservedLeaf     string
}

// ResumeError reports a failed resume-only acquisition without falling back
// to a fresh session.
type ResumeError struct {
	Info  ErrorInfo
	Cause error
}

func (e *ResumeError) Error() string { return e.Info.Message }
func (e *ResumeError) Unwrap() error { return e.Cause }

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
	Phase      string
	ApprovalID string
	Data       any
}

// Subscriber receives frames serially. Cancel must release any blocked
// Deliver call; session shutdown waits for the delivery pump to exit.
type Subscriber interface {
	Deliver(Frame)
	Cancel() error
}

// SynchronousAttachHook marks subscribers that must observe the complete
// attach-time replay before Manager.Acquire returns.
type SynchronousAttachHook interface {
	SynchronousAttach()
}

type Summary struct {
	ChatID            string
	DurableSessionID  string
	ReplacesSessionID string
	SessionFile       string
	CWD               string
	Active            bool
	Attachments       int
	Title             string
	ActivityPair      ActivityPair
	TaskOversized     bool
	DagOversized      bool
	TaskDigest        *TaskDigest
	DagDigest         *DagDigest
}

// Stats preserves provider statistics verbatim so structured token/cache data
// reaches frontend consumers without a lossy numeric projection.
type Stats struct {
	Tokens       json.RawMessage `json:"tokens,omitempty"`
	Cost         float64         `json:"cost,omitempty"`
	ContextUsage json.RawMessage `json:"contextUsage,omitempty"`
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
