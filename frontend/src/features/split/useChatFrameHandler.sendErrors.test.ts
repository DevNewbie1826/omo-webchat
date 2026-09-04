import { describe, expect, it } from "vitest";
import type { ChatServerFrame } from "../../lib/chatWs";
import { sendCommandFailureOf } from "./useChatFrameHandler";

type ErrorFrame = Extract<ChatServerFrame, { readonly type: "error" }>;

function failure(command?: string, code?: ErrorFrame["code"]): ErrorFrame {
  return {
    type: "error",
    message: "rejected",
    ...(command !== undefined ? { command } : {}),
    ...(code !== undefined ? { code } : {}),
  };
}

describe("sendCommandFailureOf", () => {
  it.each([
    "chat.send", "chat.compact", "chat.abort",
    "prompt", "steer", "follow_up", "compact", "abort",
  ])("classifies provider_error for the %s command namespace", (command) => {
    expect(sendCommandFailureOf(failure(command, "provider_error"))).toEqual({ message: "rejected" });
  });

  it.each([
    "prompt_in_flight", "compaction_in_flight", "bad_send", "send_failed",
    "compact_failed", "send_backpressure",
  ] as const)("classifies the %s send-path code independently of settlement", (code) => {
    expect(sendCommandFailureOf(failure(undefined, code))).toEqual({ message: "rejected" });
  });

  it("does not classify unrelated provider failures", () => {
    expect(sendCommandFailureOf(failure("get_entries", "provider_error"))).toBeNull();
  });
});
