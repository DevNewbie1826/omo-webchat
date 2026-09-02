package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/lxzan/gws"

	"github.com/DevNewbie1826/omo-webchat/internal/chat"
	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/store"
)

const chatStopTimeout = 10 * time.Second

var newChatStopContext = context.WithTimeout

type createChatRequest struct {
	Name           string `json:"name"`
	Provider       string `json:"provider"`
	ResumeIdentity string `json:"resumeIdentity"`
}

func (s *Server) handleCreateChat(w http.ResponseWriter, r *http.Request) {
	wsID := r.PathValue("wsId")
	ws, err := s.store.GetWorkspace(wsID)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	var req createChatRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	providerID := strings.TrimSpace(req.Provider)
	available, err := s.agentAvailable(providerID)
	if err != nil {
		writeError(w, http.StatusBadRequest, "provider must be omo")
		return
	}
	if !available {
		writeError(w, http.StatusServiceUnavailable, "provider CLI is unavailable")
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		if name, err = s.store.DefaultChatName(r.Context(), &ws); err != nil {
			name = "chat"
		}
	}
	resumeIdentity := strings.TrimSpace(req.ResumeIdentity)
	if resumeIdentity != "" {
		var valid bool
		resumeIdentity, valid = resolveDiskSessionPath(ws.Path, resumeIdentity)
		if !valid {
			writeError(w, http.StatusBadRequest, "resume identity does not belong to workspace")
			return
		}
	}
	var c store.Chat
	if resumeIdentity == "" {
		c, err = s.store.NewChat(wsID, name, ws.Path, "", providerID)
	} else {
		c, err = s.store.NewChatWithResumeIdentity(wsID, name, ws.Path, "", providerID, resumeIdentity)
	}
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, c)
}

func (s *Server) handleDeleteChat(w http.ResponseWriter, r *http.Request) {
	wsID := r.PathValue("wsId")
	chatID := r.PathValue("chatId")
	if s.beforeChatDelete != nil {
		s.beforeChatDelete()
	}

	// Publish a deletion generation before provider I/O. Prepare captures the
	// prior generation under this lock; bridge publication validates it without
	// taking the lock from inside the manager flight.
	s.chatLifecycleMu.Lock()
	if _, err := s.store.GetChat(wsID, chatID); err != nil {
		s.chatLifecycleMu.Unlock()
		s.writeStoreError(w, err)
		return
	}
	if s.chatDeleting[chatID] {
		s.chatLifecycleMu.Unlock()
		writeError(w, http.StatusConflict, "chat deletion is already in progress")
		return
	}
	s.chatDeleting[chatID] = true
	s.bumpChatLifecycleVersion(chatID)
	s.chatLifecycleMu.Unlock()

	// Stop uses a lifecycle-owned deadline: disconnecting the HTTP client must
	// not turn a still-live provider session into successfully deleted metadata.
	manager, cursors := s.v2Stack()
	if manager != nil {
		stopCtx, cancelStop := newChatStopContext(context.Background(), chatStopTimeout)
		err := manager.StopContext(stopCtx, chatID)
		cancelStop()
		if err != nil {
			s.chatLifecycleMu.Lock()
			delete(s.chatDeleting, chatID)
			s.chatLifecycleMu.Unlock()
			s.logger.Error("stopping v2 chat for delete", "err", err, "chatId", chatID)
			writeError(w, http.StatusInternalServerError, "failed to stop chat")
			return
		}
	}
	if s.afterV2ChatStop != nil {
		s.afterV2ChatStop()
	}

	// Deletion exclusion remains active through both metadata stores, but no
	// API lifecycle lock is held across the provider RPC above.
	s.chatLifecycleMu.Lock()
	if _, err := s.store.RemoveChat(wsID, chatID); err != nil {
		delete(s.chatDeleting, chatID)
		s.chatLifecycleMu.Unlock()
		s.writeStoreError(w, err)
		return
	}
	if cursors != nil {
		if err := cursors.DeleteChat(chatID); err != nil && !errors.Is(err, cursorstore.ErrNotFound) {
			delete(s.chatDeleting, chatID)
			s.chatLifecycleMu.Unlock()
			s.logger.Error("deleting v2 chat cursor", "err", err, "chatId", chatID)
			writeError(w, http.StatusInternalServerError, "failed to delete chat cursor")
			return
		}
	}
	delete(s.chatDeleting, chatID)
	s.chatLifecycleMu.Unlock()

	// Legacy provider shutdown stays outside the lifecycle lock. The v1 record
	// is already absent, so an in-flight open cannot publish its attachment.
	s.chats.Stop(chatID)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleRenameChat(w http.ResponseWriter, r *http.Request) {
	var req renameRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	c, err := s.store.UpdateChat(r.PathValue("wsId"), r.PathValue("chatId"), func(c *store.Chat) {
		c.Name = name
		c.NameSource = "user"
	})
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	// The user owns the title from here on: push it to the live provider
	// session best-effort so its own name reporting cannot drift the UI.
	chatID := r.PathValue("chatId")
	if sess := s.chats.Get(chatID); sess != nil {
		_ = sess.SetSessionName(name)
	}
	if manager, cursors := s.v2Stack(); manager != nil {
		if sess, active := manager.Get(chatID); active {
			_ = sess.SetSessionName(r.Context(), name)
			if cursors != nil {
				if record, getErr := cursors.GetChat(chatID); getErr == nil {
					record.Name, record.NameSource = name, "user"
					_ = cursors.SaveChat(record)
				}
			}
		}
	}
	writeJSON(w, http.StatusOK, c)
}

type connHandler struct {
	srv       *Server
	conn      *gws.Conn
	wsID      string
	chatID    string
	session   *chat.Session
	detach    func()
	mu        sync.Mutex
	cancelled atomic.Bool
	ctx       context.Context
	cancel    context.CancelFunc
}

var _ chat.FrameWriterCanceller = (*connHandler)(nil)

func (h *connHandler) WriteJSON(b []byte) error {
	if h.conn.NetConn() == nil {
		return nil
	}
	if err := h.conn.WriteMessage(gws.OpcodeText, b); err != nil {
		// Surface oversized-write failures (gws ErrMessageTooLarge above
		// WriteMaxPayloadSize) and dead-socket writes instead of discarding
		// them, so a dropped frame is diagnosable rather than a blank screen.
		h.srv.logger.Warn("ws write failed", "err", err, "bytes", len(b))
		return err
	}
	return nil
}

// Close cancels an in-flight WriteJSON without waiting for network shutdown.
// Closing the underlying connection releases the blocked write; the atomic
// gate keeps concurrent and repeated cancellation calls non-blocking.
func (h *connHandler) Close() error {
	if h.cancelled.CompareAndSwap(false, true) {
		if conn := h.conn.NetConn(); conn != nil {
			go func() { _ = conn.Close() }()
		}
	}
	return nil
}

func (h *connHandler) connectionContext() context.Context {
	if h.ctx != nil {
		return h.ctx
	}
	if h.srv != nil && h.srv.ctx != nil {
		return h.srv.ctx
	}
	return context.Background()
}

func (h *connHandler) cancelConnection() {
	if h.cancel != nil {
		h.cancel()
	}
}

func (h *connHandler) snapshot() (string, *chat.Session) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.chatID, h.session
}

func (h *connHandler) detachSession() (string, func()) {
	h.mu.Lock()
	defer h.mu.Unlock()
	chatID := h.chatID
	detach := h.detach
	h.wsID = ""
	h.chatID = ""
	h.session = nil
	h.detach = nil
	return chatID, detach
}

func (h *connHandler) sendError(code, msg string) {
	h.sendCommandError(code, msg, "", "")
}

func (h *connHandler) sendCommandError(code, msg, command, requestID string) {
	chatID, _ := h.snapshot()
	frame, _ := json.Marshal(chat.ErrorFrame{Type: "error", SessionID: chatID, Code: code, Message: msg, Command: command, RequestID: requestID})
	_ = h.WriteJSON(frame)
}

func (s *Server) handleListProviders(w http.ResponseWriter, _ *http.Request) {
	providers := chat.Providers()
	statuses := make([]chat.ProviderStatus, 0, len(providers))
	for _, provider := range providers {
		binary, _, err := s.resolveAgent(provider.ID)
		available := false
		if err == nil {
			_, err = exec.LookPath(binary)
			available = err == nil
		}
		statuses = append(statuses, chat.ProviderStatus{
			ID:        provider.ID,
			Label:     provider.Label,
			Binary:    binary,
			Available: available,
		})
	}
	writeJSON(w, http.StatusOK, statuses)
}

func (s *Server) handleListLiveSessions(w http.ResponseWriter, _ *http.Request) {
	summaries := s.chats.LiveSummaries()
	titles := s.liveChatTitles()
	sessions := make([]liveSessionResponse, 0, len(summaries))
	seen := make(map[string]bool, len(summaries))
	for _, summary := range summaries {
		title := summary.Title
		if title == "" {
			title = titles[summary.ID]
		}
		sessions = append(sessions, liveSessionFromSummary(summary, title))
		seen[summary.ID] = true
	}
	if manager, _ := s.v2Stack(); manager != nil {
		for _, summary := range manager.LiveSummaries() {
			if seen[summary.ChatID] {
				continue
			}
			sessions = append(sessions, liveSessionResponse{ID: summary.ChatID, Title: titles[summary.ChatID]})
		}
	}
	writeJSON(w, http.StatusOK, liveSessionsResponse{Sessions: sessions})
}

func (s *Server) agentAvailable(providerID string) (bool, error) {
	binary, _, err := s.resolveAgent(providerID)
	if err != nil {
		return false, err
	}
	_, err = exec.LookPath(binary)
	return err == nil, nil
}

func (s *Server) resolveAgent(providerID string) (binary string, args []string, err error) {
	provider, err := chat.ResolveProvider(providerID)
	if err != nil {
		return "", nil, err
	}
	if v := os.Getenv("CHAT_PI_BINARY"); v != "" {
		binary = v
		if a := os.Getenv("CHAT_PI_ARGS"); a != "" {
			args = strings.Split(a, ",")
		}
		return binary, args, nil
	}
	return provider.Binary, provider.Args, nil
}

func (s *Server) routeMessage(h *connHandler, data []byte) {
	cf, err := chat.ParseClientFrame(data)
	if err != nil {
		h.sendError("bad_frame", "invalid json frame")
		return
	}
	if cf.Type == "ping" {
		pong, _ := json.Marshal(map[string]string{"type": "pong"})
		_ = h.WriteJSON(pong)
		return
	}
	if cf.Type == "chat.create" {
		s.handleChatCreate(h, cf.Raw)
		return
	}
	// Every non-create/ping command must target the chat bound to this socket.
	// Rejecting a mismatched sessionId keeps a stale or misaddressed frame from
	// aborting, mutating, or querying another chat sharing the manager.
	if bound, _ := h.snapshot(); cf.SessionID != bound && !(cf.Type == "activity.refresh" && bound == "") {
		h.sendError("session_mismatch", "frame sessionId does not match this socket's chat")
		return
	}
	switch cf.Type {
	case "chat.send":
		s.handleChatSend(h, cf.Raw)
	case "chat.abort":
		if _, session := h.snapshot(); session != nil {
			session.Abort()
		}
	case "chat.set":
		s.handleChatSet(h, cf.Raw, cf.RequestID)
	case "approval.respond":
		s.handleApprovalRespond(h, cf.Raw, cf.RequestID)
	case "chat.commands":
		if _, session := h.snapshot(); session != nil {
			_ = session.QueryCommands()
		}
	case "chat.compact":
		s.handleChatCompact(h, cf.RequestID)
	case "chat.models":
		if _, session := h.snapshot(); session != nil {
			_ = session.QueryModels()
		}
	case "chat.stats":
		if _, session := h.snapshot(); session != nil {
			_ = session.QueryStats()
		}
	case "activity.refresh":
		s.handleActivityRefresh(h)
	case "chat.resume":
		s.handleChatResume(h, cf.Raw)
	case "chat.close":
		_, detach := h.detachSession()
		if detach != nil {
			detach()
		}
	case "chat.disconnect":
		chatID, detach := h.detachSession()
		if detach != nil {
			detach()
		}
		if chatID != "" {
			s.chats.Stop(chatID)
		}
	default:
		h.sendError("unknown_type", "unknown frame type: "+cf.Type)
	}
}
