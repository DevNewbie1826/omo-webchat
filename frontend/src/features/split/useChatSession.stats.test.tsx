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

describe("useChatSession stats", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it("stores context usage and compaction state and refreshes stats after a run", async () => {
    let deliver: ((frame: ChatServerFrame) => void) | undefined;
    let current: ReturnType<typeof useChatSession> | undefined;
    const sent: ChatClientFrame[] = [];
    const connect: ChatConnector = (handlers) => {
      deliver = handlers.onFrame;
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

    expect(sent).toEqual([
      { type: "chat.create", wsId: "workspace-1", chatId: "chat-1" },
    ]);

    act(() => {
      deliver?.({ type: "ready", sessionId: "chat-1", piSessionId: null, resumed: false });
    });
    expect(sent.slice(1)).toEqual([
      { type: "chat.stats", sessionId: "chat-1" },
    ]);

    act(() => {
      deliver?.({
        type: "stats",
        sessionId: "chat-1",
        contextUsage: { tokens: 42, contextWindow: 100, percent: 42 },
        tokens: { input: 30, cacheRead: 70, output: 5 },
      });
      deliver?.({
        type: "state",
        sessionId: "chat-1",
        isStreaming: false,
        isCompacting: true,
      });
    });

    expect(current?.contextUsage?.percent).toBe(42);
    expect(current?.isCompacting).toBe(true);
    // cacheRead / (cacheRead + input) = 70 / (70 + 30) = 0.7
    expect(current?.cacheHitRate).toBe(0.7);

    await act(async () => {
      deliver?.({ type: "run.done", sessionId: "chat-1", reason: "stop" });
    });

    expect(sent.filter((frame) => frame.type === "chat.stats")).toHaveLength(2);
  });
});
