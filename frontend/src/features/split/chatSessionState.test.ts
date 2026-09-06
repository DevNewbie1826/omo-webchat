import { describe, expect, it } from "vitest";
import type { UiMessage } from "./chatEntries";
import { messageText } from "./chatEntries";
import { queuedSendFrame, nextToolEntry, reconcileHistory } from "./chatSessionState";
import { ChatSendStore } from "./chatSendState";
import { materializeFinalTools } from "./chatFinalTools";
import type { ToolEntry } from "./chatSessionTypes";

function userMessage(text: string): UiMessage {
  return { role: "user", blocks: [{ kind: "text", text }] };
}
const staleHistory = [
  { type: "message", message: { role: "user", content: "hello", timestamp: 1 } },
  { type: "message", message: { role: "assistant", content: "old reply", timestamp: 2 } },
];

describe("queuedSendFrame", () => {
  it("preserves an attached image in the server-owned prompt queue", () => {
    expect(queuedSendFrame({ text: "look here", image: { name: "context.png", mimeType: "image/png", data: "YWJj" } }, "request-1", "chat-1")).toEqual({
      type: "chat.send", sessionId: "chat-1", requestId: "request-1",
      run: { kind: "prompt", message: "look here", images: [{ mimeType: "image/png", data: "YWJj" }] },
    });
  });
});

describe("canonical history is independent of send outcomes", () => {
  const setup = () => {
    const store = new ChatSendStore();
    store.register("request", "prompt", { text: "hello", image: null }, 1);
    return store;
  };
  it("does not complete an unechoed active request from stale initial history", () => {
    const store = setup();
    const result = reconcileHistory({ entries: staleHistory, current: [], preserveCurrent: false });
    expect(result.messages.map(messageText)).toEqual(["hello", "old reply"]);
    expect(store.get("request")?.phase).toBe("sending");
  });
  it("does not complete an echoed active request from history", () => {
    const store = setup();
    const result = reconcileHistory({ entries: staleHistory, current: [userMessage("hello")], preserveCurrent: false });
    expect(result.messages.map(messageText)).toEqual(["hello", "old reply"]);
    expect(store.get("request")?.hold).toBe(true);
  });
  it("requires the request outcome even when reconnect history contains a reply", () => {
    const store = setup();
    store.disconnect(1);
    reconcileHistory({ entries: staleHistory, current: [], preserveCurrent: false });
    expect(store.get("request")?.phase).toBe("unknown");
    store.complete("request");
    expect(store.getSnapshot()).toEqual([]);
  });
  it("does not declare a user-only history record to be a stalled failed request", () => {
    const store = setup();
    store.disconnect(1);
    const result = reconcileHistory({ entries: staleHistory.slice(0, 1), current: [], preserveCurrent: false });
    expect(result.messages.map(messageText)).toEqual(["hello"]);
    expect(store.get("request")?.phase).toBe("unknown");
  });
  it("never completes or drops an echo-less uncertain request on an unknown baseline", () => {
    const store = setup();
    store.disconnect(1);
    reconcileHistory({ entries: staleHistory, current: [], preserveCurrent: false });
    expect(store.getSnapshot()).toMatchObject([{ requestId: "request", phase: "unknown" }]);
  });
  it("settles an echoed uncertain request by completed ACK rather than history", () => {
    const store = setup();
    store.disconnect(1);
    const result = reconcileHistory({ entries: staleHistory, current: [userMessage("hello")], preserveCurrent: false });
    store.complete("request");
    expect(store.getSnapshot()).toEqual([]);
    expect(result.messages.map(messageText)).toEqual(["hello", "old reply"]);
  });
  it("does not let missing history mutate an unresolved request", () => {
    const store = setup();
    reconcileHistory({ entries: [], current: [], preserveCurrent: false });
    expect(store.get("request")?.hold).toBe(true);
  });
  it("marks an admitted active request unknown on disconnect", () => {
    const store = setup(); store.admit("request"); store.disconnect(1);
    expect(store.get("request")?.phase).toBe("unknown");
  });
  it("keeps an echoed request original across disconnect", () => {
    const store = setup();
    reconcileHistory({ entries: staleHistory, current: [userMessage("hello")], preserveCurrent: true });
    store.disconnect(1);
    expect(store.get("request")?.draft.text).toBe("hello");
  });
  it("does not resurrect a completed request on disconnect", () => {
    const store = setup(); store.complete("request"); store.disconnect(1);
    expect(store.getSnapshot()).toEqual([]);
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
