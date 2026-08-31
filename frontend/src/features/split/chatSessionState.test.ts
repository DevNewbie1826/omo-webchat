import { describe, expect, it } from "vitest";
import type { UiMessage } from "./chatEntries";
import { messageText } from "./chatEntries";
import { type PendingOptimistic, nextToolEntry, reconcileHistory, reconcileOutcome, uncertainRun } from "./chatSessionState";
import { materializeFinalTools } from "./chatFinalTools";
import type { ToolEntry } from "./chatSessionTypes";

function pending(text: string, overrides: Partial<PendingOptimistic> = {}): PendingOptimistic {
  return { text, image: null, id: 1, priorMatchingCount: 0, accepted: true, baselineKnown: true, ...overrides };
}

function userMessage(text: string, optimisticId?: number): UiMessage {
  return { role: "user", blocks: [{ kind: "text", text }], ...(optimisticId !== undefined ? { optimisticId } : {}) };
}

// Delayed initial history that already contains an OLD turn identical to the
// active prompt, followed by an assistant reply.
const staleHistory = [
  { type: "message", message: { role: "user", content: "hello", timestamp: 1 } },
  { type: "message", message: { role: "assistant", content: "old reply", timestamp: 2 } },
];

describe("reconcileHistory active matching", () => {
  it("does not complete an un-echoed active run from stale initial history", () => {
    const active = pending("hello");
    const result = reconcileHistory({
      entries: staleHistory,
      current: [userMessage("hello", 1)],
      pending: [active],
      active,
      uncertain: null,
      preserveCurrent: false,
    });

    expect(result.activeCompleted).toBe(false);
    expect(result.pending.map((item) => item.id)).toEqual([1]);
  });

  it("completes an active run that has an actual server echo", () => {
    const active = pending("hello", { echo: userMessage("hello") });
    const result = reconcileHistory({
      entries: staleHistory,
      current: [userMessage("hello", 1)],
      pending: [active],
      active,
      uncertain: null,
      preserveCurrent: false,
    });

    expect(result.activeCompleted).toBe(true);
  });

  it("completes an uncertain run across reconnect from authoritative history", () => {
    const active = pending("hello");
    const result = reconcileHistory({
      entries: staleHistory,
      current: [],
      pending: [active],
      active,
      uncertain: active,
      preserveCurrent: false,
    });

    expect(result.activeCompleted).toBe(true);
  });

  it("flags a known-baseline uncertain run whose user entry has no assistant reply", () => {
    const active = pending("work");
    const result = reconcileHistory({
      entries: [{ type: "message", message: { role: "user", content: "work", timestamp: 1 } }],
      current: [userMessage("work", 1)],
      pending: [active],
      active,
      uncertain: active,
      preserveCurrent: false,
    });

    expect(result.uncertainMissing).toBe(false);
    expect(result.activeCompleted).toBe(false);
    expect(result.uncertainStalled).toBe(true);
    // The user entry exists in authoritative history; the optimistic duplicate drops.
    expect(result.pending).toEqual([]);
    expect(result.messages.map(messageText)).toEqual(["work"]);
  });

  it("never completes or drops an echo-less uncertain run on an unknown baseline", () => {
    const active = pending("hello", { baselineKnown: false });
    const result = reconcileHistory({
      entries: staleHistory,
      current: [],
      pending: [active],
      active,
      uncertain: active,
      preserveCurrent: false,
    });

    // The stale identical turn must not pose as the unsent run's completion.
    expect(result.activeCompleted).toBe(false);
    expect(result.uncertainMissing).toBe(false);
    expect(result.uncertainStalled).toBe(true);
    expect(result.pending.map((item) => item.id)).toEqual([1]);
  });

  it("still completes an echoed uncertain run even on an unknown baseline", () => {
    const active = pending("hello", { baselineKnown: false, echo: userMessage("hello") });
    const result = reconcileHistory({
      entries: staleHistory,
      current: [],
      pending: [active],
      active,
      uncertain: active,
      preserveCurrent: false,
    });

    expect(result.activeCompleted).toBe(true);
  });
});

describe("reconcileOutcome", () => {
  it("keeps an uncertain run active while authoritative state is streaming", () => {
    const active = pending("work");
    expect(reconcileOutcome({ messages: [], pending: [], uncertainMissing: true, uncertainStalled: true, activeCompleted: true }, active, true)).toBe("active");
  });
});

describe("uncertainRun", () => {
  it("marks an active run uncertain while it is still display-pending", () => {
    const active = pending("work");
    expect(uncertainRun(active, [active])?.id).toBe(1);
  });

  it("keeps an echoed active run uncertain after its display-pending state is removed", () => {
    // The server user echo splices the run out of the pending display list, but
    // the run is still in flight (no assistant reply), so it stays uncertain.
    const active = pending("work", { echo: userMessage("work") });
    expect(uncertainRun(active, [])?.id).toBe(1);
  });

  it("returns null when no run is active", () => {
    expect(uncertainRun(null, [pending("work")])).toBeNull();
  });
});

describe("nextToolEntry", () => {
  it("retains arguments when later frames omit them", () => {
    const started = nextToolEntry({}, {
      type: "tool",
      sessionId: "chat-1",
      toolCallId: "t1",
      toolName: "bash",
      phase: "start",
      args: { command: "pwd" },
    });
    const ended = nextToolEntry(started, {
      type: "tool",
      sessionId: "chat-1",
      toolCallId: "t1",
      toolName: "bash",
      phase: "end",
      result: { content: [{ text: "/work" }] },
    });

    expect(ended["t1"]?.args).toEqual({ command: "pwd" });
  });

  it("retains details when later frames omit them", () => {
    const updated = nextToolEntry({}, {
      type: "tool",
      sessionId: "chat-1",
      toolCallId: "t1",
      toolName: "bash",
      phase: "update",
      partial: { details: { progress: 1 } },
    });
    const ended = nextToolEntry(updated, {
      type: "tool",
      sessionId: "chat-1",
      toolCallId: "t1",
      toolName: "bash",
      phase: "end",
      result: { content: [{ text: "/work" }] },
    });

    expect(ended["t1"]?.details).toEqual({ progress: 1 });
  });
});

describe("materializeFinalTools", () => {
  const tools: Readonly<Record<string, ToolEntry>> = {
    t1: { toolName: "bash", phase: "end", text: "out", isError: false },
    t2: { toolName: "read", phase: "end", text: "", isError: true },
  };

  it("prepends one compact block per tool to the last assistant message", () => {
    const messages: readonly UiMessage[] = [
      { role: "user", blocks: [{ kind: "text", text: "do work" }] },
      { role: "assistant", blocks: [{ kind: "text", text: "reply" }] },
    ];

    const result = materializeFinalTools(messages, tools);

    expect(result).toHaveLength(2);
    expect(result[1]?.blocks).toEqual([
      { kind: "tool", id: "t1", name: "bash", text: "out", isError: false },
      { kind: "tool", id: "t2", name: "read", text: "", isError: true },
      { kind: "text", text: "reply" },
    ]);
    // The input array is not mutated.
    expect(messages[1]?.blocks).toHaveLength(1);
  });

  it("appends an assistant message when the transcript has none", () => {
    const result = materializeFinalTools([{ role: "user", blocks: [{ kind: "text", text: "x" }] }], tools);

    expect(result).toHaveLength(2);
    expect(result[1]?.role).toBe("assistant");
    expect(result[1]?.blocks).toHaveLength(2);
  });

  it("returns the same array when no tools finalized", () => {
    const messages: readonly UiMessage[] = [{ role: "assistant", blocks: [{ kind: "text", text: "r" }] }];
    expect(materializeFinalTools(messages, {})).toBe(messages);
  });

  it("replaces an existing toolCall block in place so one call renders once", () => {
    const messages: readonly UiMessage[] = [
      { role: "user", blocks: [{ kind: "text", text: "do work" }] },
      {
        role: "assistant",
        blocks: [
          { kind: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
          { kind: "text", text: "reply" },
        ],
      },
    ];

    const result = materializeFinalTools(messages, {
      t1: { toolName: "bash", phase: "end", text: "final out", isError: false },
    });

    expect(result[1]?.blocks).toEqual([
      { kind: "tool", id: "t1", name: "bash", arguments: { command: "ls" }, text: "final out", isError: false },
      { kind: "text", text: "reply" },
    ]);
    // The input message is not mutated.
    expect(messages[1]?.blocks?.[0]?.kind).toBe("toolCall");
  });

  it("merges final error output in place and prepends brand-new calls", () => {
    const messages: readonly UiMessage[] = [
      { role: "assistant", blocks: [{ kind: "toolCall", id: "t1", name: "bash" }] },
    ];

    const result = materializeFinalTools(messages, {
      t1: { toolName: "bash", phase: "end", text: "boom", isError: true },
      t2: { toolName: "read", phase: "end", text: "data", isError: false },
    });

    expect(result[0]?.blocks).toEqual([
      { kind: "tool", id: "t2", name: "read", text: "data", isError: false },
      { kind: "tool", id: "t1", name: "bash", text: "boom", isError: true },
    ]);
  });
});
