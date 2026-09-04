import { describe, expect, it } from "vitest";
import type { ChatServerFrame } from "../../lib/chatWs";
import { isPromptTerminalError } from "./chatErrorState";

type ErrorFrame = Extract<ChatServerFrame, { readonly type: "error" }>;

// Error frames may contain any string in the command field. Classification
// must keep unrecognized values on the non-terminal UI path.
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

  it("keeps other observed command values non-terminal", () => {
    for (const command of ["steer", "follow_up", "get_state", "get_entries", "switch_session", "extension_ui_response"]) {
      expect(isPromptTerminalError(errorFrame(command))).toBe(false);
    }
  });

  it("still honors terminal codes regardless of command", () => {
    expect(isPromptTerminalError(errorFrame("get_state", "pi_eof"))).toBe(true);
    expect(isPromptTerminalError(errorFrame("set_model", "no_session"))).toBe(true);
  });

  // An error frame with the session_unloaded code leaves the pane usable and
  // does not expose terminal UI.
  it("treats session_unloaded as resumable, never terminal", () => {
    expect(isPromptTerminalError(errorFrame("close_session", "session_unloaded"))).toBe(false);
  });
});
