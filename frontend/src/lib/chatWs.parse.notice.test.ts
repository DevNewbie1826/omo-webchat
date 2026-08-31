import { describe, expect, it } from "vitest";
import { parseChatServerFrame } from "./chatWs";

describe("parseChatServerFrame notice", () => {
  it("parses a valid notice with kind and object payload", () => {
    expect(
      parseChatServerFrame({
        type: "notice",
        sessionId: "chat-1",
        kind: "retry_fallback_applied",
        payload: { from: "zai/glm", to: "moonshot/kimi", chainKey: "main", reason: "rate_limited" },
      }),
    ).toEqual({
      type: "notice",
      sessionId: "chat-1",
      kind: "retry_fallback_applied",
      payload: { from: "zai/glm", to: "moonshot/kimi", chainKey: "main", reason: "rate_limited" },
    });
  });

  it("parses a notice whose payload is absent", () => {
    expect(parseChatServerFrame({ type: "notice", sessionId: "chat-1", kind: "auto_retry_start" })).toEqual({
      type: "notice",
      sessionId: "chat-1",
      kind: "auto_retry_start",
    });
  });

  it("sanitizes the payload instead of forwarding raw JSON", () => {
    const frame = parseChatServerFrame({
      type: "notice",
      sessionId: "chat-1",
      kind: "extension_notify",
      payload: JSON.parse('{"message":"hi","__proto__":{"bad":true}}'),
    });
    const payload = frame?.type === "notice" ? frame.payload : undefined;
    expect(payload).toEqual({ message: "hi" });
    expect(Object.keys(payload ?? {}).includes("__proto__")).toBe(false);
  });

  it("rejects a present-but-malformed payload", () => {
    expect(parseChatServerFrame({ type: "notice", sessionId: "chat-1", kind: "k", payload: "nope" })).toBeNull();
    expect(parseChatServerFrame({ type: "notice", sessionId: "chat-1", kind: "k", payload: 5 })).toBeNull();
    expect(parseChatServerFrame({ type: "notice", sessionId: "chat-1", kind: "k", payload: ["x"] })).toBeNull();
    expect(parseChatServerFrame({ type: "notice", sessionId: "chat-1", kind: "k", payload: null })).toBeNull();
  });

  it("rejects a missing, empty, or non-string kind", () => {
    expect(parseChatServerFrame({ type: "notice", sessionId: "chat-1", kind: "" })).toBeNull();
    expect(parseChatServerFrame({ type: "notice", sessionId: "chat-1" })).toBeNull();
    expect(parseChatServerFrame({ type: "notice", sessionId: "chat-1", kind: 5 })).toBeNull();
  });

  it("rejects a session-scoped notice without a sessionId", () => {
    expect(parseChatServerFrame({ type: "notice", kind: "auto_retry_start" })).toBeNull();
  });
});
