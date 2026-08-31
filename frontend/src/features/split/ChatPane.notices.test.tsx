import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatServerFrame } from "../../lib/chatWs";
import { ControlledResizeObserver, renderChatPane } from "./chatPaneTestHarness";

function noticeFrame(seq: number, sessionId = "chat-1"): ChatServerFrame {
  return {
    type: "notice",
    sessionId,
    kind: "auto_retry_start",
    payload: { message: `n${seq}` },
  } as ChatServerFrame;
}

describe("ChatPane notice frames", () => {
  let container: HTMLDivElement;
  let root: Root;

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
    ControlledResizeObserver.instances = [];
    container.remove();
    vi.unstubAllGlobals();
  });

  it("keeps the newest five of six notices, latest first", () => {
    const { deliver } = renderChatPane(root);

    act(() => {
      for (let seq = 1; seq <= 6; seq += 1) deliver(noticeFrame(seq));
    });

    const banners = container.querySelectorAll(".th-notice-stack .th-alert");
    expect(banners.length).toBe(5);
    expect(banners[0]?.textContent).toContain("n6");
    expect(banners[banners.length - 1]?.textContent).toContain("n2");
    expect(container.textContent).not.toContain("n1");
  });

  it("drops notices scoped to another session", () => {
    const { deliver } = renderChatPane(root);

    act(() => {
      deliver(noticeFrame(1, "chat-2"));
    });
    expect(container.querySelector(".th-notice-stack")).toBeNull();

    act(() => {
      deliver(noticeFrame(2));
    });
    expect(container.querySelector(".th-notice-stack")).not.toBeNull();
    expect(container.textContent).toContain("n2");
  });

  it("keeps notices mounted while later lifecycle frames arrive", () => {
    const { deliver } = renderChatPane(root);

    act(() => {
      deliver(noticeFrame(1));
      deliver({ type: "run.started", sessionId: "chat-1" });
      deliver({ type: "run.done", sessionId: "chat-1", reason: "stop" });
    });

    expect(container.textContent).toContain("n1");
    expect(container.textContent).toContain("auto_retry_start");
  });
});
