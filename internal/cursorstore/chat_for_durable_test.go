package cursorstore

import (
	"path/filepath"
	"testing"
)

func TestChatForDurable(t *testing.T) {
	const ws = "ws"

	durableChat := func(id, durable, provider, name string, created, lastUsed int64) Chat {
		c := testChat(id, ws)
		c.Name = name
		c.DurableSessionID = durable
		c.Provider = provider
		c.CreatedAt = created
		c.LastUsedAt = lastUsed
		return c
	}

	tests := []struct {
		name      string
		chats     []Chat
		durableID string
		wantID    string
		wantName  string
	}{
		{
			name: "match",
			chats: []Chat{
				durableChat("other", "dur-other", "", "other chat", 10, 10),
				durableChat("owner", "dur-1", "omo", "owned chat", 20, 20),
			},
			durableID: "dur-1",
			wantID:    "owner",
			wantName:  "owned chat",
		},
		{
			name: "no match",
			chats: []Chat{
				durableChat("owner", "dur-1", "", "owned chat", 20, 20),
			},
			durableID: "missing",
		},
		{
			name: "empty id",
			chats: []Chat{
				durableChat("blank", "", "", "blank durable", 20, 20),
			},
			durableID: "",
		},
		{
			name: "non-launchable provider hidden",
			chats: []Chat{
				durableChat("hidden", "dur-1", "codex", "foreign", 100, 100),
				durableChat("other", "dur-other", "senpi", "nearby", 1, 1),
			},
			durableID: "dur-1",
		},
		{
			name: "duplicate claim determinism",
			chats: []Chat{
				// Newer LastUsedAt wins over a later CreatedAt and a smaller ID.
				durableChat("older-used", "dur-dup", "omo", "older used", 9_000, 100),
				durableChat("newer-used", "dur-dup", "", "newer used", 1, 200),
				// A non-launchable claimant with an even newer stamp stays hidden.
				durableChat("foreign", "dur-dup", "codex", "foreign", 9_000, 999),
			},
			durableID: "dur-dup",
			wantID:    "newer-used",
			wantName:  "newer used",
		},
		{
			name: "duplicate created at then id",
			chats: []Chat{
				durableChat("m-early", "dur-tie", "omo", "early", 10, 50),
				durableChat("m-late", "dur-tie", "senpi", "late", 20, 50),
				durableChat("a-tie", "dur-tie", "", "tie-a", 30, 40),
				durableChat("b-tie", "dur-tie", "omo", "tie-b", 30, 40),
			},
			durableID: "dur-tie",
			wantID:    "m-late",
			wantName:  "late",
		},
		{
			name: "duplicate id tie break",
			chats: []Chat{
				durableChat("b", "dur-id", "omo", "bee", 30, 40),
				durableChat("a", "dur-id", "", "aye", 30, 40),
			},
			durableID: "dur-id",
			wantID:    "a",
			wantName:  "aye",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s := mustOpen(t, filepath.Join(t.TempDir(), "state.json"))
			if err := s.SaveWorkspace(testWorkspace(ws)); err != nil {
				t.Fatalf("SaveWorkspace: %v", err)
			}
			for _, chat := range tc.chats {
				if err := s.SaveChat(chat); err != nil {
					t.Fatalf("SaveChat(%s): %v", chat.ID, err)
				}
			}

			got, ok := s.ChatForDurable(tc.durableID)
			if tc.wantID == "" {
				if ok || got != (Chat{}) {
					t.Fatalf("ChatForDurable(%q) = %+v, %v; want zero, false", tc.durableID, got, ok)
				}
				return
			}
			if !ok {
				t.Fatalf("ChatForDurable(%q) ok=false; want %s", tc.durableID, tc.wantID)
			}
			if got.ID != tc.wantID || got.Name != tc.wantName || got.DurableSessionID != tc.durableID {
				t.Fatalf("ChatForDurable(%q) = %+v; want id %s name %q", tc.durableID, got, tc.wantID, tc.wantName)
			}
		})
	}
}
