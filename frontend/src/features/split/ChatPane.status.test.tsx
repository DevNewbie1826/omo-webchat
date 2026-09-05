import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlledResizeObserver, renderChatPane } from "./chatPaneTestHarness";

describe("ChatPane status row", () => {
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

  it("renders delivered context and cache stats below the transcript instead of in the header", () => {
    const { deliver } = renderChatPane(root);

    act(() => {
      deliver({
        type: "stats",
        sessionId: "chat-1",
        contextUsage: { tokens: 42, contextWindow: 100, percent: 42 },
        tokens: { input: 30, cacheRead: 70, output: 5 },
      });
    });

    const header = container.querySelector(".th-termhead");
    const status = container.querySelector(".th-chat-status");
    const transcript = container.querySelector(".th-chat-scrollport");
    const composer = container.querySelector(".th-chat-input");

    expect(status?.textContent).toContain("chat.contextUsage42%");
    expect(status?.textContent).toContain("chat.cacheHit70%");
    expect(header?.querySelector(".th-context-badge")).toBeNull();
    expect(status?.previousElementSibling).toBe(transcript);
    expect(status?.parentElement?.className).toBe("th-chat-main-content");
    expect(status?.parentElement?.nextElementSibling).toBe(composer);
  });

  it("keeps the status row free of a top divider", () => {
    const css = readFileSync("src/styles/chat-pane.css", "utf8");
    const statusRule = css.match(/\.th-chat-status\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(statusRule).not.toMatch(/border-top/);
  });

  it("shows the compacting indicator for the live manual compaction state", () => {
    const { deliver } = renderChatPane(root);

    const status = () => container.querySelector(".th-chat-status");
    expect(status()?.textContent).not.toContain("chat.compacting");

    act(() => {
      deliver({ type: "compaction.started", sessionId: "chat-1" });
    });
    expect(status()?.textContent).toContain("chat.compacting");

    act(() => {
      deliver({ type: "compaction.done", sessionId: "chat-1" });
    });
    expect(status()?.textContent).not.toContain("chat.compacting");
  });
});
