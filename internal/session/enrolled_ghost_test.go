package session

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func TestEnrolledGhost(t *testing.T) {
	t.Run("heal", func(t *testing.T) {
		// Given a listed ghost without a durable id in list_sessions (the fake's
		// optional field is absent); exact path must still select the ghost.
		h := newEnrolledHarness(t)
		h.d.MakeGhost(h.opened.State.SessionFile)
		cur := h.store.stored(h.chat.id)
		cur.DurableSessionID = ""
		mustOK(t, h.store.SaveCursor(t.Context(), h.chat.id, cur))
		candidate, _, found, err := h.m.attachEnrolled(t.Context(), cur)
		mustOK(t, err)
		if !found || candidate.SessionID != h.opened.SessionID || candidate.State.SessionFile != cur.SessionFile {
			t.Fatal("matching unknown_session ghost was silently skipped")
		}
		r := newRecorder(64)
		s, _, detach, err := h.m.Acquire(t.Context(), h.chat, r)
		mustOK(t, err)
		defer detach()
		// The heal is the host's same-route attach on a DEDICATED connection: the
		// ghost's listed handle and durable identity survive, and webchat must not
		// take the session over on main (mainAttached marks exactly that fallback).
		if s.ID() != h.opened.State.SessionID || s.RoutingID() != h.opened.SessionID || s.sessionFile != cur.SessionFile {
			t.Fatalf("ghost heal changed identity: durable=%q route=%q file=%q (listed route %q)", s.ID(), s.RoutingID(), s.sessionFile, h.opened.SessionID)
		}
		if s.client == h.main || s.attachClient == nil || s.mainAttached {
			t.Fatal("ghost heal used the main residual instead of a dedicated connection")
		}
		// The external owner's own attachment survived the heal (1 -> 2).
		if got := h.d.Attachments(h.opened.State.SessionFile); got != 2 {
			t.Fatalf("attachments after the ghost heal = %d, want the owner's 1 + webchat's 1", got)
		}
		// The owner's session-scoped event reaches the WS subscriber after the heal.
		h.stream(r, "healed-ghost-live")
		mustOK(t, h.m.StopContext(t.Context(), h.chat.id))
		h.assertDetached()
		if len(h.d.LiveSessions()) != 1 {
			t.Fatal("healed retained ghost did not stay live after webchat detached")
		}
		t.Log("ghost healed on a dedicated same-route attach: identity retained, owner attachment survived, owner event streamed, detach left close_session=0")
	})

	t.Run("durable_match", func(t *testing.T) {
		h := newEnrolledHarness(t)
		h.d.MakeGhost(h.opened.State.SessionFile)
		mustOK(t, h.m.CloseAll(t.Context()))
		p := newEnrolledWireProxy(t, h.d.SocketPath(), func(frame map[string]any) {
			if frame["command"] == omorpc.CmdListSessions && frame["success"] == true {
				data, _ := frame["data"].(map[string]any)
				for _, raw := range data["sessions"].([]any) {
					route := raw.(map[string]any)
					route["durableSessionId"] = h.opened.State.SessionID
				}
			}
		})
		main, err := omorpc.Dial(t.Context(), p.path)
		mustOK(t, err)
		t.Cleanup(func() { _ = main.Close() })
		h.m = NewManager(Config{Client: main, Store: h.store})
		t.Cleanup(func() { _ = h.m.CloseAll(context.Background()) })
		cur := h.store.stored(h.chat.id)
		candidate, _, found, err := h.m.attachEnrolled(t.Context(), cur)
		mustOK(t, err)
		if !found || candidate.SessionID != h.opened.SessionID {
			t.Fatal("matching listed durable ghost was silently skipped")
		}
	})

	t.Run("nonmatching_unknown_skipped", func(t *testing.T) {
		h := newEnrolledHarness(t)
		h.d.MakeGhost(h.opened.State.SessionFile)
		for _, cur := range []Cursor{
			{DurableSessionID: "another-durable", SessionFile: h.opened.State.SessionFile},
			{SessionFile: h.chat.cwd + "/another.jsonl"},
		} {
			_, _, found, err := h.m.attachEnrolled(t.Context(), cur)
			mustOK(t, err)
			if found {
				encoded, _ := json.Marshal(cur)
				t.Fatalf("non-matching unknown route accepted for %s", encoded)
			}
		}
		if h.d.RequestCount(omorpc.CmdOpenSession) != 1 {
			t.Fatal("discovery healed an unrelated ghost")
		}
	})
}
