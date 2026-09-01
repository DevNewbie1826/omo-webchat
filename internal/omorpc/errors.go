package omorpc

import (
	"errors"
	"fmt"
	"strings"
)

// Stable error codes returned by the agent in the "error" field of a
// success:false response envelope. These strings are part of the RPC
// contract and safe to branch on; everything else is free-form detail.
const (
	ErrCodeUnknownSession       = "unknown_session"
	ErrCodeSessionClosing       = "session_closing"
	ErrCodeSessionPathInUse     = "session_path_in_use"
	ErrCodeMissingSessionID     = "missing_session_id"
	ErrCodeMultiSessionDisabled = "multi_session_disabled"
	ErrCodeInvalidPath          = "invalid_path"
	// ErrCodeOpenFailed is a prefix code: the wire form is
	// "open_failed: <detail>", so it never travels as a bare token.
	ErrCodeOpenFailed = "open_failed"
)

// openFailedPrefix is the exact wire prefix of an open_failed error string.
const openFailedPrefix = ErrCodeOpenFailed + ":"

// StableError is a parsed stable error code from a failed response. Detail
// carries the free-form suffix of "open_failed: <detail>" and is empty for
// the six exact codes. Error() reproduces the original wire string.
type StableError struct {
	Code   string
	Detail string
}

func (e *StableError) Error() string {
	if e.Detail == "" {
		return e.Code
	}
	return openFailedPrefix + " " + e.Detail
}

// ParseStableError classifies a response "error" string. It reports the
// matched StableError for the six exact codes and for the open_failed prefix
// form (with or without the space before the detail); ok is false for any
// other string.
func ParseStableError(wire string) (*StableError, bool) {
	switch wire {
	case ErrCodeUnknownSession,
		ErrCodeSessionClosing,
		ErrCodeSessionPathInUse,
		ErrCodeMissingSessionID,
		ErrCodeMultiSessionDisabled,
		ErrCodeInvalidPath:
		return &StableError{Code: wire}, true
	}
	if strings.HasPrefix(wire, openFailedPrefix) {
		detail := strings.TrimPrefix(wire, openFailedPrefix)
		detail = strings.TrimLeft(detail, " ")
		return &StableError{Code: ErrCodeOpenFailed, Detail: detail}, true
	}
	return nil, false
}

// ErrorFromResponse maps a response envelope to an error: nil when success,
// a *StableError when the error string carries a stable code, and a plain
// error otherwise. It never returns a wrapped error, so errors.As against
// *StableError is reliable.
func ErrorFromResponse(resp *Response) error {
	if resp == nil || resp.Success {
		return nil
	}
	if se, ok := ParseStableError(resp.Error); ok {
		return se
	}
	return errors.New(resp.Error)
}

// Err reports the response's own error as an ErrorFromResponse mapping, so
// callers can write `if err := resp.Err(); err != nil`.
func (r *Response) Err() error { return ErrorFromResponse(r) }

// errMalformedFrames are decode-side failures; they are local protocol
// violations, never stable agent codes.
var errEmptyFrame = errors.New("omorpc: empty frame")

func errUnexpectedTail(err error) error {
	return fmt.Errorf("omorpc: truncated trailing record: %w", err)
}
