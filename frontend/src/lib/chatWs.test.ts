import { describe, expect, it } from "vitest";
import { parseChatServerFrame } from "./chatWs";

describe("parseChatServerFrame", () => {
  it("parses chat.name with origin present, absent, and missing name", () => {
    expect(
      parseChatServerFrame({
        type: "chat.name",
        sessionId: "c1",
        name: "Weekly recap",
        origin: "provider",
      }),
    ).toEqual({
      type: "chat.name",
      sessionId: "c1",
      name: "Weekly recap",
      origin: "provider",
    });
    expect(parseChatServerFrame({ type: "chat.name", sessionId: "c1", name: "Weekly recap" })).toBeNull();
    expect(parseChatServerFrame({ type: "chat.name", sessionId: "c1" })).toBeNull();
  });

  it("accepts well-formed session-scoped frames", () => {
    expect(
      parseChatServerFrame({ type: "ready", sessionId: "c1", piSessionId: null, resumed: false }),
    ).toMatchObject({ type: "ready", sessionId: "c1" });
    expect(
      parseChatServerFrame({
        type: "messageDelta",
        sessionId: "c1",
        delta: { kind: "text_delta", delta: "hi" },
      }),
    ).toMatchObject({ type: "messageDelta" });
    expect(
      parseChatServerFrame({ type: "run.done", sessionId: "c1", reason: "stop" }),
    ).toMatchObject({ type: "run.done", reason: "stop" });
  });

  it("accepts ack and error without a sessionId but requires their discriminator fields", () => {
    expect(parseChatServerFrame({ type: "ack", command: "set_model", requestId: "r1" })).toMatchObject({
      type: "ack",
      command: "set_model",
    });
    expect(parseChatServerFrame({ type: "error", message: "boom" })).toMatchObject({ type: "error" });
    expect(parseChatServerFrame({ type: "ack", requestId: "r1" })).toBeNull();
    expect(parseChatServerFrame({ type: "error", code: "x" })).toBeNull();
  });

  it("accepts a correlated control.result and rejects a malformed one", () => {
    expect(
      parseChatServerFrame({ type: "control.result", sessionId: "c1", command: "set_model", requestId: "r1", success: true }),
    ).toMatchObject({ type: "control.result", success: true });
    expect(
      parseChatServerFrame({ type: "control.result", sessionId: "c1", command: "set_model" }),
    ).toBeNull();
    expect(
      parseChatServerFrame({ type: "control.result", sessionId: "c1", command: "set_model", success: "yes" }),
    ).toBeNull();
  });

  it("rejects unknown types, non-objects, and missing session scope", () => {
    expect(parseChatServerFrame(null)).toBeNull();
    expect(parseChatServerFrame("message")).toBeNull();
    expect(parseChatServerFrame([])).toBeNull();
    expect(parseChatServerFrame({ type: "totally.unknown", sessionId: "c1" })).toBeNull();
    expect(parseChatServerFrame({ type: "messageDelta", delta: { kind: "text_delta" } })).toBeNull();
  });

  it("parses subscribed activity snapshots and remap identity", () => {
    expect(parseChatServerFrame({
      type: "sessions.activity",
      sessionId: "attached-chat",
      durableSessionId: "child-1",
      replacesSessionId: "child-1",
      snapshots: [{ name: "omo.task.updated", data: { tasks: [] }, oversized: false }],
      taskDigest: { tasks: [{ task_id: "t1", status: "running" }], truncated: false },
      overflow: true,
    })).toEqual({
      type: "sessions.activity",
      sessionId: "attached-chat",
      durableSessionId: "child-1",
      replacesSessionId: "child-1",
      snapshots: [{ name: "omo.task.updated", data: { tasks: [] }, oversized: false }],
      taskDigest: { tasks: [{ task_id: "t1", status: "running" }], truncated: false },
      overflow: true,
    });
    expect(parseChatServerFrame({
      type: "sessions.activity",
      sessionId: "child-1",
      durableSessionId: "child-1",
      snapshots: [{ name: "omo.other", oversized: false }],
      overflow: false,
    })).toBeNull();
  });

  it("accepts a well-formed run.started and rejects it without a session scope", () => {
    expect(parseChatServerFrame({ type: "run.started", sessionId: "c1" })).toEqual({
      type: "run.started",
      sessionId: "c1",
    });
    expect(parseChatServerFrame({ type: "run.started" })).toBeNull();
  });

  it("rejects frames missing the fields the UI dereferences", () => {
    expect(parseChatServerFrame({ type: "message", sessionId: "c1" })).toBeNull();
    expect(parseChatServerFrame({ type: "tool", sessionId: "c1", toolCallId: "t", toolName: "bash", phase: "explode" })).toBeNull();
    expect(parseChatServerFrame({ type: "state", sessionId: "c1", isStreaming: "yes", isCompacting: false })).toBeNull();
    expect(parseChatServerFrame({ type: "approval", sessionId: "c1", id: "a1" })).toBeNull();
    expect(parseChatServerFrame({ type: "commands", sessionId: "c1", commands: "nope" })).toBeNull();
  });

  it("accepts compaction.started and compaction.done with validated fields", () => {
    expect(parseChatServerFrame({ type: "compaction.started", sessionId: "c1" })).toEqual({
      type: "compaction.started",
      sessionId: "c1",
    });
    // Session-scoped like every other live frame.
    expect(parseChatServerFrame({ type: "compaction.started" })).toBeNull();
    expect(parseChatServerFrame({ type: "compaction.done", sessionId: "c1" })).toEqual({
      type: "compaction.done",
      sessionId: "c1",
    });
    expect(
      parseChatServerFrame({ type: "compaction.done", sessionId: "c1", error: "Nothing to compact" }),
    ).toEqual({ type: "compaction.done", sessionId: "c1", error: "Nothing to compact" });
    expect(parseChatServerFrame({ type: "compaction.done" })).toBeNull();
    expect(parseChatServerFrame({ type: "compaction.done", sessionId: "c1", error: 5 })).toBeNull();
  });
});
