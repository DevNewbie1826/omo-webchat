package omorpc_test

// Daemon-side contract tests for the media_placeholders capability
// advertisement on the multi-session daemon path. On this path a
// connection's capability set starts empty and is populated only by the
// session-less set_client_info record the client sends during negotiation;
// a session the connection opens inherits exactly that set. Spawn-time
// environment variables are invisible to an already-running daemon, so the
// handshake is the advertisement the daemon-side view actually reads.

import (
	"context"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

// countCapability counts exact occurrences of one capability in a list.
func countCapability(caps []string, want string) int {
	n := 0
	for _, c := range caps {
		if c == want {
			n++
		}
	}
	return n
}

const handshakeAwait = 10 * time.Second

// handshakeCapabilities decodes the capabilities array of a recorded
// set_client_info request.
func handshakeCapabilities(t *testing.T, request map[string]any) []string {
	t.Helper()
	raw, ok := request["capabilities"].([]any)
	if !ok {
		t.Fatalf("set_client_info carries no capabilities array: %v", request)
	}
	caps := make([]string, 0, len(raw))
	for _, item := range raw {
		s, _ := item.(string)
		caps = append(caps, s)
	}
	return caps
}

// requireAdvertised asserts each capability the client relies on travels in
// the record exactly once — present, and idempotent (no duplicates).
func requireAdvertised(t *testing.T, caps []string) {
	t.Helper()
	for _, want := range []string{"extension_events", "media_placeholders"} {
		if got := countCapability(caps, want); got != 1 {
			t.Fatalf("handshake capabilities %v: %s appears %d times, want exactly once", caps, want, got)
		}
	}
}

// TestDialAdvertisesMediaPlaceholdersInHandshake pins the daemon-side view:
// Dial itself must deliver a set_client_info record carrying
// extension_events and media_placeholders (exactly once each, with a
// positive render width) BEFORE the first open_session, and a session the
// connection opens inherits that capability set — the view the engine
// consults when deciding whether media travels as placeholders.
// Reconnection re-advertises on the new connection epoch.
func TestDialAdvertisesMediaPlaceholdersInHandshake(t *testing.T) {
	d := newMediaDaemon(t)
	c := dialMediaClient(t, d)

	if !d.AwaitClientInfoCount(1, handshakeAwait) {
		t.Fatal("daemon never received the set_client_info capability handshake during Dial")
	}
	first := d.LastRequest(omorpc.CmdSetClientInfo)
	requireAdvertised(t, handshakeCapabilities(t, first))
	if width, _ := first["width"].(float64); width <= 0 {
		t.Fatalf("set_client_info width = %v, want a positive render width", first["width"])
	}

	// The session the connection opens inherits the advertised set.
	opened := openMediaSession(t, c)
	requireAdvertised(t, d.SessionClientCapabilities(opened.State.SessionFile))

	// Handshake ordering: the capability record precedes the first
	// open_session of the connection — the ordering under which the set
	// governs that session.
	handshakeAt, openAt := -1, -1
	for i, request := range d.Requests() {
		switch typ, _ := request["type"].(string); typ {
		case omorpc.CmdSetClientInfo:
			handshakeAt = i
		case omorpc.CmdOpenSession:
			if openAt == -1 {
				openAt = i
			}
		}
	}
	if openAt < handshakeAt {
		t.Fatalf("open_session (index %d) preceded the set_client_info handshake (index %d)", openAt, handshakeAt)
	}

	// Reconnection: every new connection epoch re-advertises the same set.
	// Subscribe to the epoch transition first, so the reconnect is only
	// triggered once the death of the old epoch has been observed — never
	// racing it.
	died := make(chan struct{}, 1)
	c.SetEpochChangeObserver(func(prev, next omorpc.EpochToken) {
		if next == (omorpc.EpochToken{}) {
			died <- struct{}{}
		}
	})
	d.DropConnections()
	ctx, cancel := context.WithTimeout(context.Background(), handshakeAwait)
	defer cancel()
	select {
	case <-died:
	case <-ctx.Done():
		t.Fatal("connection epoch death was not observed after DropConnections")
	}
	if err := c.EnsureConnected(ctx); err != nil {
		t.Fatalf("EnsureConnected after drop: %v", err)
	}
	if !d.AwaitClientInfoCount(2, handshakeAwait) {
		t.Fatal("reconnection did not re-send the set_client_info capability handshake")
	}
	requireAdvertised(t, handshakeCapabilities(t, d.LastRequest(omorpc.CmdSetClientInfo)))
	reopened := openMediaSession(t, c)
	requireAdvertised(t, d.SessionClientCapabilities(reopened.State.SessionFile))
}

// TestDialToleratesHandshakeRejection pins that an engine which rejects the
// capability record (for example one predating the record) still dials and
// serves sessions: advertisement is best-effort and must never fail the
// handshake that get_protocol_info already settled.
func TestDialToleratesHandshakeRejection(t *testing.T) {
	d := newMediaDaemon(t)
	d.FailNext(omorpc.CmdSetClientInfo, omorpc.ErrCodeUnknownSession)
	c := dialMediaClient(t, d)
	openMediaSession(t, c)
}
