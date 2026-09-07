import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatClientFrame, ChatConnector, ChatServerFrame } from "../../lib/chatWs";
import { ControlledResizeObserver, renderChatPane, requireElement, setTextareaValue } from "./chatPaneTestHarness";
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
    ControlledResizeObserver.instances = [];
    vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
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

  it.each(["model", "compact"] as const)("refreshes displayed usage after confirmed idle %s success without run.done", (control) => {
    const { deliver, sent } = renderChatPane(root);
    let cursor = 0;
    // The server answers only requests actually sent by the client. Advancing
    // its budget alone must never update the status display.
    const replyStats = (tokens: number, contextWindow: number, percent: number): void => {
      const requests = sent.slice(cursor);
      cursor = sent.length;
      act(() => {
        for (const frame of requests) {
          if (frame.type === "chat.stats") deliver({
            type: "stats", sessionId: frame.sessionId,
            contextUsage: { tokens, contextWindow, percent },
          });
        }
      });
    };
    act(() => {
      deliver({ type: "ready", sessionId: session.id, piSessionId: "provider-1", resumed: false });
      deliver({ type: "state", sessionId: session.id, isStreaming: false, isCompacting: false,
        model: { provider: "mock", modelId: "large" } });
      deliver({ type: "models", sessionId: session.id, models: [
        { provider: "mock", modelId: "large", name: "RPC46 Large" },
        { provider: "mock", modelId: "small", name: "RPC46 Small" },
      ] });
    });
    replyStats(136000, 400000, 34);
    const details = requireElement(container.querySelector<HTMLDetailsElement>(".th-chat-status-details"), "status details");
    act(() => requireElement(details.querySelector("summary"), "summary").click());
    const usage = () => details.querySelector(".th-chat-status-num")?.textContent;
    expect(details.open).toBe(true);
    expect(usage()).toBe("34%");

    if (control === "model") {
      act(() => requireElement(container.querySelector<HTMLButtonElement>(".th-model-picker-btn"), "model picker").click());
      const option = requireElement([...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
        .find(item => item.textContent?.includes("RPC46 Small")), "small model");
      act(() => option.click());
      const request = sent.find(frame => frame.type === "chat.set");
      if (request?.type !== "chat.set" || !request.requestId) throw new Error("missing model request");
      const requestId = request.requestId;
      act(() => deliver({ type: "ack", sessionId: session.id, command: "set_model", requestId }));
      replyStats(136000, 272000, 50);
      expect(usage()).toBe("34%");
      act(() => deliver({ type: "control.result", sessionId: session.id, command: "set_model", requestId, success: true }));
      replyStats(136000, 272000, 50);
      expect(usage()).toBe("50%");
    } else {
      // This branch isolates compaction's missing refresh from model success.
      act(() => deliver({ type: "stats", sessionId: session.id,
        contextUsage: { tokens: 136000, contextWindow: 272000, percent: 50 } }));
      const input = requireElement(container.querySelector<HTMLTextAreaElement>("textarea"), "composer");
      act(() => setTextareaValue(input, "/compact"));
      act(() => requireElement(container.querySelector("form"), "composer form")
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
      expect(sent.filter(frame => frame.type === "chat.compact")).toHaveLength(1);
      act(() => deliver({ type: "compaction.started", sessionId: session.id }));
      replyStats(27200, 272000, 10);
      expect(usage()).toBe("50%");
      act(() => deliver({ type: "compaction.done", sessionId: session.id }));
      replyStats(27200, 272000, 10);
      expect(usage()).toBe("10%");
    }
    expect(sent.filter(frame => frame.type === "chat.send")).toHaveLength(0);
    expect(sent.filter(frame => frame.type === "chat.stats")).toHaveLength(2);
  });

  it("displays provider percent verbatim apart from rounding, without recalculating the budget", () => {
    const { deliver } = renderChatPane(root);
    act(() => deliver({ type: "stats", sessionId: session.id,
      contextUsage: { tokens: 136000, contextWindow: 272000, percent: 29.4 } }));
    const details = requireElement(container.querySelector<HTMLDetailsElement>(".th-chat-status-details"), "status details");
    act(() => requireElement(details.querySelector("summary"), "summary").click());
    expect(details.querySelector(".th-chat-status-num")?.textContent).toBe("29%");
  });
});
