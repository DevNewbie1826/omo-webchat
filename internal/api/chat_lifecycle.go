package api

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/chat"
	"github.com/DevNewbie1826/omo-webchat/internal/store"
)

// providerStderrPath resolves the shared provider's stderr capture file from
// the same effective state directory as the store. Explicit configuration is
// authoritative; otherwise the default store resolver is used. Resolution
// failures are startup failures rather than silently disabling diagnostics.
func (s *Server) providerStderrPath() (string, error) {
	if s.cfg != nil && s.cfg.StateDir != "" {
		return filepath.Join(s.cfg.StateDir, "omo-provider.stderr.log"), nil
	}
	dir, err := store.StateDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "omo-provider.stderr.log"), nil
}

func (s *Server) handleChatCreate(h *connHandler, raw []byte) {
	var req struct {
		WsID   string `json:"wsId"`
		ChatID string `json:"chatId"`
	}
	if json.Unmarshal(raw, &req) != nil {
		h.sendError("bad_create", "invalid chat.create")
		return
	}
	if req.ChatID == "" || req.WsID == "" {
		h.sendError("bad_create", "wsId and chatId are required")
		return
	}
	s.chatLifecycleMu.Lock()
	ws, err := s.store.GetWorkspace(req.WsID)
	if err != nil {
		s.chatLifecycleMu.Unlock()
		h.sendError("no_workspace", "workspace not found")
		return
	}
	existing, err := s.store.GetChat(req.WsID, req.ChatID)
	if err != nil {
		s.chatLifecycleMu.Unlock()
		h.sendError("no_chat", "chat not found")
		return
	}
	if s.afterChatLookup != nil {
		s.afterChatLookup()
	}
	s.chatLifecycleMu.Unlock()
	// Normalize the persisted identity at launch: legacy launchable records
	// (empty, senpi) launch as omo without persisting the alias, and every
	// other identity is rejected precisely while the record stays verbatim.
	providerID, err := chat.NormalizePersistedProvider(existing.Provider)
	if err != nil {
		h.sendError("bad_provider", "unsupported chat provider")
		return
	}
	binary, args, err := s.resolveAgent(providerID)
	if err != nil {
		h.sendError("bad_provider", "unsupported chat provider")
		return
	}
	_, previousDetach := h.detachSession()
	if previousDetach != nil {
		previousDetach()
	}
	stderrPath, err := s.providerStderrPath()
	if err != nil {
		h.sendError("start_failed", "resolve provider stderr path: "+err.Error())
		return
	}
	var sess *chat.Session
	// A dangling stored identity may still have recoverable branch sessions
	// recorded inside sibling session files. The recovery scan joins on the
	// chat's name within the workspace's session directory; both are captured
	// by value so the callback never reads live lifecycle state.
	chatName := existing.Name
	workspacePath := ws.Path
	opts := chat.SessionOptions{
		ProviderContext: s.ctx,
		ID:              req.ChatID,
		Cwd:             ws.Path,
		Binary:          binary,
		Args:            args,
		Env:             os.Environ(),
		Provider:        providerID,
		PiSessionID:     existing.PiSessionID,
		// The provider's stderr persists to the state directory so the next
		// provider death is diagnosable; the chat package only consumes the
		// resolved path.
		StderrPath: stderrPath,
		// A chat record's persisted activity pair seeds the replay cache of the
		// session restored from disk; live snapshots supersede it once omo
		// sends real state.
		SeedActivity: existing.ActivitySnapshot,
		// A chat record's persisted durable notices seed the restored
		// session's replay log; malformed records are dropped by the seed.
		SeedNotices: existing.Notices,
		// A settled run is the persistence write boundary: at most one store
		// write per turn, and only when the replayable pair changed, so idle
		// chats and transient activity traffic never touch the state file.
		OnActivitySnapshot: func(source *chat.Session, pair chat.ActivitySnapshotPair) bool {
			if s.chats.Get(req.ChatID) != source {
				return true
			}
			seed := pair.Clone()
			if _, err := s.store.UpdateChat(req.WsID, req.ChatID, func(record *store.Chat) {
				record.ActivitySnapshot = &seed
			}); err != nil {
				s.logger.Warn("activity snapshot persist failed", "err", err, "chatId", req.ChatID)
				return false
			}
			return true
		},
		// A durable advisory notice is its own persistence write boundary (it
		// can fire with no run): append the changed durable log to the chat
		// record. A failed write only logs; forwarding is never broken.
		OnNoticePersist: func(source *chat.Session, notices []chat.NoticeRecord) bool {
			return s.chats.PersistIfGeneration(source, func() bool {
				if _, err := s.store.UpdateChat(req.WsID, req.ChatID, func(record *store.Chat) {
					record.Notices = notices
				}); err != nil {
					s.logger.Warn("durable notice persist failed", "err", err, "chatId", req.ChatID)
					return false
				}
				return true
			})
		},
		OnResumeIdentity: func(source *chat.Session, identity chat.ResumeIdentity) error {
			if s.chats.Get(req.ChatID) != source {
				return nil
			}
			_, err := s.store.UpdateChat(req.WsID, req.ChatID, func(record *store.Chat) {
				record.PiSessionID = identity.Value
			})
			return err
		},
		// Invoked by the manager only when a permanent resume failure left the
		// stored session path dangling; must stay bounded (see
		// findSessionBranchesByName).
		OnResumeFailure: func(storedIdentity string) []chat.SessionBranchCandidate {
			return findSessionBranchesByName(workspacePath, chatName)
		},
		// A provider-reported session name persists only while the user does
		// not own the title; the name source stays whatever derived it.
		OnProviderName: func(source *chat.Session, name string) {
			if s.chats.Get(req.ChatID) != source {
				return
			}
			if _, err := s.store.UpdateChat(req.WsID, req.ChatID, func(record *store.Chat) {
				if record.NameSource == "user" || record.Name == name {
					return
				}
				record.Name = name
			}); err != nil {
				s.logger.Warn("provider name persist failed", "err", err, "chatId", req.ChatID)
			}
		},
	}
	openCtx, cancelOpen := s.newChatOpenContext(h.connectionContext())
	sess, started, detach, err := s.chats.AcquireAttach(openCtx, opts, h)
	cancelOpen()
	if err != nil {
		h.sendError("start_failed", err.Error())
		return
	}

	// AcquireAttach performs provider I/O before registering the logical
	// session. Re-enter the API lifecycle critical section only to linearize
	// that registration against chat/workspace deletion, then publish the
	// attachment while deletion is excluded. If deletion won during the open,
	// clean up the just-opened session outside the mutex.
	s.chatLifecycleMu.Lock()
	_, storeErr := s.store.GetChat(req.WsID, req.ChatID)
	h.mu.Lock()
	_, connected := s.conns.Load(h.conn)
	if storeErr == nil && connected {
		h.chatID = req.ChatID
		h.wsID = req.WsID
		h.session = sess
		h.detach = detach
	}
	h.mu.Unlock()
	s.chatLifecycleMu.Unlock()
	if storeErr != nil || !connected {
		detach()
		if started {
			s.chats.StopIfCurrent(req.ChatID, sess)
		}
		if storeErr != nil && connected {
			h.sendError("no_chat", "chat not found")
		}
		return
	}
	// Exactly one last-used touch per successful open: the attachment is
	// published and the store recheck passed, so this chat was genuinely
	// opened. The stamp is the MRU recency key for stored sessions; a failed
	// persist only logs and never breaks the open.
	if _, err := s.store.UpdateChat(req.WsID, req.ChatID, func(record *store.Chat) {
		record.LastUsedAt = time.Now().UnixMilli()
	}); err != nil {
		s.logger.Warn("last-used persist failed", "err", err, "chatId", req.ChatID)
	}
	ready, _ := json.Marshal(chat.ReadyFrame{Type: "ready", SessionID: req.ChatID, PiSessionID: sess.PiSessionID(), Resumed: opts.PiSessionID != ""})
	_ = h.WriteJSON(ready)
	if started {
		if err := sess.Initialize(); err != nil {
			h.sendError("initialize_failed", err.Error())
		}
		return
	}
	if err := sess.QueryState(); err != nil {
		h.sendError("initialize_failed", err.Error())
		return
	}
	if err := sess.QueryModels(); err != nil {
		h.sendError("initialize_failed", err.Error())
		return
	}
	if err := sess.QueryCommands(); err != nil {
		h.sendError("initialize_failed", err.Error())
		return
	}
	if err := sess.QueryStats(); err != nil {
		h.sendError("initialize_failed", err.Error())
		return
	}
	if err := sess.Resume(""); err != nil {
		h.sendError("initialize_failed", err.Error())
	}
}
