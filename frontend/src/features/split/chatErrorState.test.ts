import { describe, expect, it } from "vitest";
import type { ChatServerFrame } from "../../lib/chatWs";
import { isPromptTerminalError } from "./chatErrorState";

type ErrorFrame = Extract<ChatServerFrame, { readonly type: "error" }>;

// The backend forwards the provider's raw RPC command string on error frames
// (see internal/chat/response_mapping.go: prompt, steer, follow_up, set_model,
// set_thinking_level, get_state, get_session_stats, get_commands,
// get_available_models, get_entries, new_session, switch_session,
// extension_ui_response). The parse boundary must
// accept any of them as an open string, not a fictional narrow literal union.
function errorFrame(command: string, code?: string): ErrorFrame {
  return {
    type: "error",
    message: "provider rejected request",
    command,
    ...(code ? { code } : {}),
  };
}

describe("error frame command boundary", () => {
  it("treats only the prompt command as prompt-terminal", () => {
    expect(isPromptTerminalError(errorFrame("prompt"))).toBe(true);
    expect(isPromptTerminalError(errorFrame("set_model"))).toBe(false);
    expect(isPromptTerminalError(errorFrame("set_thinking_level"))).toBe(false);
    expect(isPromptTerminalError(errorFrame("query"))).toBe(false);
  });

  it("accepts real backend RPC commands that are not prompt", () => {
    for (const command of ["steer", "follow_up", "get_state", "get_entries", "switch_session", "extension_ui_response"]) {
      expect(isPromptTerminalError(errorFrame(command))).toBe(false);
    }
  });

  it("still honors terminal codes regardless of command", () => {
    expect(isPromptTerminalError(errorFrame("get_state", "pi_eof"))).toBe(true);
    expect(isPromptTerminalError(errorFrame("set_model", "no_session"))).toBe(true);
  });
});
