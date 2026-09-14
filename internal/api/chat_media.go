package api

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
)

// mediaChatRef addresses one catalog chat through the manager's acquisition
// API (session.ChatRef).
type mediaChatRef struct{ id, cwd string }

func (c mediaChatRef) ChatID() string { return c.id }
func (c mediaChatRef) CWD() string    { return c.cwd }

// handleGetChatMedia serves the raw bytes of one inline media block: a
// tool-result image_ref placeholder names the block with a ref (toolCallId
// plus contentIndex), and this endpoint fetches that block from the chat's
// engine session on demand. It is protected, catalog-scoped, and confined
// exactly like the other chat readers: the chat must belong to the workspace
// and its cwd must resolve inside the workspace. The fetch uses the same lazy
// session-open discipline as every other user-required command: an existing
// live route is reused, otherwise the durable session is opened (or resumed)
// inside the per-chat flight and left to the manager's ordinary lifecycle.
func (s *Server) handleGetChatMedia(w http.ResponseWriter, r *http.Request) {
	workspace, err := s.cursors.GetWorkspace(r.PathValue("wsId"))
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	chat, err := s.cursors.GetChat(r.PathValue("chatId"))
	if err != nil || chat.WorkspaceID != workspace.ID || !cursorstore.IsLaunchableProvider(chat.Provider) {
		s.writeStoreError(w, cursorstore.ErrNotFound)
		return
	}
	if _, err := validatedChatCWD(workspace.Path, chat.CWD); err != nil {
		s.logger.Warn("rejecting unconfined chat media lookup", "chat_id", chat.ID, "err", err)
		s.writeStoreError(w, cursorstore.ErrNotFound)
		return
	}
	toolCallID := strings.TrimSpace(r.URL.Query().Get("toolCallId"))
	contentIndex, indexErr := parseContentIndex(r.URL.Query().Get("contentIndex"))
	if toolCallID == "" || indexErr != nil {
		writeError(w, http.StatusBadRequest, "toolCallId and contentIndex are required")
		return
	}
	data, err := s.fetchChatMedia(r.Context(), mediaChatRef{id: chat.ID, cwd: chat.CWD}, toolCallID, contentIndex)
	if err != nil {
		s.writeMediaError(w, r, err)
		return
	}
	raw, decodeErr := base64.StdEncoding.DecodeString(data.Content.Data)
	if decodeErr != nil {
		s.logger.Error("engine returned an undecodable media block", "chat_id", chat.ID, "err", decodeErr)
		writeError(w, http.StatusInternalServerError, "internal server error")
		return
	}
	mimeType := data.Content.MimeType
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	w.Header().Set("Content-Type", mimeType)
	w.Header().Set("Content-Disposition", "inline")
	w.Header().Set("Content-Length", strconv.Itoa(len(raw)))
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(raw)
}

// parseContentIndex parses the placeholder's positional block index. The
// index is required even when zero: an omitted index would change which
// block the engine resolves.
func parseContentIndex(raw string) (int, error) {
	if raw == "" {
		return 0, errors.New("missing contentIndex")
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 0 {
		return 0, errors.New("invalid contentIndex")
	}
	return n, nil
}

// fetchChatMedia resolves the chat's session and fetches the addressed block
// inside the manager's per-chat flight. On a dead transport the request rides
// out one bounded engine replacement before giving up, matching the
// transport's open discipline.
func (s *Server) fetchChatMedia(ctx context.Context, ref mediaChatRef, toolCallID string, contentIndex int) (*omorpc.GetMediaData, error) {
	fetch := func() (*omorpc.GetMediaData, error) {
		var data *omorpc.GetMediaData
		_, _, detach, err := s.manager.AcquireInitializedCheckedAndRunRecovering(ctx, ref, nil, nil, nil, func(sess *session.Session) error {
			fetched, fetchErr := sess.GetMedia(ctx, toolCallID, contentIndex)
			if fetchErr != nil {
				return fetchErr
			}
			data = fetched
			return nil
		})
		if detach != nil {
			defer detach()
		}
		return data, err
	}
	data, err := fetch()
	if errors.Is(err, omorpc.ErrDisconnected) {
		if waitErr := s.manager.WaitForConnection(ctx); waitErr == nil {
			data, err = fetch()
		}
	}
	return data, err
}

func (s *Server) writeMediaError(w http.ResponseWriter, r *http.Request, err error) {
	var stable *omorpc.StableError
	var resume *session.ResumeError
	switch {
	case errors.As(err, &stable) && stable.Code == omorpc.ErrCodeMediaNotFound:
		writeError(w, http.StatusNotFound, "media not found")
	case errors.As(err, &resume),
		errors.Is(err, session.ErrSessionResumable),
		errors.Is(err, omorpc.ErrDisconnected),
		errors.Is(err, session.ErrManagerClosed):
		writeError(w, http.StatusBadGateway, "engine session unavailable")
	case errors.Is(err, r.Context().Err()):
		return
	default:
		s.logger.Error("fetching chat media failed", "chat_id", r.PathValue("chatId"), "err", err)
		writeError(w, http.StatusInternalServerError, "internal server error")
	}
}
