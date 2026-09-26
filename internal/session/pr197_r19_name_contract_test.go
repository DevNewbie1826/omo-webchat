package session

import "testing"

func TestPR197R19ResolverNameFollowsSuccessfulUpdateName(t *testing.T) {
	// Given a resolving store whose former durable seeded the chat's name.
	store := newResolvingCursorStore()
	store.setOwner("former-durable", "chat", "Before acquire")
	store.deleteOwner("former-durable")

	// When the bound-session persistence path successfully renames that chat.
	if err := store.UpdateName(t.Context(), "chat", "After rename", NameSourceUser); err != nil {
		t.Fatal(err)
	}
	cursor, err := store.CursorFor(t.Context(), "chat")
	if err != nil {
		t.Fatal(err)
	}

	// Then both reads of the same persisted name agree.
	name, ok := store.ChatName("chat")
	if cursor.Name != "After rename" || !ok || name != cursor.Name {
		t.Fatalf("successful name write is invisible to resolver: cursor=%q resolver=%q found=%t", cursor.Name, name, ok)
	}
}
