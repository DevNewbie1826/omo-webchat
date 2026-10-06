package session

import (
	"strings"
	"time"
)

// ApplyDaemonName routes a daemon-side session name to the live session that
// owns the chat, reporting whether one took ownership of it. The rpcwatch
// snapshot path uses it because an enrolled session is not rpc-attached and
// therefore receives no session_info_changed event: without this route an rpc
// rename of an open enrolled chat would never reach the pane, the sidebar or
// the stored name. The dispatch is asynchronous and holds no manager lock, so
// a watcher tick can never block on provider I/O.
//
// observedAt is the instant the watcher read the snapshot this name came from.
// A snapshot read before the session's title last changed is stale: a newer rpc
// or webchat name already won, and applying the older one would revert it. The
// stale name is refused, but the session still owns its title - the caller must
// not fall back to writing the snapshot into the store.
func (m *Manager) ApplyDaemonName(chatID, name string, observedAt time.Time) bool {
	name = strings.TrimSpace(name)
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return false
	}
	owner := m.byChat[chatID]
	bound := owner != nil && m.byRoute[owner.routingID] == owner
	m.mu.Unlock()
	if !bound {
		return false
	}
	owner.lifecycleMu.Lock()
	current := owner.title
	fresh := owner.titleObservationCurrentLocked(observedAt)
	owner.lifecycleMu.Unlock()
	if name == "" || name == current || !fresh {
		return true
	}
	go owner.applyProviderName(name, observedAt)
	return true
}
