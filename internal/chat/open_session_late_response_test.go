package chat

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

// A provider may legitimately answer open_session and exit in the same breath.
// The exit path closes p.done BEFORE it closes each pending response channel,
// so an open that raced process death observed neither and reported a
// successful open as a failure. afterOpenDeath lets the test deliver the
// response at exactly that point instead of re-rolling the natural race.
func TestOpenSessionAcceptsResponseDeliveredAfterProviderDeath(t *testing.T) {
	commands := make(chan []byte, 4)
	provider := fakeSharedProvider(commands)
	session := newTestSession("chat-late-open", nil)

	reachedDeathArm := make(chan struct{})
	provider.afterOpenDeath = func() { close(reachedDeathArm) }

	openErr := make(chan error, 1)
	go func() {
		openErr <- provider.openSession(context.Background(), session, SessionOptions{ID: session.ID(), Cwd: t.TempDir()})
	}()

	select {
	case <-commands:
	case <-time.After(2 * time.Second):
		t.Fatal("open_session never wrote its command")
	}

	provider.mu.Lock()
	var response chan Event
	for _, request := range provider.pending {
		if request.open {
			response = request.response
		}
	}
	provider.mu.Unlock()
	if response == nil {
		t.Fatal("open_session never registered a pending request")
	}

	// Publish shutdown, then wait until openSession has actually committed to
	// the provider-death arm before the response lands.
	if err := provider.closeProcess(); err != nil {
		t.Fatalf("close provider process: %v", err)
	}
	select {
	case <-reachedDeathArm:
	case err := <-openErr:
		t.Fatalf("open_session resolved without awaiting its response: %v", err)
	case <-time.After(2 * time.Second):
		t.Fatal("open_session never reached the provider-death arm")
	}

	raw := json.RawMessage(`{"type":"response","command":"open_session","success":true,"sessionId":"rpc-late","data":{"sessionId":"rpc-late"}}`)
	response <- Event{Type: "response", Raw: raw}
	close(response)

	select {
	case err := <-openErr:
		if err != nil {
			t.Fatalf("open session after provider death = %v, want success", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("open_session did not resolve after the response was delivered")
	}
}
