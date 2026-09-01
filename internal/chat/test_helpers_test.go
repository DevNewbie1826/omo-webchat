package chat

import (
	"context"
	"os"
	"os/exec"
	"testing"
)

func managedMockOptions(t *testing.T, id string, env ...string) SessionOptions {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skipf("node not in PATH: %v", err)
	}
	return SessionOptions{
		ID:              id,
		Binary:          node,
		Args:            []string{mockPiScript(t)},
		Env:             append(os.Environ(), env...),
		ProviderContext: context.Background(),
	}
}

func newTestSession(id string, writer *collectWriter) *Session {
	session := &Session{id: id, frames: newBroadcaster(), lastStop: "stop"}
	if writer != nil {
		session.Attach(writer)
	}
	return session
}

func sessionShared(s *Session) *sharedProvider {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.shared
}
