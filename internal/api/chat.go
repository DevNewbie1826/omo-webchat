package api

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/lxzan/gws"

	"github.com/DevNewbie1826/omo-webchat/internal/chat"
	"github.com/DevNewbie1826/omo-webchat/internal/store"
)

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
	s.chatLifecycleMu.Lock()
	_, err := s.store.RemoveChat(wsID, chatID)
	s.chatLifecycleMu.Unlock()
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	// Provider shutdown is I/O and must stay outside chatLifecycleMu. A create
	// that opened concurrently rechecks the store under the same mutex before
	// publishing its attachment and tears itself down if this delete won.
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
	if sess := s.chats.Get(r.PathValue("chatId")); sess != nil {
		_ = sess.SetSessionName(name)
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
	for _, summary := range summaries {
		title := summary.Title
		if title == "" {
			title = titles[summary.ID]
		}
		sessions = append(sessions, liveSessionResponse{
			ID:    summary.ID,
			Title: title,
			Task:  rawOrNull(summary.Pair.Task),
			Dag:   rawOrNull(summary.Pair.Dag),
		})
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
	if bound, _ := h.snapshot(); cf.SessionID != bound {
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
