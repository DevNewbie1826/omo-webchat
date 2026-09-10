package api

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
)

// dagCatalogCursor is a value-encoded keyset cursor over the catalog's total
// order (session.DagCatalogLess: updated_at DESC, run_id DESC tiebreak). It
// carries the composite key (updated_at, run_id) of the last emitted entry,
// never a page position, so concurrent appends cannot shift page boundaries:
// runs sorting before the key stay behind the walk and never duplicate, runs
// sorting after it surface on a later page. Version 2 replaced the retired v1
// runId-only key of the old ascending order; v1 cursors are rejected so no
// token can be misread under the new order.
type dagCatalogCursor struct {
	Version        int    `json:"v"`
	Workspace      string `json:"ws"`
	Chat           string `json:"chat"`
	AfterUpdatedAt string `json:"after_updated_at"`
	AfterRunID     string `json:"after_run_id"`
}

type dagCatalogResponse struct {
	Runs       []session.DagCatalogEntry `json:"runs"`
	NextCursor *string                   `json:"next_cursor"`
}

func (s *Server) dagChatScope(w http.ResponseWriter, r *http.Request) (string, string, bool) {
	workspace, err := s.cursors.GetWorkspace(r.PathValue("wsId"))
	if err != nil {
		s.writeStoreError(w, err)
		return "", "", false
	}
	chat, err := s.cursors.GetChat(r.PathValue("chatId"))
	if err != nil || chat.WorkspaceID != workspace.ID {
		s.writeStoreError(w, cursorstore.ErrNotFound)
		return "", "", false
	}
	cwd, err := validatedChatCWD(workspace.Path, chat.CWD)
	if err != nil {
		writeError(w, http.StatusNotFound, "DAG run not found")
		return "", "", false
	}
	return cwd, chat.DurableSessionID, true
}

func (s *Server) writeDagError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, session.ErrDagNotFound):
		writeError(w, http.StatusNotFound, err.Error())
	case errors.Is(err, session.ErrDagSourceChanged):
		writeError(w, http.StatusConflict, err.Error())
	case errors.Is(err, session.ErrDagInvalidSource):
		writeError(w, http.StatusUnprocessableEntity, err.Error())
	case errors.Is(err, r.Context().Err()):
		return
	default:
		s.logger.Error("reading complete DAG failed", "chat_id", r.PathValue("chatId"), "err", err)
		writeError(w, http.StatusInternalServerError, "internal server error")
	}
}

func validDagRunID(id string) bool {
	return id != "" && id != "." && id != ".." && utf8.ValidString(id) && !strings.ContainsAny(id, "/\\\x00")
}

func validDagCursorTimestamp(updatedAt string) bool {
	if updatedAt == "" {
		return true
	}
	_, err := time.Parse(time.RFC3339, updatedAt)
	return err == nil
}

func (s *Server) handleGetChatDagRun(w http.ResponseWriter, r *http.Request) {
	cwd, parent, ok := s.dagChatScope(w, r)
	if !ok {
		return
	}
	runID := r.PathValue("runId")
	if !validDagRunID(runID) {
		writeError(w, http.StatusNotFound, "DAG run not found")
		return
	}
	document, err := session.ReadCompleteDag(r.Context(), cwd, parent, runID)
	if err != nil {
		s.writeDagError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, document)
}

func (s *Server) handleListChatDagRuns(w http.ResponseWriter, r *http.Request) {
	cwd, parent, ok := s.dagChatScope(w, r)
	if !ok {
		return
	}
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid DAG catalog query")
		return
	}
	limit := 100
	if values, present := query["limit"]; present {
		if len(values) != 1 {
			writeError(w, http.StatusBadRequest, "invalid DAG catalog limit")
			return
		}
		limit, err = strconv.Atoi(values[0])
		if err != nil || limit < 1 || limit > 100 {
			writeError(w, http.StatusBadRequest, "invalid DAG catalog limit")
			return
		}
	}
	afterUpdatedAt, afterRunID := "", ""
	if values, present := query["cursor"]; present {
		var cursor dagCatalogCursor
		if len(values) != 1 {
			writeError(w, http.StatusBadRequest, "invalid DAG catalog cursor")
			return
		}
		data, err := base64.RawURLEncoding.Strict().DecodeString(values[0])
		if err != nil || json.Unmarshal(data, &cursor) != nil || cursor.Version != 2 || cursor.Workspace != r.PathValue("wsId") || cursor.Chat != r.PathValue("chatId") || !validDagRunID(cursor.AfterRunID) || !validDagCursorTimestamp(cursor.AfterUpdatedAt) {
			writeError(w, http.StatusBadRequest, "invalid DAG catalog cursor")
			return
		}
		afterUpdatedAt, afterRunID = cursor.AfterUpdatedAt, cursor.AfterRunID
	}
	entries, err := session.ReadDagCatalog(r.Context(), cwd, parent)
	if err != nil {
		s.writeDagError(w, r, err)
		return
	}
	// Keyset resume over the same total order the catalog is sorted in: the
	// next page starts at the first entry sorting strictly after (older than)
	// the cursor's composite key, so pages concatenate without gaps or
	// duplicates across page boundaries, including inside equal-updated_at
	// clusters where only the run_id tiebreak separates neighbors. Without a
	// cursor the walk starts at the newest entry.
	start := 0
	if afterRunID != "" {
		key := session.DagCatalogEntry{RunID: afterRunID, UpdatedAt: afterUpdatedAt}
		start = sort.Search(len(entries), func(i int) bool { return session.DagCatalogLess(key, entries[i]) })
	}
	end := min(start+limit, len(entries))
	response := dagCatalogResponse{Runs: entries[start:end]}
	if end < len(entries) {
		data, err := json.Marshal(dagCatalogCursor{Version: 2, Workspace: r.PathValue("wsId"), Chat: r.PathValue("chatId"), AfterUpdatedAt: entries[end-1].UpdatedAt, AfterRunID: entries[end-1].RunID})
		if err != nil {
			s.writeDagError(w, r, err)
			return
		}
		cursor := base64.RawURLEncoding.EncodeToString(data)
		response.NextCursor = &cursor
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, response)
}
