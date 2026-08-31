package api

import (
	"testing"
	"time"
)

func TestRenameChatMarksUserSource_andForwardsToLiveProvider(t *testing.T) {
	// Given: a default-named chat with a live provider session.
	env := newNameTitleEnv(t)
	record := env.startChat(t, "rename-qa")

	// When: the user renames the chat over REST.
	env.rename(t, record.ID, "Renamed by user")

	// Then: the store records the user as the name source and the live
	// provider session received set_session_name.
	got := env.waitForStoreChat(t, record.ID, "Renamed by user", "user")
	if got.Name != "Renamed by user" || got.NameSource != "user" {
		t.Fatalf("stored name = %q source %q, want Renamed by user/user", got.Name, got.NameSource)
	}
	env.waitForProviderLog(t, "set_session_name", "Renamed by user")
}

func TestProviderNameEventReplacesAutoTitle(t *testing.T) {
	// Given: a chat already auto-titled by its first prompt.
	env := newNameTitleEnv(t)
	record := env.startChat(t, "provider-auto-qa")
	env.sendPrompt(t, record.ID, "initial plain prompt")
	env.frames.waitFor(t, "run.done", 3*time.Second)
	env.waitForStoreChat(t, record.ID, "initial plain prompt", "auto")

	// When: the provider reports a new session name.
	env.emitProviderName(t, "Provider-decided title")

	// Then: the client sees the provider frame and the store adopts the
	// provider name while keeping the auto source.
	frame := env.frames.waitForNameFrame(t, "provider", 3*time.Second)
	if frame.Name != "Provider-decided title" || frame.SessionID != record.ID {
		t.Fatalf("chat.name frame = %+v, want name Provider-decided title for session %q", frame, record.ID)
	}
	env.waitForStoreChat(t, record.ID, "Provider-decided title", "auto")
}

func TestProviderNameEventKeepsUserRename(t *testing.T) {
	// Given: a live chat the user already renamed.
	env := newNameTitleEnv(t)
	record := env.startChat(t, "provider-user-qa")
	env.rename(t, record.ID, "Kept user name")

	// When: the provider reports a name while the user owns the title. The
	// second event is the barrier proving the first event's persistence
	// callback already ran.
	env.emitProviderName(t, "First provider attempt")
	env.frames.waitForNameFrameCount(t, "provider", 1, 3*time.Second)
	env.emitProviderName(t, "Second provider attempt")
	env.frames.waitForNameFrameCount(t, "provider", 2, 3*time.Second)

	// Then: the user's name survived both provider events.
	got, err := env.st.GetChat(env.ws.ID, record.ID)
	if err != nil {
		t.Fatalf("get chat: %v", err)
	}
	if got.Name != "Kept user name" || got.NameSource != "user" {
		t.Fatalf("stored name = %q source %q, want Kept user name/user", got.Name, got.NameSource)
	}
}
