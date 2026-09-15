import { describe, expect, it } from "vitest";
import { parseChatServerFrame } from "./chatWs";

describe("parseChatServerFrame assistant failure fields", () => {
  it("preserves errorMessage and stopReason on a live message frame", () => {
    expect(
      parseChatServerFrame({
        type: "message",
        sessionId: "chat-1",
        message: {
          role: "assistant",
          content: "partial",
          errorMessage: "provider overloaded",
          stopReason: "error",
        },
      }),
    ).toEqual({
      type: "message",
      sessionId: "chat-1",
      message: {
        role: "assistant",
        blocks: [{ kind: "text", text: "partial" }],
        errorMessage: "provider overloaded",
        stopReason: "error",
      },
    });
  });

  it("keeps an empty errorMessage string so the renderer can fall back to a generic label", () => {
    const frame = parseChatServerFrame({
      type: "message",
      sessionId: "chat-1",
      message: { role: "assistant", content: "", errorMessage: "", stopReason: "aborted" },
    });
    expect(frame?.type === "message" && frame.message.errorMessage).toBe("");
    expect(frame?.type === "message" && frame.message.stopReason).toBe("aborted");
  });

  it("parses frames without the new fields exactly as before (backward compatibility)", () => {
    expect(
      parseChatServerFrame({
        type: "message",
        sessionId: "chat-1",
        message: { role: "assistant", content: "hello" },
      }),
    ).toEqual({
      type: "message",
      sessionId: "chat-1",
      message: { role: "assistant", blocks: [{ kind: "text", text: "hello" }] },
    });
  });

  it("rejects present-but-malformed failure fields", () => {
    expect(
      parseChatServerFrame({
        type: "message",
        sessionId: "chat-1",
        message: { role: "assistant", content: "x", errorMessage: 5 },
      }),
    ).toBeNull();
    expect(
      parseChatServerFrame({
        type: "message",
        sessionId: "chat-1",
        message: { role: "assistant", content: "x", stopReason: true },
      }),
    ).toBeNull();
  });
});
