import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseChatServerFrame, type ChatServerFrame } from "../../lib/chatWs";
import { renderChatPane } from "./chatPaneTestHarness";

function wireNoticeFrame(seq: number): Record<string, unknown> {
  return {
    type: "notice",
    sessionId: "chat-1",
    kind: "auto_retry_start",
    payload: { message: `n${seq}` },
    at: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
  };
}

function deliverWire(deliver: (frame: ChatServerFrame) => void, wire: Record<string, unknown>): void {
  const parsed = parseChatServerFrame(wire);
  if (parsed) deliver(parsed);
}

function noticeRows(container: HTMLDivElement): NodeListOf<Element> {
  return container.querySelectorAll(".th-chat-history .th-chat-row--notice");
}

describe("ChatPane notices while history is loading", () => {
  let container: HTMLDivElement;
  let root: Root;

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
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("renders no notice rows and shows loading when only a notice frame has arrived", () => {
    const { deliver } = renderChatPane(root);

    act(() => {
      deliverWire(deliver, wireNoticeFrame(1));
    });

    expect(noticeRows(container).length).toBe(0);
    expect(container.querySelector(".th-chat-loading")).not.toBeNull();
  });

  it("renders the notice row after a subsequent final entries frame", () => {
    const { deliver } = renderChatPane(root);

    act(() => {
      deliverWire(deliver, wireNoticeFrame(1));
    });
    expect(noticeRows(container).length).toBe(0);
    expect(container.querySelector(".th-chat-loading")).not.toBeNull();

    act(() => {
      deliver({
        type: "entries",
        sessionId: "chat-1",
        entries: [
          { type: "message", message: { role: "assistant", content: "restored" } },
        ],
        final: true,
      });
    });

    expect(noticeRows(container).length).toBe(1);
    expect(container.querySelector(".th-chat-loading")).toBeNull();
  });

  it("renders the notice row when initialize_failed arrives without entries", () => {
    const { deliver } = renderChatPane(root);

    act(() => {
      deliverWire(deliver, wireNoticeFrame(1));
      deliver({
        type: "error",
        sessionId: "chat-1",
        code: "initialize_failed",
        message: "initialize failed",
      });
    });

    expect(noticeRows(container).length).toBe(1);
  });

  it("renders the notice row when history loading stalls", () => {
    vi.useFakeTimers();
    const { deliver } = renderChatPane(root);

    act(() => {
      deliverWire(deliver, wireNoticeFrame(1));
    });
    expect(noticeRows(container).length).toBe(0);

    act(() => {
      vi.advanceTimersByTime(30_001);
    });

    expect(noticeRows(container).length).toBe(1);
  });

  it("renders the notice row for a dangling resume failure without entries", () => {
    const { deliver } = renderChatPane(root);

    act(() => {
      deliverWire(deliver, wireNoticeFrame(1));
      deliver({
        type: "error",
        sessionId: "chat-1",
        code: "resume_failed",
        dangling: true,
        candidates: [],
        message: "resume failed",
      });
    });

    expect(noticeRows(container).length).toBe(1);
  });

  it("keeps the notice row mounted when live frames clear a terminal history error", () => {
    const { deliver } = renderChatPane(root);

    act(() => {
      deliverWire(deliver, wireNoticeFrame(1));
      deliver({
        type: "error",
        sessionId: "chat-1",
        code: "initialize_failed",
        message: "initialize failed",
      });
    });
    expect(noticeRows(container).length).toBe(1);

    act(() => {
      deliver({
        type: "messageDelta",
        sessionId: "chat-1",
        delta: { kind: "text_delta", delta: "live" },
      });
    });
    expect(noticeRows(container).length).toBe(1);

    act(() => {
      deliver({
        type: "tool",
        sessionId: "chat-1",
        toolCallId: "call-1",
        toolName: "bash",
        phase: "start",
      });
    });
    expect(noticeRows(container).length).toBe(1);

    act(() => {
      deliver({ type: "compaction.started", sessionId: "chat-1" });
    });
    expect(noticeRows(container).length).toBe(1);
  });

  it("keeps notices gated for a request-scoped control error", () => {
    const { deliver } = renderChatPane(root);

    act(() => {
      deliverWire(deliver, wireNoticeFrame(1));
      deliver({
        type: "error",
        sessionId: "chat-1",
        code: "initialize_failed",
        requestId: "control-1",
        message: "",
      });
    });

    expect(noticeRows(container).length).toBe(0);
    expect(container.querySelector(".th-chat-loading")).not.toBeNull();
  });
});
