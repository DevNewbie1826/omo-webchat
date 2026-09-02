import { describe, expect, it } from "vitest";
import { parseChatServerFrame } from "./chatWs";

describe("parseChatServerFrame", () => {
  it("parses stats contextUsage and accepts a cost-less stats frame", () => {
    expect(
      parseChatServerFrame({
        type: "stats",
        sessionId: "c1",
        cost: 0.001,
        contextUsage: { tokens: 16161, contextWindow: 1000000, percent: 1.616 },
      }),
    ).toMatchObject({ type: "stats", contextUsage: { tokens: 16161, percent: 1.616 } });
    expect(parseChatServerFrame({
      type: "stats",
      sessionId: "c1",
      tokens: { input: 100, output: 50, cacheRead: 7, cacheWrite: 3, total: 160 },
      contextUsage: { used: 150, total: 200000, percent: 0.075 },
    })).toMatchObject({ tokens: { input: 100, cacheRead: 7 }, contextUsage: { used: 150, total: 200000, percent: 0.075 } });
    // contextUsage only, no cost — must still be accepted
    expect(
      parseChatServerFrame({ type: "stats", sessionId: "c1", contextUsage: { tokens: 1, contextWindow: 10, percent: 10 } }),
    ).toMatchObject({ type: "stats", contextUsage: { percent: 10 } });
    // neither cost nor contextUsage — rejected
    expect(parseChatServerFrame({ type: "stats", sessionId: "c1" })).toBeNull();
    // malformed contextUsage — rejected even with cost
    expect(
      parseChatServerFrame({ type: "stats", sessionId: "c1", cost: 1, contextUsage: { tokens: 1 } }),
    ).toBeNull();
  });

  it("preserves tool args and partial/result details", () => {
    const frame = parseChatServerFrame({
      type: "tool",
      sessionId: "c1",
      toolCallId: "call_1",
      toolName: "task",
      phase: "update",
      args: { tasks: [{ name: "Greeter" }] },
      partial: { content: [{ type: "text", text: "Running…" }], details: { task_id: "st_1", status: "running" } },
    });
    expect(frame).toMatchObject({
      type: "tool",
      toolName: "task",
      args: { tasks: [{ name: "Greeter" }] },
      partial: { details: { task_id: "st_1", status: "running" } },
    });
  });

  it("preserves the custom type on a live hook message", () => {
    expect(
      parseChatServerFrame({
        type: "message",
        sessionId: "c1",
        message: {
          role: "custom",
          customType: "senpi-task.usage",
          blocks: [{ kind: "text", text: "<omo-senpi-task>hook</omo-senpi-task>" }],
          ts: 42,
        },
      }),
    ).toMatchObject({
      type: "message",
      message: {
        role: "custom",
        customType: "senpi-task.usage",
        blocks: [{ kind: "text", text: "<omo-senpi-task>hook</omo-senpi-task>" }],
      },
    });
  });

  it("preserves canonical string custom-message content and timestamp", () => {
    expect(parseChatServerFrame({
      type: "message",
      sessionId: "c1",
      message: { role: "custom", customType: "hook", content: "canonical hook output", timestamp: 1735689600.25 },
    })).toEqual({
      type: "message",
      sessionId: "c1",
      message: { role: "custom", customType: "hook", blocks: [{ kind: "text", text: "canonical hook output" }], ts: 1735689600.25 },
    });
  });

  it("deeply validates message blocks and rejects a malformed block", () => {
    const valid = parseChatServerFrame({
      type: "message",
      sessionId: "c1",
      message: {
        role: "assistant",
        blocks: [
          { kind: "text", text: "hi" },
          { kind: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" }, isError: false },
        ],
      },
    });
    expect(valid).toMatchObject({ type: "message" });
    // A block without a string kind, or with a wrong-typed field, is rejected.
    expect(
      parseChatServerFrame({ type: "message", sessionId: "c1", message: { role: "assistant", blocks: [{ text: "no kind" }] } }),
    ).toBeNull();
    expect(
      parseChatServerFrame({ type: "message", sessionId: "c1", message: { role: "assistant", blocks: [{ kind: "text", text: 5 }] } }),
    ).toBeNull();
    expect(
      parseChatServerFrame({ type: "message", sessionId: "c1", message: { role: "assistant", blocks: "nope" } }),
    ).toBeNull();
    expect(parseChatServerFrame({ type: "message", sessionId: "c1", message: { blocks: [] } })).toBeNull();
  });

  it("sanitizes provider JSON in block arguments without prototype pollution", () => {
    const frame = parseChatServerFrame({
      type: "message",
      sessionId: "c1",
      message: {
        role: "assistant",
        blocks: [{ kind: "toolCall", id: "t1", name: "bash", arguments: JSON.parse('{"command":"ls","__proto__":{"polluted":true},"constructor":{"x":1}}') }],
      },
    });
    const block = frame?.type === "message" ? frame.message.blocks?.[0] : undefined;
    expect(block?.arguments).toEqual({ command: "ls" });
    expect(Object.keys(block?.arguments as Record<string, unknown>)).toEqual(["command"]);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("deeply validates tool partial/result payloads that extractToolText dereferences", () => {
    const valid = parseChatServerFrame({
      type: "tool",
      sessionId: "c1",
      toolCallId: "t1",
      toolName: "bash",
      phase: "end",
      partial: { content: [{ text: "out" }] },
      result: { content: [{ text: "final" }] },
      isError: true,
    });
    expect(valid).toMatchObject({ type: "tool", isError: true });
    // A non-array content (or non-object item, or wrong-typed text) is rejected
    // instead of throwing later in extractToolText.
    expect(
      parseChatServerFrame({ type: "tool", sessionId: "c1", toolCallId: "t1", toolName: "bash", phase: "end", partial: { content: {} } }),
    ).toBeNull();
    expect(
      parseChatServerFrame({ type: "tool", sessionId: "c1", toolCallId: "t1", toolName: "bash", phase: "end", result: { content: ["raw"] } }),
    ).toBeNull();
    expect(
      parseChatServerFrame({ type: "tool", sessionId: "c1", toolCallId: "t1", toolName: "bash", phase: "end", isError: "yes" }),
    ).toBeNull();
  });

  it("validates delta fields the stream reducer dereferences", () => {
    expect(
      parseChatServerFrame({ type: "messageDelta", sessionId: "c1", delta: { kind: "text_delta", delta: "x", contentIndex: 0 } }),
    ).toMatchObject({ type: "messageDelta" });
    expect(parseChatServerFrame({ type: "messageDelta", sessionId: "c1", delta: {} })).toBeNull();
    expect(
      parseChatServerFrame({ type: "messageDelta", sessionId: "c1", delta: { kind: "text_delta", delta: 5 } }),
    ).toBeNull();
    expect(
      parseChatServerFrame({ type: "messageDelta", sessionId: "c1", delta: { kind: "text_delta", contentIndex: "0" } }),
    ).toBeNull();
  });

  it("validates state model shape and optional scalars", () => {
    expect(
      parseChatServerFrame({
        type: "state",
        sessionId: "c1",
        isStreaming: false,
        isCompacting: false,
        thinkingLevel: "high",
        model: { provider: "omo", modelId: "m1" },
      }),
    ).toMatchObject({ type: "state", model: { provider: "omo", modelId: "m1" } });
    expect(
      parseChatServerFrame({ type: "state", sessionId: "c1", isStreaming: false, isCompacting: false, model: null }),
    ).toMatchObject({ type: "state", model: null });
    expect(
      parseChatServerFrame({ type: "state", sessionId: "c1", isStreaming: false, isCompacting: false, model: { provider: "omo" } }),
    ).toBeNull();
    expect(
      parseChatServerFrame({ type: "state", sessionId: "c1", isStreaming: false, isCompacting: false, thinkingLevel: 3 }),
    ).toBeNull();
  });

  it("enforces the approval method enum and string options", () => {
    expect(
      parseChatServerFrame({ type: "approval", sessionId: "c1", id: "a1", method: "select", options: ["yes", "no"] }),
    ).toMatchObject({ type: "approval", method: "select" });
    expect(parseChatServerFrame({ type: "approval", sessionId: "c1", id: "a1", method: "explode" })).toBeNull();
    expect(
      parseChatServerFrame({ type: "approval", sessionId: "c1", id: "a1", method: "select", options: ["yes", 1] }),
    ).toBeNull();
  });
});
