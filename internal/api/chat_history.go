package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"github.com/DevNewbie1826/omo-webchat/internal/coldhistory"
	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
)

const (
	// historyDefaultLimit is the page size used when the request omits limit.
	historyDefaultLimit = 100
	// historyMaxLimit is the largest page a client may request. Pages are
	// additionally bounded by coldhistory's default 4 MB PageBytes.
	historyMaxLimit = 100
	// historyMaxConcurrentReads bounds cold-session reads server-wide so a
	// burst of scroll-up loads cannot monopolize disk and memory.
	historyMaxConcurrentReads = 4
	// historyMaxFlightRedrives bounds how often a coalesced waiter may take
	// over a read whose leader vanished before finishing.
	historyMaxFlightRedrives = 3
)

// errHistoryBusy reports that no read slot became available before the
// request context ended. It is leader-scoped: coalesced waiters redrive the
// read instead of inheriting it.
var errHistoryBusy = errors.New("history read busy")

// historyReadSlots is the server-wide read limiter. The api package owns one
// Server per process, so package scope is server scope; every acquisition is
// paired with exactly one release.
var historyReadSlots = make(chan struct{}, historyMaxConcurrentReads)

// acquireHistoryReadSlot blocks until a read slot is free or ctx ends. A
// request whose context is already dead never starts a read.
func acquireHistoryReadSlot(ctx context.Context) (release func(), ok bool) {
	if ctx.Err() != nil {
		return nil, false
	}
	select {
	case historyReadSlots <- struct{}{}:
		return func() { <-historyReadSlots }, true
	case <-ctx.Done():
		return nil, false
	}
}

// historyFlightKey identifies one identical in-flight page read. The path is
// cleaned (not symlink-resolved) so trivial spelling variants coalesce while
// different files never do.
type historyFlightKey struct {
	path   string
	before string
	limit  int
}

// historyReadResult is the completed outcome shared with coalesced waiters.
type historyReadResult struct {
	sessionID       string
	entries         []json.RawMessage
	historyComplete bool
}

type historyFlight struct {
	done   chan struct{}
	result historyReadResult
	err    error
}

var historyFlights = struct {
	mu sync.Mutex
	m  map[historyFlightKey]*historyFlight
}{m: make(map[historyFlightKey]*historyFlight)}

// historyRedrivable reports whether a flight error describes the leader's own
// request dying rather than the read itself failing: a waiter with a live
// context can take over and drive the read to completion.
func historyRedrivable(err error) bool {
	if err == nil {
		return false
	}
	return errors.Is(err, errHistoryBusy) ||
		errors.Is(err, context.Canceled) ||
		errors.Is(err, context.DeadlineExceeded)
}

// doHistoryRead coalesces identical in-flight reads singleflight-style: the
// first caller drives read, later callers with the same key wait for its
// outcome instead of double-reading the session file. If the leader's request
// context ends first, a waiter with a live context redrives the read.
func doHistoryRead(ctx context.Context, key historyFlightKey, read func(context.Context) (historyReadResult, error)) (historyReadResult, error) {
	for redrive := 0; ; redrive++ {
		historyFlights.mu.Lock()
		if existing, active := historyFlights.m[key]; active {
			historyFlights.mu.Unlock()
			select {
			case <-existing.done:
				if historyRedrivable(existing.err) && ctx.Err() == nil && redrive < historyMaxFlightRedrives {
					continue
				}
				return existing.result, existing.err
			case <-ctx.Done():
				return historyReadResult{}, ctx.Err()
			}
		}
		flight := &historyFlight{done: make(chan struct{})}
		historyFlights.m[key] = flight
		historyFlights.mu.Unlock()

		result, err := read(ctx)

		historyFlights.mu.Lock()
		if historyFlights.m[key] == flight {
			delete(historyFlights.m, key)
		}
		historyFlights.mu.Unlock()
		flight.result, flight.err = result, err
		close(flight.done)
		return result, err
	}
}

// parseHistoryLimit resolves the limit query parameter: absent selects the
// default, any other value clamps into [1, historyMaxLimit], and only
// non-numeric input is rejected.
func parseHistoryLimit(raw string) (int, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return historyDefaultLimit, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return 0, err
	}
	if n < 1 {
		return 1, nil
	}
	if n > historyMaxLimit {
		return historyMaxLimit, nil
	}
	return n, nil
}

type historyResponse struct {
	SessionID       string          `json:"sessionId"`
	Entries         json.RawMessage `json:"entries"`
	HistoryComplete bool            `json:"historyComplete"`
}

// newHistoryResponse assembles the wire page. Entries is always a JSON array,
// including the empty page before a root cursor.
func newHistoryResponse(result historyReadResult) (historyResponse, error) {
	entries := result.entries
	if entries == nil {
		entries = []json.RawMessage{}
	}
	raw, err := json.Marshal(entries)
	if err != nil {
		return historyResponse{}, err
	}
	return historyResponse{SessionID: result.sessionID, Entries: raw, HistoryComplete: result.historyComplete}, nil
}

// readHistoryPage is the coalesced read closure: one bounded cold read under
// the server-wide limiter.
func (s *Server) readHistoryPage(sessionPath, before string, limit int) func(context.Context) (historyReadResult, error) {
	return func(ctx context.Context) (historyReadResult, error) {
		release, ok := acquireHistoryReadSlot(ctx)
		if !ok {
			return historyReadResult{}, errHistoryBusy
		}
		defer release()
		metadata, page, err := coldhistory.StreamBefore(ctx, sessionPath, coldhistory.Options{}, before, limit)
		if err != nil {
			return historyReadResult{}, err
		}
		entries := page.Entries
		if entries == nil {
			entries = []json.RawMessage{}
		}
		return historyReadResult{sessionID: metadata.Header.ID, entries: entries, historyComplete: page.HistoryComplete}, nil
	}
}

// handleGetChatHistory serves GET /api/workspaces/{wsId}/chats/{chatId}/history
// with query parameters session (durable session id), before (entry id), and
// an optional limit. Statuses: 200 page; 400 missing session/before or a
// non-numeric limit; 401 via middleware; 404 unknown workspace/chat,
// cross-workspace chat, unconfined cwd, or a missing session file; 409
// history_cursor_stale when session is stale, before is off the active
// branch, or the live session is quarantined by an external write; 503
// history_busy when no read slot freed before the request context ended.
func (s *Server) handleGetChatHistory(w http.ResponseWriter, r *http.Request) {
	sessionParam := strings.TrimSpace(r.URL.Query().Get("session"))
	before := strings.TrimSpace(r.URL.Query().Get("before"))
	if sessionParam == "" || before == "" {
		writeError(w, http.StatusBadRequest, "missing session or before")
		return
	}
	limit, err := parseHistoryLimit(r.URL.Query().Get("limit"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid limit")
		return
	}

	workspace, err := s.cursors.GetWorkspace(r.PathValue("wsId"))
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	chat, err := s.cursors.GetChat(r.PathValue("chatId"))
	if err != nil || chat.WorkspaceID != workspace.ID {
		s.writeStoreError(w, cursorstore.ErrNotFound)
		return
	}
	if chat.DurableSessionID == "" || sessionParam != chat.DurableSessionID {
		writeError(w, http.StatusConflict, "history_cursor_stale")
		return
	}
	// A quarantined live session means the durable identity was invalidated by
	// an external write; the cursor is stale even when the file is gone.
	if s.manager != nil {
		if live, ok := s.manager.Get(chat.ID); ok && live.HistoryQuarantined() {
			writeError(w, http.StatusConflict, "history_cursor_stale")
			return
		}
	}
	if _, err := validatedChatCWD(workspace.Path, chat.CWD); err != nil {
		s.logger.Warn("rejecting unconfined chat history read", "chat_id", chat.ID, "err", err)
		s.writeStoreError(w, cursorstore.ErrNotFound)
		return
	}
	if chat.SessionFile == "" || !filepath.IsAbs(chat.SessionFile) {
		s.writeStoreError(w, cursorstore.ErrNotFound)
		return
	}

	key := historyFlightKey{path: filepath.Clean(chat.SessionFile), before: before, limit: limit}
	result, err := doHistoryRead(r.Context(), key, s.readHistoryPage(chat.SessionFile, before, limit))
	if err != nil {
		switch {
		case errors.Is(err, errHistoryBusy):
			writeError(w, http.StatusServiceUnavailable, "history_busy")
		case errors.Is(err, coldhistory.ErrEntryNotOnBranch):
			writeError(w, http.StatusConflict, "history_cursor_stale")
		case errors.Is(err, os.ErrNotExist):
			s.writeStoreError(w, cursorstore.ErrNotFound)
		case r.Context().Err() != nil:
			// The request went away mid-read; there is nobody to answer.
		case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
			// Redrive budget exhausted after repeated leader churn: the read
			// itself never failed, so report a retryable busy instead.
			writeError(w, http.StatusServiceUnavailable, "history_busy")
		default:
			s.logger.Error("reading chat history failed", "chat_id", chat.ID, "err", err)
			writeError(w, http.StatusInternalServerError, "internal server error")
		}
		return
	}
	response, err := newHistoryResponse(result)
	if err != nil {
		s.logger.Error("encoding chat history page failed", "chat_id", chat.ID, "err", err)
		writeError(w, http.StatusInternalServerError, "internal server error")
		return
	}
	writeJSON(w, http.StatusOK, response)
}
