package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/wsbridge"
)

const chatStopTimeout = 10 * time.Second

var newChatStopContext = context.WithTimeout

type createChatRequest struct {
	Name                   string           `json:"name"`
	Provider               string           `json:"provider"`
	RejectedResumeIdentity *json.RawMessage `json:"resumeIdentity"`
}

func (s *Server) handleCreateChat(w http.ResponseWriter, r *http.Request) {
	wsID := r.PathValue("wsId")
	ws, err := s.cursors.GetWorkspace(wsID)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	var req createChatRequest
	if decodeJSON(r, &req) != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.RejectedResumeIdentity != nil {
		writeError(w, http.StatusBadRequest, "discovered sessions must be adopted")
		return
	}
	provider := strings.TrimSpace(req.Provider)
	if provider != "" && provider != "omo" && provider != "senpi" {
		writeError(w, http.StatusBadRequest, "provider must be omo")
		return
	}
	name := strings.TrimSpace(req.Name)
	placeholder := name == ""
	if placeholder {
		name = s.defaultChatName(ws)
	}
	id, err := newID("chat-")
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	c := cursorstore.Chat{ID: id, WorkspaceID: wsID, CWD: ws.Path, Name: name, NameSource: cursorstore.NameSourceAuto, TitleIsPlaceholder: placeholder, CreatedAt: time.Now().UnixMilli()}
	if err = s.cursors.SaveChat(c); err != nil {
		s.writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, projectChat(c))
}
func (s *Server) defaultChatName(ws cursorstore.Workspace) string {
	base := filepath.Base(filepath.Clean(ws.Path))
	if base == "" || base == "." || base == string(filepath.Separator) {
		base = "chat"
	}
	taken := map[string]bool{}
	for _, c := range s.cursors.ListChats(ws.ID) {
		taken[c.Name] = true
	}
	for i := 1; i <= 1000; i++ {
		n := base + "-" + itoa(i)
		if !taken[n] {
			return n
		}
	}
	return "chat"
}
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	b := [20]byte{}
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

func (s *Server) prepareChatVersion(_ context.Context, wsID, chatID string) (uint64, error) {
	c, err := s.cursors.GetChat(chatID)
	if err != nil || c.WorkspaceID != wsID {
		return 0, cursorstore.ErrNotFound
	}
	if !cursorstore.IsLaunchableProvider(c.Provider) {
		return 0, wsbridge.ErrUnsupportedProvider
	}
	s.chatLifecycleMu.Lock()
	defer s.chatLifecycleMu.Unlock()
	if s.chatDeleting[chatID] {
		return 0, wsbridge.ErrChatDeleted
	}
	c, err = s.cursors.GetChat(chatID)
	if err != nil || c.WorkspaceID != wsID {
		return 0, cursorstore.ErrNotFound
	}
	if !cursorstore.IsLaunchableProvider(c.Provider) {
		return 0, wsbridge.ErrUnsupportedProvider
	}
	return s.chatLifecycleVersion(chatID), nil
}
func (s *Server) chatLifecycleVersion(id string) uint64 {
	if v, ok := s.chatLifecycleGeneration.Load(id); ok {
		return v.(uint64)
	}
	return 0
}
func (s *Server) bumpChatLifecycleVersion(id string) {
	g := s.chatLifecycleVersion(id) + 1
	s.chatLifecycleGeneration.Store(id, g)
	s.chatLifecycleGenerationFIFO = append(s.chatLifecycleGenerationFIFO, chatLifecycleGenerationRecord{id, g})
	for len(s.chatLifecycleGenerationFIFO) > maxChatLifecycleGenerationRecords {
		old := s.chatLifecycleGenerationFIFO[0]
		s.chatLifecycleGenerationFIFO = s.chatLifecycleGenerationFIFO[1:]
		if v, ok := s.chatLifecycleGeneration.Load(old.chatID); ok && v.(uint64) == old.generation {
			s.chatLifecycleGeneration.Delete(old.chatID)
		}
	}
}

func (s *Server) handleDeleteChat(w http.ResponseWriter, r *http.Request) {
	wsID, id := r.PathValue("wsId"), r.PathValue("chatId")
	s.chatLifecycleMu.Lock()
	c, err := s.cursors.GetChat(id)
	if err != nil || c.WorkspaceID != wsID {
		s.chatLifecycleMu.Unlock()
		s.writeStoreError(w, cursorstore.ErrNotFound)
		return
	}
	if s.chatDeleting[id] {
		s.chatLifecycleMu.Unlock()
		writeError(w, http.StatusConflict, "chat deletion is already in progress")
		return
	}
	s.chatDeleting[id] = true
	s.bumpChatLifecycleVersion(id)
	s.chatLifecycleMu.Unlock()
	ctx, cancel := newChatStopContext(context.Background(), chatStopTimeout)
	if s.manager != nil {
		err = s.manager.StopContext(ctx, id)
	}
	cancel()
	if err != nil {
		s.chatLifecycleMu.Lock()
		delete(s.chatDeleting, id)
		s.chatLifecycleMu.Unlock()
		writeError(w, http.StatusInternalServerError, "failed to stop chat")
		return
	}
	s.chatLifecycleMu.Lock()
	err = s.cursors.DeleteChat(id)
	delete(s.chatDeleting, id)
	s.chatLifecycleMu.Unlock()
	if err != nil && !errors.Is(err, cursorstore.ErrNotFound) {
		s.writeStoreError(w, err)
		return
	}
	if s.manager != nil {
		s.manager.RetireIdentity(id)
	}
	w.WriteHeader(http.StatusNoContent)
}
func (s *Server) handleRenameChat(w http.ResponseWriter, r *http.Request) {
	var req renameRequest
	if decodeJSON(r, &req) != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	id := r.PathValue("chatId")
	c, err := s.cursors.GetChat(id)
	if err != nil || c.WorkspaceID != r.PathValue("wsId") {
		s.writeStoreError(w, cursorstore.ErrNotFound)
		return
	}
	// Atomic name mutation: an open persisting a new identity between the
	// read above and this write cannot be clobbered, and any established
	// name clears the placeholder marker.
	if err = s.cursors.UpdateName(id, name, cursorstore.NameSourceUser); err != nil {
		s.writeStoreError(w, err)
		return
	}
	c, err = s.cursors.GetChat(id)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	if s.manager != nil {
		if sess, ok := s.manager.Get(id); ok {
			_ = sess.SetSessionName(r.Context(), name)
		}
	}
	writeJSON(w, http.StatusOK, projectChat(c))
}

type providerStatus struct {
	ID        string `json:"id"`
	Label     string `json:"label"`
	Binary    string `json:"binary"`
	Available bool   `json:"available"`
}

func (s *Server) handleListProviders(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, []providerStatus{{ID: "omo", Label: "Omo", Binary: "omo", Available: true}})
}
