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
});
