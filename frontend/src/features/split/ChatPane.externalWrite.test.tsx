import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseChatServerFrame, type ChatServerFrame } from "../../lib/chatWs";
import { ControlledResizeObserver, renderChatPane, requireElement } from "./chatPaneTestHarness";

function externalWriteFrame(): ChatServerFrame {
  const frame = parseChatServerFrame({
    type: "error",
    sessionId: "chat-1",
    code: "external-write-detected",
    message: "external write detected",
    knownLeaf: "daemon-leaf",
    observedLeaf: "disk-leaf",
  });
  if (frame === null) throw new Error("expected external-write frame to parse");
  return frame;
}

describe("ChatPane external-write recovery", () => {
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
    await act(async () => { root.unmount(); });
    ControlledResizeObserver.instances = [];
    container.remove();
    vi.unstubAllGlobals();
  });

  it("shows a localized banner and re-attaches through chat.create", () => {
    const { deliver, sent } = renderChatPane(root);

    act(() => deliver(externalWriteFrame()));

    expect(container.textContent).toContain("chat.externalWriteTitle");
    expect(container.textContent).toContain("chat.externalWriteDetail");
    expect(container.textContent).not.toContain("external write detected");
    const reload = requireElement(
      container.querySelector<HTMLButtonElement>(".th-external-write-banner-actions"),
      "external-write reload control",
    );
    expect(reload.textContent).toBe("chat.externalWriteReload");

    act(() => reload.click());

    expect(sent.at(-1)).toEqual({ type: "chat.create", wsId: "workspace-1", chatId: "chat-1" });
    expect(container.querySelector(".th-external-write-banner")).toBeNull();
  });
});
