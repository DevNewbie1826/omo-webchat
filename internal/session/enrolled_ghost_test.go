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
		if s.ID() != h.opened.State.SessionID || s.sessionFile != cur.SessionFile {
			t.Fatal("ghost heal changed durable identity/path")
		}
		h.stream(r, "healed-ghost-live")
		mustOK(t, h.m.StopContext(t.Context(), h.chat.id))
		if h.d.RequestCount(omorpc.CmdCloseSession) != 0 {
			t.Fatal("webchat ended healed retained ghost instead of detaching")
		}
		mustOK(t, h.main.Close())
		if len(h.d.LiveSessions()) != 1 {
			t.Fatal("retained ghost did not stay live after main residual detached")
		}
		t.Log("matching ghost selected, healed via path open, streamed, retained live after disconnect")
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
