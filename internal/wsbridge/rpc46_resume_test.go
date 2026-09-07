package wsbridge

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
)

func TestRPC46ResumeFailureInfo(t *testing.T) {
	metadata := session.ErrorInfo{
		Code: "resume_failed", Message: "untrusted fallback detail", Dangling: true,
		StoredIdentity:   session.Cursor{SessionFile: "/saved/chat.jsonl", DurableSessionID: "durable-chat", Name: "saved", NameSource: "user", InPlace: true, WritePrepared: true},
		BranchCandidates: []string{"/saved/branch-a.jsonl", "/saved/branch-b.jsonl"},
		KnownLeaf:        "known", ObservedLeaf: "observed",
	}
	stable := func(wire string) error {
		t.Helper()
		err, ok := omorpc.ParseStableError(wire)
		if !ok {
			t.Fatalf("fixture is not a stable wire error: %q", wire)
		}
		return err
	}
	for _, tc := range []struct {
		name string
		err  error
		want string
	}{
		{"typed", stable("open_failed: QA_CONTEXT_LIMIT 311799 > 272000"), "open_failed: QA_CONTEXT_LIMIT 311799 > 272000"},
		{"no-space", stable("open_failed:no-space detail"), "open_failed:no-space detail"},
		{"spaces", stable("open_failed:   detail  \n"), "open_failed:   detail  \n"},
		{"multiline-markup", stable("open_failed:\t<img src=x onerror=alert(1)>\n" + strings.Repeat("T", 600)), "open_failed:\t<img src=x onerror=alert(1)>\n" + strings.Repeat("T", 600)},
		{"constructed", &omorpc.StableError{Code: omorpc.ErrCodeOpenFailed, Detail: "constructed detail"}, "open_failed: constructed detail"},
		{"empty", stable("open_failed:"), resumeFailedMessage},
		{"blank", stable("open_failed: \t\n\r "), resumeFailedMessage},
		{"arbitrary", errors.New("sensitive internal detail"), resumeFailedMessage},
		{"untyped-lookalike", errors.New("open_failed: must not be exposed"), resumeFailedMessage},
		{"other-stable", &omorpc.StableError{Code: omorpc.ErrCodeInvalidPath, Detail: "must not be exposed"}, resumeFailedMessage},
	} {
		for _, wrapping := range []string{"direct", "wrapped", "resume-cause", "wrapped-resume-cause"} {
			t.Run(tc.name+"/"+wrapping, func(t *testing.T) {
				err := tc.err
				want := session.ErrorInfo{Code: "resume_failed", Message: tc.want}
				if strings.Contains(wrapping, "resume-cause") {
					err = &session.ResumeError{Info: metadata, Cause: fmt.Errorf("open boundary: %w", err)}
					want = metadata
					want.Message = tc.want
				}
				if strings.HasPrefix(wrapping, "wrapped") {
					err = fmt.Errorf("resume boundary: %w", err)
				}
				if got := resumeFailureInfo(err); !reflect.DeepEqual(got, want) {
					t.Errorf("resumeFailureInfo = %#v, want %#v", got, want)
				}
				if metadata.Message != "untrusted fallback detail" {
					t.Fatal("resume classification mutated the original metadata")
				}
			})
		}
	}

	drift := &session.ExternalWriteError{KnownLeaf: "known", ObservedLeaf: "observed", Reason: "disk changed"}
	for _, tc := range []struct {
		name string
		err  error
		want session.ErrorInfo
	}{
		{"session-path-in-use", stable(omorpc.ErrCodeSessionPathInUse), session.ErrorInfo{Code: "session-active", Message: "session is active in another process"}},
		{"resume-session-path-in-use", &session.ResumeError{Info: metadata, Cause: stable(omorpc.ErrCodeSessionPathInUse)}, session.ErrorInfo{Code: "session-active", Message: "session is active in another process"}},
		{"session-active", &SessionActiveError{}, session.ErrorInfo{Code: "session-active", Message: "session is active in another process"}},
		{"adoption", cursorstore.ErrAdoptionRequired, session.ErrorInfo{Code: "adoption_required", Message: "session must be adopted before opening"}},
		{"external-write", drift, session.ErrorInfo{Code: "external-write-detected", Message: drift.Error(), KnownLeaf: "known", ObservedLeaf: "observed"}},
		{"typed-other-code", &session.ResumeError{Info: session.ErrorInfo{Code: "adoption_required", Message: "adopt first"}, Cause: stable("open_failed: not this classification")}, session.ErrorInfo{Code: "adoption_required", Message: "adopt first"}},
		{"nil-cause", &session.ResumeError{Info: metadata}, func() session.ErrorInfo { info := metadata; info.Message = resumeFailedMessage; return info }()},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := resumeFailureInfo(fmt.Errorf("boundary: %w", tc.err)); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("resumeFailureInfo = %#v, want %#v", got, tc.want)
			}
		})
	}
}

func TestRPC46ResumeFailureWireMetadata(t *testing.T) {
	const wire = "open_failed: no such saved session"
	cause, _ := omorpc.ParseStableError(wire)
	info := resumeFailureInfo(&session.ResumeError{Cause: cause, Info: session.ErrorInfo{
		Code: "resume_failed", Dangling: true,
		StoredIdentity:   session.Cursor{SessionFile: "/saved/chat.jsonl", DurableSessionID: "durable-chat"},
		BranchCandidates: []string{"/saved/branch.jsonl"},
	}})
	frame, err := mapError("error", "chat-a", session.Frame{Kind: session.FrameError, Command: "chat.send", RequestID: "original-request", Data: info})
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(mustJSON(t, frame), &got); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"type": "error", "sessionId": "chat-a", "command": "chat.send", "requestId": "original-request",
		"code": "resume_failed", "message": wire, "dangling": true, "storedIdentity": "/saved/chat.jsonl",
		"candidates": []any{map[string]any{"id": "/saved/branch.jsonl", "name": "/saved/branch.jsonl", "hostPath": "/saved/branch.jsonl"}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("resume error wire = %#v, want %#v", got, want)
	}
}

// Use the same daemon, manager, store and bridge for both browser sockets.
func rpc46ResumeSibling(t *testing.T, h *inPlaceBridgeHarness, chatID string) string {
	t.Helper()
	body, err := os.ReadFile(h.path)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(filepath.Dir(h.path), chatID+".jsonl")
	body = bytes.Replace(body, []byte("durable-"+strings.TrimSuffix(filepath.Base(h.path), ".jsonl")), []byte("durable-"+chatID), 1)
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := h.daemon.LoadSessionFile(path); err != nil {
		t.Fatal(err)
	}
	if err := h.store.SaveChat(cursorstore.Chat{ID: chatID, WorkspaceID: "ws-1", CWD: filepath.Dir(path), Name: chatID, SessionFile: path, DurableSessionID: "durable-" + chatID, SessionProvenance: cursorstore.SessionProvenanceInPlace}); err != nil {
		t.Fatal(err)
	}
	return path
}

func rpc46ResumeHistory(t *testing.T, frames *collector) int {
	t.Helper()
	count := 0
	for {
		frame := frames.next(t, "entries")
		entries, ok := frame["entries"].([]any)
		if !ok {
			t.Fatalf("invalid history frame: %#v", frame)
		}
		count += len(entries)
		if frame["final"] == true {
			return count
		}
	}
}

func TestRPC46ResumeIdleFailureReachesSocket(t *testing.T) {
	for _, operation := range []string{"send", "query"} {
		for _, tc := range []struct {
			name, wire, code, message string
			opens                     int
			dangling                  bool
		}{
			{"open-failed", "open_failed: QA_CONTEXT_LIMIT 311799 > 272000", "resume_failed", "open_failed: QA_CONTEXT_LIMIT 311799 > 272000", 1, false},
			{"noncanonical", "open_failed:  preserve spacing  ", "resume_failed", "open_failed:  preserve spacing  ", 1, false},
			{"multiline-markup", "open_failed:<img src=x onerror=alert(1)>\n" + strings.Repeat("T", 600), "resume_failed", "open_failed:<img src=x onerror=alert(1)>\n" + strings.Repeat("T", 600), 1, false},
			{"dangling", "open_failed: no such saved session", "resume_failed", "open_failed: no such saved session", 1, true},
			{"arbitrary", "sensitive internal detail", "resume_failed", resumeFailedMessage, 1, false},
			{"empty", "open_failed:", "resume_failed", resumeFailedMessage, 1, false},
			{"blank", "open_failed: \t\n ", "resume_failed", resumeFailedMessage, 1, false},
			{"session-path-in-use", omorpc.ErrCodeSessionPathInUse, "session-active", "session is active in another process", 3, false},
		} {
			t.Run(operation+"/"+tc.name, func(t *testing.T) {
				const chatID = "rpc46-a"
				h := newInPlaceBridgeHarnessWithHistory(t, chatID, 240)
				siblingPath := rpc46ResumeSibling(t, h, "rpc46-b")
				conn, frames := h.connect(t)
				writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": chatID})
				frames.next(t, "ready")
				if got := rpc46ResumeHistory(t, frames); got != 240 {
					t.Fatalf("initial history entries = %d, want 240", got)
				}
				awaitCommandFence(t, conn, frames)
				stale, ok := h.manager.Get(chatID)
				if !ok {
					t.Fatal("chat was not acquired")
				}
				sibling, siblingFrames := h.connect(t)
				writeClient(t, sibling, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "rpc46-b"})
				siblingFrames.next(t, "ready")
				if got := rpc46ResumeHistory(t, siblingFrames); got != 240 {
					t.Fatalf("sibling history entries = %d, want 240", got)
				}
				awaitCommandFence(t, sibling, siblingFrames)
				beforeChat, err := h.store.GetChat(chatID)
				if err != nil {
					t.Fatal(err)
				}
				beforeDisk, err := os.ReadFile(h.path)
				if err != nil {
					t.Fatal(err)
				}
				beforeOpens := h.daemon.RequestCountForPath(omorpc.CmdOpenSession, h.path)
				h.daemon.UnloadSession(h.path)
				ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
				defer cancel()
				if _, err := stale.QueryState(ctx); !errors.Is(err, session.ErrSessionResumable) {
					t.Fatalf("evicted route = %v, want ErrSessionResumable", err)
				}
				if tc.wire == omorpc.ErrCodeSessionPathInUse {
					h.daemon.FailOpenPath(h.path, tc.wire, tc.opens)
				} else {
					h.daemon.FailNext(omorpc.CmdOpenSession, tc.wire)
				}
				command := "get_commands"
				const requestID = "rpc46-rejected-draft"
				if operation == "send" {
					command = "chat.send"
					writeClient(t, conn, map[string]any{"type": command, "sessionId": chatID, "requestId": requestID, "run": map[string]any{"kind": "prompt", "message": "rpc46-resume-once"}})
				} else {
					writeClient(t, conn, map[string]any{"type": "chat.commands", "sessionId": chatID})
				}
				failure := frames.next(t, "error")
				if failure["code"] != tc.code || failure["message"] != tc.message || failure["sessionId"] != chatID || failure["command"] != command {
					t.Errorf("resume failure = %#v; want code=%q message=%q command=%q", failure, tc.code, tc.message, command)
				}
				if operation == "send" && failure["requestId"] != requestID {
					t.Errorf("failed draft lost its original requestId: %#v", failure)
				}
				if tc.code == "resume_failed" && (failure["storedIdentity"] != h.path || failure["dangling"] != tc.dangling) {
					t.Errorf("resume failure lost cursor metadata: %#v", failure)
				}
				awaitCommandFence(t, conn, frames)
				if got := h.daemon.RequestCountForPath(omorpc.CmdOpenSession, h.path) - beforeOpens; got != tc.opens {
					t.Errorf("resume open attempts = %d, want %d", got, tc.opens)
				}
				if got := h.daemon.RequestCountForPath(omorpc.CmdPrompt, h.path); got != 0 {
					t.Errorf("failed resume forwarded %d prompts", got)
				}
				frames.mu.Lock()
				pending := append([]json.RawMessage(nil), frames.frames...)
				frames.mu.Unlock()
				for _, raw := range pending {
					var frame map[string]any
					if err := json.Unmarshal(raw, &frame); err != nil {
						t.Fatal(err)
					}
					if frame["type"] == "ready" || frame["type"] == "entries" || frame["type"] == "run.started" || frame["type"] == "run.done" || frame["type"] == "message" || (frame["type"] == "ack" && frame["requestId"] == requestID) {
						t.Errorf("failed resume produced replacement history or send acceptance: %s", raw)
					}
				}
				afterChat, err := h.store.GetChat(chatID)
				if err != nil {
					t.Fatal(err)
				}
				afterDisk, err := os.ReadFile(h.path)
				if err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(afterChat, beforeChat) || !bytes.Equal(afterDisk, beforeDisk) {
					t.Error("failed resume changed the saved chat or durable history")
				}
				for _, snapshot := range h.daemon.SessionSnapshots() {
					if snapshot.Path == h.path && (snapshot.EntryCount != 240 || len(snapshot.Prompts) != 0) {
						t.Errorf("rejected draft entered provider history: %#v", snapshot)
					}
				}
				h.daemon.SetPromptScript(siblingPath, map[string]any{"type": omorpctest.EventAgentStart}, map[string]any{"type": omorpctest.EventAgentSettled, "reason": "end_turn"})
				writeClient(t, sibling, map[string]any{"type": "chat.send", "sessionId": "rpc46-b", "requestId": "sibling-send", "run": map[string]any{"kind": "prompt", "message": "sibling remains usable"}})
				nextSuccessfulSendAcks(t, siblingFrames, "sibling-send")
				if done := siblingFrames.next(t, "run.done"); done["sessionId"] != "rpc46-b" {
					t.Fatalf("sibling completion = %#v", done)
				}
				if got := h.daemon.RequestCountForPath(omorpc.CmdPrompt, siblingPath); got != 1 {
					t.Errorf("sibling prompts = %d, want 1", got)
				}
			})
		}
	}
}
