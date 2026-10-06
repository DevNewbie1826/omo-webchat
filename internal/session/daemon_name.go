package session

import "strings"

// ApplyDaemonName routes a daemon-side session name to the live session that
// owns the chat, reporting whether one took ownership of it. The rpcwatch
// snapshot path uses it because an enrolled session is not rpc-attached and
// therefore receives no session_info_changed event: without this route an rpc
// rename of an open enrolled chat would never reach the pane, the sidebar or
// the stored name. The dispatch is asynchronous and holds no manager lock, so
// a watcher tick can never block on provider I/O.
func (m *Manager) ApplyDaemonName(chatID, name string) bool {
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
	owner.lifecycleMu.Unlock()
	if name == "" || name == current {
		return true
	}
	go owner.applyProviderName(name)
	return true
}
