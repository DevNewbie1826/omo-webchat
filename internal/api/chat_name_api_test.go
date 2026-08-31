package api

import (
	"testing"
	"time"
)

func TestAutoTitleTitlesChat_whenFirstPlainPromptSent(t *testing.T) {
	// Given: a default-named chat attached over WS.
	env := newNameTitleEnv(t)
	record := env.startChat(t, "auto-title-qa")
	prompt := "Go에서 JSON을 파싱하려면 어떻게 해야 하나요?"

	// When: the first chat.send carries a plain prompt.
	env.sendPrompt(t, record.ID, prompt)
	env.frames.waitFor(t, "run.done", 3*time.Second)

	// Then: the client is told, the store is retitled, and the provider
	// session received the same name.
	frame := env.frames.waitForNameFrame(t, "auto", 3*time.Second)
	if frame.Name != prompt || frame.SessionID != record.ID {
		t.Fatalf("chat.name frame = %+v, want name %q for session %q", frame, prompt, record.ID)
	}
	got := env.waitForStoreChat(t, record.ID, prompt, "auto")
	if got.NameSource != "auto" {
		t.Fatalf("name source = %q, want auto", got.NameSource)
	}
	env.waitForProviderLog(t, "set_session_name", prompt)
}

func TestAutoTitleSkipsSlashPrompt_thenTitlesNextPlainPrompt(t *testing.T) {
	// Given: a default-named chat attached over WS.
	env := newNameTitleEnv(t)
	record := env.startChat(t, "slash-first-qa")

	// When: the first prompt is a slash command.
	env.sendPrompt(t, record.ID, "/help please")
	env.frames.waitFor(t, "run.done", 3*time.Second)

	// Then: no retitle happened.
	if env.frames.hasType("chat.name") {
		t.Fatalf("slash prompt retitled the chat: %s", env.frames.types())
	}
	got, err := env.st.GetChat(env.ws.ID, record.ID)
	if err != nil {
		t.Fatalf("get chat: %v", err)
	}
	if got.Name != "slash-first-qa" || got.NameSource != "default" {
		t.Fatalf("after slash prompt name = %q source %q, want slash-first-qa/default", got.Name, got.NameSource)
	}

	// When: the next prompt is plain.
	env.sendPrompt(t, record.ID, "Now a plain question")

	// Then: that prompt titles the chat.
	frame := env.frames.waitForNameFrame(t, "auto", 3*time.Second)
	if frame.Name != "Now a plain question" {
		t.Fatalf("chat.name frame = %+v, want name %q", frame, "Now a plain question")
	}
	env.waitForStoreChat(t, record.ID, "Now a plain question", "auto")
}

func TestAutoTitleNeverOverridesUserRename(t *testing.T) {
	// Given: a live chat the user already renamed.
	env := newNameTitleEnv(t)
	record := env.startChat(t, "user-name-qa")
	env.rename(t, record.ID, "Kept user name")

	// When: a plain prompt arrives after the user rename.
	env.sendPrompt(t, record.ID, "a later plain prompt")
	env.frames.waitFor(t, "run.done", 3*time.Second)

	// Then: the stored name is untouched and no name frame was sent.
	if env.frames.hasType("chat.name") {
		t.Fatalf("auto-title overrode a user rename: %s", env.frames.types())
	}
	got, err := env.st.GetChat(env.ws.ID, record.ID)
	if err != nil {
		t.Fatalf("get chat: %v", err)
	}
	if got.Name != "Kept user name" || got.NameSource != "user" {
		t.Fatalf("stored name = %q source %q, want Kept user name/user", got.Name, got.NameSource)
	}
}
