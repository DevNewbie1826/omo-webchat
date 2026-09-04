import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatClientFrame, ChatConnector, ChatHandlers, ChatServerFrame } from "../../lib/chatWs";
import { useChatSession } from "./useChatSession";

const session = {
  id: "chat-1",
  name: "Chat",
  wsId: "workspace-1",
  cwd: "/work",
  provider: "omo",
} as const;

describe("useChatSession server-owned send queue", () => {
  let root: Root;
  let container: HTMLDivElement;
  let handlers: ChatHandlers;
  let current: ReturnType<typeof useChatSession> | undefined;
  let sent: ChatClientFrame[];
  let acceptSends: boolean;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    sent = [];
    acceptSends = true;
    const connect: ChatConnector = (nextHandlers) => {
      handlers = nextHandlers;
      handlers.onOpen?.();
      return {
        send: (frame) => {
          sent.push(frame);
          return acceptSends;
        },
        close: () => undefined,
      };
    };
    function Probe() {
      current = useChatSession(session, connect);
      return null;
    }
    act(() => root.render(<Probe />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const deliver = (frame: ChatServerFrame): void => handlers.onFrame(frame);
  const beginRun = (): void => {
    act(() => deliver({ type: "run.started", sessionId: session.id }));
  };
  const lastSend = (): Extract<ChatClientFrame, { readonly type: "chat.send" }> => {
    const frame = sent.at(-1);
    if (frame?.type !== "chat.send") throw new Error("last frame was not a chat.send");
    return frame;
  };

  it("queues a submission made while running as a plain prompt with no transcript row", () => {
    beginRun();
    act(() => current?.submit({ text: "queued work", image: null }));

    expect(lastSend()).toEqual({
      type: "chat.send",
      sessionId: session.id,
      requestId: expect.any(String),
      run: { kind: "prompt", message: "queued work" },
    });
    // No optimistic row: the queue owns the pending feedback now.
    expect(current?.messages).toEqual([]);
    expect(current?.queuePlaceholders).toHaveLength(1);
    expect(current?.queuePlaceholders[0]).toMatchObject({ text: "queued work" });
  });

  it("carries the image payload on a queued submission", () => {
    beginRun();
    const image = { name: "context.png", mimeType: "image/png", data: "YWJj" };
    act(() => current?.submit({ text: "queued work", image }));

    expect(lastSend().run).toEqual({
      kind: "prompt",
      message: "queued work",
      images: [{ mimeType: "image/png", data: "YWJj" }],
    });
  });

  it("keeps the submission local when the socket refuses it", () => {
    beginRun();
    acceptSends = false;
    let accepted = false;
    act(() => {
      accepted = current?.submit({ text: "queued work", image: null }) ?? false;
    });
    expect(accepted).toBe(false);
    expect(current?.queuePlaceholders).toEqual([]);
  });

  it("confirms the placeholder from the queue frame and mirrors the engine snapshot", () => {
    beginRun();
    act(() => current?.submit({ text: "queued work", image: null }));
    const requestId = lastSend().requestId;
    if (!requestId) throw new Error("missing requestId");

    act(() => deliver({
      type: "queue",
      sessionId: session.id,
      revision: 1,
      items: [{ id: "q-1", text: "queued work", hasImage: false, createdAt: 1000, requestId }],
      engine: { pendingMessageCount: 2, ordered: [{ text: "engine item", mode: "followUp" }] },
    }));

    expect(current?.queueItems).toEqual([
      { id: "q-1", text: "queued work", hasImage: false, createdAt: 1000, requestId },
    ]);
    expect(current?.queueEngine).toEqual({
      pendingMessageCount: 2,
      ordered: [{ text: "engine item", mode: "followUp" }],
    });
    expect(current?.queuePlaceholders).toEqual([]);
  });

  it("restores the queue list after a page reload from the attach queue frame", () => {
    // No local submission in this connection: a bare attach replay populates the panel.
    act(() => deliver({
      type: "queue",
      sessionId: session.id,
      revision: 7,
      items: [
        { id: "q-1", text: "survived restart", hasImage: false, createdAt: 10 },
        { id: "q-2", text: "second", hasImage: false, createdAt: 20 },
      ],
      engine: { pendingMessageCount: 0, ordered: [] },
    }));
    expect(current?.queueItems.map((item) => item.text)).toEqual(["survived restart", "second"]);
  });

  it("sends the queue commands verbatim", () => {
    act(() => {
      current?.queueRemove("q-1");
      current?.queueMove("q-1", 0);
      current?.queueClear("all");
    });
    expect(sent).toContainEqual({ type: "chat.queue.remove", sessionId: session.id, itemId: "q-1" });
    expect(sent).toContainEqual({ type: "chat.queue.move", sessionId: session.id, itemId: "q-1", toIndex: 0 });
    expect(sent).toContainEqual({ type: "chat.queue.clear", sessionId: session.id, scope: "all" });
  });

  it("steers without a transcript row and keeps a pending summary until the echo tags it", () => {
    beginRun();
    act(() => current?.steer("redirect now"));

    expect(lastSend()).toEqual({
      type: "chat.send",
      sessionId: session.id,
      requestId: expect.any(String),
      run: { kind: "steer", message: "redirect now" },
    });
    expect(current?.messages).toEqual([]);
    expect(current?.steerPending.map((item) => item.text)).toEqual(["redirect now"]);

    act(() => deliver({
      type: "message",
      sessionId: session.id,
      message: { role: "user", blocks: [{ kind: "text", text: "redirect now" }], ts: 10 },
    }));
    expect(current?.messages).toEqual([
      { role: "user", customType: "steer", blocks: [{ kind: "text", text: "redirect now" }], ts: 10 },
    ]);
    expect(current?.steerPending).toEqual([]);
  });

  it("clears the steer summary on run.done even when the echo never arrived", () => {
    beginRun();
    act(() => current?.steer("redirect now"));
    expect(current?.steerPending).toHaveLength(1);

    act(() => deliver({ type: "run.done", sessionId: session.id, reason: "stop" }));
    expect(current?.steerPending).toEqual([]);
  });

  it("drops the steer summary when the steer is rejected", () => {
    beginRun();
    act(() => current?.steer("rejected redirect"));
    const requestId = lastSend().requestId;
    if (!requestId) throw new Error("missing requestId");

    act(() => deliver({
      type: "error",
      sessionId: session.id,
      code: "send_failed",
      command: "chat.send",
      requestId,
      message: "steer rejected",
    }));
    expect(current?.steerPending).toEqual([]);
  });
});
