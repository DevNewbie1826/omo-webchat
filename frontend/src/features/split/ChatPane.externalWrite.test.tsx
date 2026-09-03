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

  it("consumes the terminal cold snapshot, disables composing, and keeps the banner through failed recovery", () => {
    const { deliver, sent } = renderChatPane(root);

    act(() => {
      deliver({
        type: "entries",
        sessionId: "chat-1",
        entries: [{ id: "disk-entry", type: "message", message: { role: "user", content: "from disk" } }],
        final: false,
      });
      deliver(externalWriteFrame());
    });

    expect(container.textContent).toContain("chat.externalWriteTitle");
    expect(container.textContent).toContain("chat.externalWriteDetail");
    expect(container.textContent).not.toContain("external write detected");
    expect(container.querySelector<HTMLTextAreaElement>(".th-chat-input textarea")?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>(".th-chat-send-btn")?.disabled).toBe(true);
    const reload = requireElement(
      container.querySelector<HTMLButtonElement>(".th-external-write-banner-actions"),
      "external-write reload control",
    );

    act(() => reload.click());
    expect(sent.at(-1)).toEqual({
      type: "chat.create",
      wsId: "workspace-1",
      chatId: "chat-1",
      recovery: true,
    });
    expect(container.querySelector(".th-external-write-banner")).not.toBeNull();

    act(() => deliver({
      type: "error",
      sessionId: "chat-1",
      code: "initialize_failed",
      message: "recovery failed",
    }));
    expect(container.querySelector(".th-external-write-banner")).not.toBeNull();
    expect(container.querySelector<HTMLTextAreaElement>(".th-chat-input textarea")?.disabled).toBe(true);
  });

  it("clears the banner only after recovery is ready and its cold pages complete", () => {
    const { deliver } = renderChatPane(root);
    act(() => deliver(externalWriteFrame()));
    const reload = requireElement(
      container.querySelector<HTMLButtonElement>(".th-external-write-banner-actions"),
      "external-write reload control",
    );
    act(() => reload.click());

    act(() => deliver({
      type: "entries",
      sessionId: "chat-1",
      entries: [{ id: "recovered", type: "message", message: { role: "user", content: "recovered history" } }],
      final: false,
    }));
    expect(container.querySelector(".th-external-write-banner")).not.toBeNull();

    act(() => deliver({ type: "ready", sessionId: "chat-1", piSessionId: "pi-1", resumed: true }));
    expect(container.querySelector(".th-external-write-banner")).not.toBeNull();

    act(() => deliver({ type: "entries", sessionId: "chat-1", entries: [], final: true }));
    expect(container.querySelector(".th-external-write-banner")).toBeNull();
    expect(container.querySelector<HTMLTextAreaElement>(".th-chat-input textarea")?.disabled).toBe(false);
  });
});
