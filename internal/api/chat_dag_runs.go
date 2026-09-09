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
	"unicode/utf8"

	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
)

type dagCatalogCursor struct {
	Version   int    `json:"v"`
	Workspace string `json:"ws"`
	Chat      string `json:"chat"`
	After     string `json:"after"`
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
	after := ""
	if values, present := query["cursor"]; present {
		var cursor dagCatalogCursor
		if len(values) != 1 {
			writeError(w, http.StatusBadRequest, "invalid DAG catalog cursor")
			return
		}
		data, err := base64.RawURLEncoding.Strict().DecodeString(values[0])
		if err != nil || json.Unmarshal(data, &cursor) != nil || cursor.Version != 1 || cursor.Workspace != r.PathValue("wsId") || cursor.Chat != r.PathValue("chatId") || !validDagRunID(cursor.After) {
			writeError(w, http.StatusBadRequest, "invalid DAG catalog cursor")
			return
		}
		after = cursor.After
	}
	entries, err := session.ReadDagCatalog(r.Context(), cwd, parent)
	if err != nil {
		s.writeDagError(w, r, err)
		return
	}
	start := sort.Search(len(entries), func(i int) bool { return entries[i].RunID > after })
	end := min(start+limit, len(entries))
	response := dagCatalogResponse{Runs: entries[start:end]}
	if end < len(entries) {
		data, err := json.Marshal(dagCatalogCursor{Version: 1, Workspace: r.PathValue("wsId"), Chat: r.PathValue("chatId"), After: entries[end-1].RunID})
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
