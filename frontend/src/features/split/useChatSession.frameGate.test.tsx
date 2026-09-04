import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatClientFrame, ChatConnector, ChatServerFrame } from "../../lib/chatWs";
import { useChatSession } from "./useChatSession";

const session = {
  id: "chat-1",
  name: "Chat",
  wsId: "workspace-1",
  cwd: "/work",
  provider: "omo",
} as const;

describe("useChatSession inbound session gate", () => {
  let root: Root;
  let container: HTMLDivElement;
  let current: ReturnType<typeof useChatSession> | undefined;
  let deliver: (frame: ChatServerFrame) => void;
  let reconnect: () => void;
  let sent: ChatClientFrame[];

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    sent = [];
    const connect: ChatConnector = (handlers) => {
      deliver = handlers.onFrame;
      reconnect = () => handlers.onOpen?.();
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

  it("drops foreign-session frames before any state mutation", () => {
    act(() => {
      deliver({ type: "message", sessionId: "chat-2", message: { role: "assistant", blocks: [{ kind: "text", text: "foreign" }] } });
      deliver({ type: "commands", sessionId: "chat-2", commands: [{ name: "foreign" }] });
      deliver({ type: "compaction.started", sessionId: "chat-2" });
      deliver({ type: "state", sessionId: "chat-2", isStreaming: true, isCompacting: true });
      deliver({ type: "stats", sessionId: "chat-2", contextUsage: { tokens: 2, contextWindow: 10, percent: 20 } });
    });

    expect(current?.messages).toEqual([]);
    expect(current?.commands).toEqual([]);
    expect(current?.isCompacting).toBe(false);
    expect(current?.running).toBe(false);
    expect(current?.contextUsage).toBeNull();
  });

  it("continues accepting matching and sessionless frames", () => {
    act(() => {
      deliver({ type: "commands", sessionId: "chat-1", commands: [{ name: "local" }] });
      deliver({ type: "compaction.started", sessionId: "chat-1" });
    });
    expect(current?.commands).toEqual([{ name: "local" }]);
    expect(current?.isCompacting).toBe(true);

    act(() => deliver({ type: "error", message: "socket failure" }));
    expect(current?.error).toBe("socket failure");
  });

  it("reapplies a compacting state after reconnect and queues a prompt", () => {
    act(() => reconnect());
    act(() => deliver({ type: "state", sessionId: "chat-1", isStreaming: false, isCompacting: true }));
    let accepted = false;
    act(() => {
      accepted = current?.submit({ text: "after reconnect", image: null }) ?? false;
    });
    expect(accepted).toBe(true);
    expect(sent.filter((frame) => frame.type === "chat.send")).toEqual([
      { type: "chat.send", sessionId: "chat-1", requestId: expect.any(String), run: { kind: "prompt", message: "after reconnect" } },
    ]);
    // Queued during compaction: the server owns the pending item, so the
    // transcript stays untouched.
    expect(current?.messages).toEqual([]);
    expect(current?.queuePlaceholders).toHaveLength(1);
  });
});
