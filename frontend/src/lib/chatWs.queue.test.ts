import { describe, expect, it } from "vitest";
import { parseChatServerFrame, queueClearFrame, queueMoveFrame, queueRemoveFrame } from "./chatWs";
import type { ChatServerFrame } from "./chatWs";

const validQueue = {
  type: "queue",
  sessionId: "sess-1",
  revision: 3,
  items: [
    { id: "q-1", text: "follow up after this run", hasImage: false, createdAt: 1788448206000, requestId: "req-send-1" },
    { id: "q-2", text: "and then this", hasImage: true, createdAt: 1788448207000 },
  ],
  engine: {
    pendingMessageCount: 1,
    ordered: [{ text: "engine follow-up", mode: "followUp" }, { text: "engine steer", mode: "steer" }],
  },
};

function asQueue(frame: ChatServerFrame | null): Extract<ChatServerFrame, { readonly type: "queue" }> | null {
  return frame !== null && frame.type === "queue" ? frame : null;
}

describe("queue server frame parse boundary", () => {
  it("rebuilds the queue snapshot field-by-field, preserving the optional requestId", () => {
    expect(asQueue(parseChatServerFrame(validQueue))).toEqual(validQueue);
  });

  it("accepts an empty snapshot (the engine reports nothing)", () => {
    expect(asQueue(parseChatServerFrame({
      type: "queue",
      sessionId: "sess-1",
      revision: 0,
      items: [],
      engine: { pendingMessageCount: 0, ordered: [] },
    }))).toEqual({
      type: "queue",
      sessionId: "sess-1",
      revision: 0,
      items: [],
      engine: { pendingMessageCount: 0, ordered: [] },
    });
  });

  it("rejects malformed queue frames the UI cannot render", () => {
    const missingSession = { ...validQueue };
    delete (missingSession as { sessionId?: unknown }).sessionId;
    expect(parseChatServerFrame(missingSession)).toBeNull();
    expect(parseChatServerFrame({ ...validQueue, revision: "3" })).toBeNull();
    expect(parseChatServerFrame({ ...validQueue, items: "nope" })).toBeNull();
    expect(parseChatServerFrame({ ...validQueue, items: [{ id: "q-1", text: "x", hasImage: "yes", createdAt: 1 }] })).toBeNull();
    // createdAt is required on every item.
    expect(parseChatServerFrame({ ...validQueue, items: [{ id: "q-1", text: "x", hasImage: true }] })).toBeNull();
    expect(parseChatServerFrame({ ...validQueue, items: [{ id: 5, text: "x", hasImage: true, createdAt: 1 }] })).toBeNull();
    // engine is required as a whole snapshot.
    expect(parseChatServerFrame({ ...validQueue, engine: { pendingMessageCount: 1 } })).toBeNull();
    expect(parseChatServerFrame({ ...validQueue, engine: null })).toBeNull();
    expect(parseChatServerFrame({ ...validQueue, engine: { pendingMessageCount: 1, ordered: [{ text: "x", mode: "jump" }] } })).toBeNull();
    expect(parseChatServerFrame({ ...validQueue, engine: { pendingMessageCount: true, ordered: [] } })).toBeNull();
  });
});

describe("queue client frame builders", () => {
  it("builds the three queue commands with the exact wire shapes", () => {
    expect(queueRemoveFrame("sess-1", "q-1")).toEqual({
      type: "chat.queue.remove",
      sessionId: "sess-1",
      itemId: "q-1",
    });
    expect(queueMoveFrame("sess-1", "q-2", 0)).toEqual({
      type: "chat.queue.move",
      sessionId: "sess-1",
      itemId: "q-2",
      toIndex: 0,
    });
    expect(queueClearFrame("sess-1", "all")).toEqual({
      type: "chat.queue.clear",
      sessionId: "sess-1",
      scope: "all",
    });
  });

  it("builds every clear scope the contract names", () => {
    expect(queueClearFrame("sess-1", "webchat").scope).toBe("webchat");
    expect(queueClearFrame("sess-1", "engine").scope).toBe("engine");
    expect(queueClearFrame("sess-1", "all").scope).toBe("all");
  });
});
