import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translate, type I18nValue } from "../../i18n";
import { parseChatServerFrame, type ChatServerFrame } from "../../lib/chatWs";
import { chatSession, i18n as identityI18n, renderChatPane } from "./chatPaneTestHarness";

function realI18n(lang: "en" | "ko"): I18nValue {
	return { ...identityI18n, lang, t: (key) => translate(lang, key) };
}

function wireNoticeFrame(seq: number, sessionId = "chat-1"): Record<string, unknown> {
  return {
    type: "notice",
    sessionId,
    kind: "auto_retry_start",
    payload: { message: `n${seq}` },
    at: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
  };
}

function deliverWire(deliver: (frame: ChatServerFrame) => void, wire: Record<string, unknown>): void {
  const parsed = parseChatServerFrame(wire);
  if (parsed) deliver(parsed);
}

function loadHistory(deliver: (frame: ChatServerFrame) => void): void {
  deliver({ type: "entries", sessionId: "chat-1", entries: [], final: true });
}

describe("ChatPane notice frames", () => {
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

  it("renders delivered notices in the transcript flow, oldest at top", () => {
    const { deliver } = renderChatPane(root);

    act(() => {
      loadHistory(deliver);
      for (let seq = 1; seq <= 3; seq += 1) deliverWire(deliver, wireNoticeFrame(seq));
    });

    expect(container.querySelector(".th-notice-stack")).toBeNull();
    const rows = container.querySelectorAll(".th-chat-history .th-chat-notice");
    expect(rows.length).toBe(3);
    const texts = [...rows].map((row) => row.textContent ?? "");
    expect(texts.findIndex((text) => text.includes("n1"))).toBe(0);
    expect(texts[2]).toContain("n3");
  });

  it("drops notices scoped to another session", () => {
    const { deliver } = renderChatPane(root);

    act(() => {
      loadHistory(deliver);
      deliverWire(deliver, wireNoticeFrame(1, "chat-2"));
    });
    expect(container.querySelector(".th-chat-notice")).toBeNull();

    act(() => {
      deliverWire(deliver, wireNoticeFrame(2));
    });
    expect(container.querySelector(".th-chat-notice")).not.toBeNull();
    expect(container.textContent).toContain("n2");
  });

  it("keeps notices mounted while later lifecycle frames arrive, showing the translated label", () => {
    const { deliver } = renderChatPane(root, chatSession, realI18n("en"));

    act(() => {
      loadHistory(deliver);
      deliverWire(deliver, wireNoticeFrame(1));
      deliver({ type: "run.started", sessionId: "chat-1" });
      deliver({ type: "run.done", sessionId: "chat-1", reason: "stop" });
    });

    expect(container.textContent).toContain("n1");
    expect(container.textContent).toContain("Auto retry started");
    expect(container.textContent).not.toContain("auto_retry_start");
    expect(container.textContent).not.toContain("notice.autoRetryStarted");
  });

  it("renders the auto-retry notice with the ko locale's translated label", () => {
    const { deliver } = renderChatPane(root, chatSession, realI18n("ko"));

    act(() => {
      loadHistory(deliver);
      deliverWire(deliver, wireNoticeFrame(1));
    });

    expect(container.textContent).toContain("n1");
    expect(container.textContent).toContain("자동 재시도 시작");
    expect(container.textContent).not.toContain("auto_retry_start");
    expect(container.textContent).not.toContain("notice.autoRetryStarted");
  });
});
