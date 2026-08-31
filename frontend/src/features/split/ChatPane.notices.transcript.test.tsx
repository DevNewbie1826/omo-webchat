import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseChatServerFrame, type ChatServerFrame } from "../../lib/chatWs";
import { renderChatPane } from "./chatPaneTestHarness";

const NANO_AT = (ms: number): string => new Date(ms).toISOString();

function messageFrame(ts: number, text: string): ChatServerFrame {
  return {
    type: "message",
    sessionId: "chat-1",
    message: { role: "assistant", blocks: [{ kind: "text", text }], ts },
  };
}

function wireNoticeFrame(seq: number, at?: string): Record<string, unknown> {
  return {
    type: "notice",
    sessionId: "chat-1",
    kind: "auto_retry_start",
    payload: { message: `n${seq}` },
    ...(at !== undefined ? { at } : {}),
  };
}

function deliverWire(deliver: (frame: ChatServerFrame) => void, wire: Record<string, unknown>): void {
  const parsed = parseChatServerFrame(wire);
  if (parsed) deliver(parsed);
}

function rowTexts(container: HTMLDivElement): string[] {
  return [...container.querySelectorAll(".th-chat-history .th-chat-row")].map((row) => row.textContent ?? "");
}

describe("ChatPane in-transcript notices", () => {
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

  it("renders a server-stamped notice between the entries it chronologically belongs to", () => {
    const { deliver } = renderChatPane(root);

    act(() => {
      deliver(messageFrame(1_000, "early"));
      deliverWire(deliver, wireNoticeFrame(1, NANO_AT(2_000)));
      deliver(messageFrame(3_000, "late"));
    });

    expect(container.querySelector(".th-notice-stack")).toBeNull();
    const block = container.querySelector(".th-chat-history .th-chat-notice");
    expect(block).not.toBeNull();
    expect(block?.textContent).toContain("notice.system");
    expect(block?.textContent).toContain("n1");
    const texts = rowTexts(container);
    const early = texts.findIndex((text) => text.includes("early"));
    const notice = texts.findIndex((text) => text.includes("n1"));
    const late = texts.findIndex((text) => text.includes("late"));
    expect(early).toBeGreaterThanOrEqual(0);
    expect(late).toBeGreaterThan(early);
    expect(notice).toBeGreaterThan(early);
    expect(notice).toBeLessThan(late);
  });

  it("dismiss hides only that row locally and never reaches the server", () => {
    const { deliver, sent } = renderChatPane(root);

    act(() => {
      deliverWire(deliver, wireNoticeFrame(1));
      deliverWire(deliver, wireNoticeFrame(2));
    });
    expect(container.querySelectorAll(".th-chat-notice").length).toBe(2);
    const sentBefore = sent.length;

    const row = [...container.querySelectorAll(".th-chat-notice")].find((block) =>
      block.textContent?.includes("n1"),
    );
    const dismiss = row?.querySelector<HTMLButtonElement>("button[aria-label='notice.dismiss']");
    expect(dismiss).not.toBeNull();
    act(() => {
      dismiss?.click();
    });

    expect(container.textContent).not.toContain("n1");
    expect(container.textContent).toContain("n2");
    expect(container.querySelectorAll(".th-chat-notice").length).toBe(1);
    expect(sent.length).toBe(sentBefore);

    act(() => {
      deliverWire(deliver, wireNoticeFrame(3));
    });
    expect(container.textContent).not.toContain("n1");
    expect(container.textContent).toContain("n2");
    expect(container.textContent).toContain("n3");
  });

  it("does not render notices inside the live region", () => {
    const { deliver } = renderChatPane(root);

    act(() => {
      deliverWire(deliver, wireNoticeFrame(1));
    });

    expect(container.querySelector(".th-chat-live .th-chat-notice")).toBeNull();
    expect(container.querySelector(".th-chat-history .th-chat-notice")).not.toBeNull();
  });
});
