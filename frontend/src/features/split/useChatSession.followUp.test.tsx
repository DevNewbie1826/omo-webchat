import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseChatServerFrame, type ChatClientFrame, type ChatConnector, type ChatHandlers, type ChatServerFrame } from "../../lib/chatWs";
import { messageText } from "./chatEntries";
import { useChatSession } from "./useChatSession";

const session = {
  id: "chat-1",
  name: "Chat",
  wsId: "workspace-1",
  cwd: "/work",
  provider: "omo",
} as const;

describe("useChatSession pending follow-ups", () => {
  let root: Root;
  let container: HTMLDivElement;
  let handlers: ChatHandlers;
  let current: ReturnType<typeof useChatSession> | undefined;
  let sent: ChatClientFrame[];

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    sent = [];
    const connect: ChatConnector = (nextHandlers) => {
      handlers = nextHandlers;
      handlers.onOpen?.();
      return {
        send: (frame) => {
          sent.push(frame);
          return true;
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
  const deliverRaw = (raw: string): void => {
    const frame = parseChatServerFrame(JSON.parse(raw));
    if (frame === null) throw new Error("raw server frame did not parse");
    deliver(frame);
  };
  const beginRun = (): void => {
    act(() => deliver({ type: "run.started", sessionId: session.id }));
  };

  it("settles only the rejected follow-up and restores its text and image", () => {
    beginRun();
    const image = { name: "context.png", mimeType: "image/png", data: "YWJj" };
    act(() => {
      current?.submit({ text: "queued work", image });
    });

    expect(sent.at(-1)).toEqual({
      type: "chat.send",
      sessionId: session.id,
      requestId: expect.any(String),
      run: {
        kind: "follow_up",
        message: "queued work",
        images: [{ mimeType: "image/png", data: "YWJj" }],
      },
    });
    expect(current?.hasPendingFollowUp).toBe(true);
    const frame = sent.at(-1);
    if (frame?.type !== "chat.send" || !frame.requestId) throw new Error("missing chat.send request id");
    const requestId = frame.requestId;

    act(() => deliver({
      type: "error",
      sessionId: session.id,
      code: "provider_error",
      command: "chat.send",
      requestId,
      message: "queue rejected",
    }));

    expect(current?.running).toBe(true);
    expect(current?.messages).toEqual([]);
    expect(current?.retryDraft).toMatchObject({ text: "queued work", image });
    expect(current?.hasPendingFollowUp).toBe(false);
  });

  it("replaces a pending marker with its canonical live echo", () => {
    beginRun();
    act(() => current?.submit({ text: "queued work", image: null }));
    expect(current?.messages[0]).toMatchObject({ customType: "followUp", optimisticId: 1 });

    act(() => deliver({
      type: "message",
      sessionId: session.id,
      message: { role: "user", blocks: [{ kind: "text", text: "queued work" }], ts: 10 },
    }));

    expect(current?.messages).toHaveLength(1);
    expect(current?.messages[0]?.customType).toBeUndefined();
    expect(current?.messages[0]?.ts).toBe(10);
    expect(current?.hasPendingFollowUp).toBe(false);
  });

  it("reconciles one user message when completion arrives before the follow-up echo", () => {
    beginRun();
    act(() => current?.submit({ text: "queued work", image: null }));
    const sentFrame = sent.at(-1);
    if (sentFrame?.type !== "chat.send" || !sentFrame.requestId) throw new Error("missing follow-up request identity");

    act(() => deliverRaw(JSON.stringify({
      type: "ack",
      sessionId: session.id,
      command: "chat.send",
      requestId: sentFrame.requestId,
      phase: "completed",
    })));
    expect(current?.hasPendingFollowUp).toBe(true);

    act(() => deliver({
      type: "message",
      sessionId: session.id,
      message: { role: "user", blocks: [{ kind: "text", text: "queued work" }], ts: 10 },
    }));

    expect(current?.messages).toEqual([
      { role: "user", blocks: [{ kind: "text", text: "queued work" }], ts: 10 },
    ]);
    expect(current?.hasPendingFollowUp).toBe(false);
  });

  it("replaces a pending marker during authoritative history reconciliation", () => {
    act(() => deliver({ type: "entries", sessionId: session.id, entries: [] }));
    beginRun();
    act(() => current?.submit({ text: "queued work", image: null }));

    act(() => deliver({
      type: "entries",
      sessionId: session.id,
      entries: [{
        type: "message",
        message: { role: "user", content: "queued work", timestamp: 10 },
      }],
    }));

    expect(current?.messages).toHaveLength(1);
    expect(messageText(current!.messages[0]!)).toBe("queued work");
    expect(current?.messages[0]?.customType).toBeUndefined();
    expect(current?.hasPendingFollowUp).toBe(false);
  });

  it("retains an unechoed follow-up marker across reconnect history", () => {
    act(() => deliver({ type: "entries", sessionId: session.id, entries: [] }));
    beginRun();
    act(() => current?.submit({ text: "still queued", image: null }));

    act(() => handlers.onClose?.(1006));
    act(() => handlers.onOpen?.());
    act(() => deliver({
      type: "state",
      sessionId: session.id,
      isStreaming: true,
      isCompacting: false,
    }));
    act(() => deliver({ type: "entries", sessionId: session.id, entries: [] }));

    expect(current?.messages).toHaveLength(1);
    expect(current?.messages[0]).toMatchObject({ customType: "followUp", optimisticId: 1 });
    expect(messageText(current!.messages[0]!)).toBe("still queued");
    expect(current?.hasPendingFollowUp).toBe(true);
  });
});
