import { describe, expect, it } from "vitest";
import { parseChatServerFrame } from "./chatWs";

describe("parseChatServerFrame notice", () => {
  it("parses a valid notice with kind and object payload", () => {
    expect(
      parseChatServerFrame({
        type: "notice",
        sessionId: "chat-1",
        kind: "retry_fallback_applied",
        at: "2026-01-02T03:04:05Z",
        payload: { from: "zai/glm", to: "moonshot/kimi", chainKey: "main", reason: "rate_limited" },
      }),
    ).toEqual({
      type: "notice",
      sessionId: "chat-1",
      kind: "retry_fallback_applied",
      at: Date.parse("2026-01-02T03:04:05Z"),
      payload: { from: "zai/glm", to: "moonshot/kimi", chainKey: "main", reason: "rate_limited" },
    });
  });

  it("parses a notice whose payload is absent", () => {
    expect(parseChatServerFrame({ type: "notice", sessionId: "chat-1", kind: "auto_retry_start", at: "2026-01-02T03:04:05Z" })).toEqual({
      type: "notice",
      sessionId: "chat-1",
      kind: "auto_retry_start",
      at: Date.parse("2026-01-02T03:04:05Z"),
    });
  });

  it("sanitizes the payload instead of forwarding raw JSON", () => {
    const frame = parseChatServerFrame({
      type: "notice",
      sessionId: "chat-1",
      kind: "extension_notify",
      at: "2026-01-02T03:04:05Z",
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

  it("parses the server at stamp and notice id", () => {
    const frame = parseChatServerFrame({
      type: "notice",
      sessionId: "chat-1",
      kind: "auto_retry_start",
      at: "2026-01-02T03:04:05.123456789Z",
      nid: "session-a:1",
    });
    expect(frame?.type === "notice" && frame.at).toBe(Date.parse("2026-01-02T03:04:05.123456789Z"));
    expect(frame?.type === "notice" && frame.nid).toBe("session-a:1");
    const seconds = parseChatServerFrame({ type: "notice", sessionId: "chat-1", kind: "k", at: "2026-01-02T03:04:05Z" });
    expect(seconds?.type === "notice" && seconds.at).toBe(Date.parse("2026-01-02T03:04:05Z"));
  });

  it("passes through an absent or schema-invalid at stamp without rewriting input", () => {
    expect(parseChatServerFrame({ type: "notice", sessionId: "chat-1", kind: "k" })).toEqual({
      type: "notice", sessionId: "chat-1", kind: "k",
    });
    for (const at of ["garbage", "", 5, null, {}, "2026-02-29T03:04:05Z", "2026-01-02 03:04:05Z"]) {
      expect(parseChatServerFrame({ type: "notice", sessionId: "chat-1", kind: "k", at })).toEqual({
        type: "notice", sessionId: "chat-1", kind: "k",
      });
    }
  });
});
