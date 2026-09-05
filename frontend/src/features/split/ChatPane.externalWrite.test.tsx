import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseChatServerFrame, type ChatServerFrame } from "../../lib/chatWs";
import { chatSession, ControlledResizeObserver, renderChatPane, requireElement, setTextareaValue } from "./chatPaneTestHarness";

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
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(768);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(1024);
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    ControlledResizeObserver.instances = [];
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([false, true])("retains transcript, draft, and sibling on rejected resync (partial pages: %s)", (partial) => {
    const siblingContainer = document.createElement("div");
    document.body.appendChild(siblingContainer);
    const siblingRoot = createRoot(siblingContainer);
    try {
      const primary = renderChatPane(root);
      const sibling = renderChatPane(siblingRoot, { ...chatSession, id: "chat-2" });
      act(() => {
        for (const [pane, sessionId, content] of [
          [primary, "chat-1", "retained transcript"],
          [sibling, "chat-2", "sibling transcript"],
        ] as const) {
          pane.deliver({ type: "ready", sessionId, piSessionId: `pi-${sessionId}`, resumed: true });
          pane.deliver({ type: "entries", sessionId, entries: [{ id: sessionId, type: "message", message: { role: "user", content } }], final: true });
        }
      });
      const draft = requireElement(container.querySelector<HTMLTextAreaElement>(".th-chat-input textarea"), "primary composer");
      const siblingDraft = requireElement(siblingContainer.querySelector<HTMLTextAreaElement>(".th-chat-input textarea"), "sibling composer");
      act(() => {
        setTextareaValue(draft, "primary unsent draft");
        setTextareaValue(siblingDraft, "sibling unsent draft");
      });
      expect(container.textContent).toContain("retained transcript");
      expect(siblingContainer.textContent).toContain("sibling transcript");
      const siblingBefore = siblingContainer.innerHTML;
      const siblingSent = [...sibling.sent];
      act(() => requireElement(container.querySelector<HTMLButtonElement>(".th-chat-resync-btn"), "resync").click());
      expect(primary.sent.slice(-2)).toEqual([
        { type: "chat.close", sessionId: "chat-1" },
        { type: "chat.create", wsId: "workspace-1", chatId: "chat-1" },
      ]);
      act(() => {
        primary.deliver({ type: "ready", sessionId: "chat-1", piSessionId: "replacement", resumed: true });
        if (partial) primary.deliver({ type: "entries", sessionId: "chat-1", entries: [{ id: "rejected", type: "message", message: { role: "user", content: "rejected disk page" } }], final: false });
        primary.deliver(externalWriteFrame());
      });
      expect(container.textContent).toContain("retained transcript");
      expect(container.textContent).not.toContain("rejected disk page");
      expect(draft.value).toBe("primary unsent draft");
      expect(draft.disabled).toBe(true);
      expect(container.querySelector(".th-external-write-banner")).not.toBeNull();
      const send = requireElement(container.querySelector<HTMLButtonElement>(".th-chat-send-btn"), "send");
      expect(send.disabled).toBe(true);
      const sentBefore = [...primary.sent];
      act(() => send.click());
      expect(primary.sent).toEqual(sentBefore);
      expect(siblingContainer.innerHTML).toBe(siblingBefore);
      expect(siblingDraft.value).toBe("sibling unsent draft");
      expect(siblingDraft.disabled).toBe(false);
      expect(sibling.sent).toEqual(siblingSent);
    } finally {
      act(() => siblingRoot.unmount());
      siblingContainer.remove();
    }
  });

  it("discards rejected cold pages, disables composing, and keeps the banner through failed recovery", () => {
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

    expect(container.textContent).not.toContain("from disk");
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
