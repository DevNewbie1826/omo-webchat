package api

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/rpcwatch"
)

type sessionHistoryLiveStatus struct {
	Status    string   `json:"status"`
	Questions []string `json:"questions"`
}

// canonicalWatcherPath resolves existing ancestors as well as a file which has
// not yet been persisted. The latter still has a concrete daemon identity.
func canonicalWatcherPath(path string) string {
	if !filepath.IsAbs(path) {
		return ""
	}
	path = filepath.Clean(path)
	resolved, err := filepath.EvalSymlinks(path)
	if err == nil {
		return filepath.Clean(resolved)
	}
	if !errors.Is(err, os.ErrNotExist) {
		return ""
	}
	parent := filepath.Dir(path)
	if parent == path {
		return ""
	}
	if resolved := canonicalWatcherPath(parent); resolved != "" {
		return filepath.Join(resolved, filepath.Base(path))
	}
	return ""
}

func watcherIdentityMatches(path, durableID string, observed rpcwatch.Session) bool {
	path = canonicalWatcherPath(strings.TrimSpace(path))
	if path == "" || path != canonicalWatcherPath(strings.TrimSpace(observed.SessionPath)) {
		return false
	}
	durableID = strings.TrimSpace(durableID)
	observedID := strings.TrimSpace(observed.DurableSessionID)
	return durableID == "" || observedID == "" || durableID == observedID
}

// mergeWorkspaceWatcher folds bound routes into stored rows and removes disk
// aliases before pagination. Watcher time never changes history recency.
func (s *Server) mergeWorkspaceWatcher(cwd string, chats []cursorstore.Chat, items []sessionHistoryItem) ([]sessionHistoryItem, []rpcwatch.Session) {
	pinned := make([]rpcwatch.Session, 0)
	if s.rpcWatcher == nil {
		return items, pinned
	}
	canonicalCWD, ok := canonicalSessionCWD(cwd)
	if !ok {
		return items, pinned
	}
	statusByChat := make(map[string]*sessionHistoryLiveStatus)
	for _, observed := range s.rpcWatcher.Sessions() {
		routeCWD, valid := canonicalSessionCWD(observed.Cwd)
		if !valid || routeCWD != canonicalCWD {
			continue
		}
		bound := false
		for _, chat := range chats {
			if !watcherIdentityMatches(chat.SessionFile, chat.DurableSessionID, observed) {
				continue
			}
			bound = true
			owned := false
			if s.manager != nil {
				if route, exists := s.manager.Get(chat.ID); exists {
					owned = !route.Resumable() && route.RoutingID() == observed.SessionID
				}
			}
			if !owned {
				statusByChat[chat.ID] = &sessionHistoryLiveStatus{Status: observed.Status, Questions: observed.Questions}
			}
		}
		if !bound {
			pinned = append(pinned, observed)
		}
	}
	filtered := items[:0]
	for _, item := range items {
		if item.Source == sessionHistorySourceStored {
			item.Live = statusByChat[item.ID]
		} else {
			suppress := false
			for _, observed := range pinned {
				if watcherIdentityMatches(item.ResumeIdentity, item.ID, observed) {
					suppress = true
					break
				}
			}
			if suppress {
				continue
			}
		}
		filtered = append(filtered, item)
	}
	sort.Slice(pinned, func(i, j int) bool {
		if pinned[i].UpdatedAt != pinned[j].UpdatedAt {
			return pinned[i].UpdatedAt > pinned[j].UpdatedAt
		}
		return pinned[i].SessionID < pinned[j].SessionID
	})
	return filtered, pinned
}
