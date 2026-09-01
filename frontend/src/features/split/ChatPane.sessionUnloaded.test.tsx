import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseChatServerFrame, type ChatServerFrame } from "../../lib/chatWs";
import { ControlledResizeObserver, renderChatPane, requireElement } from "./chatPaneTestHarness";

function parsedFrame(raw: Record<string, unknown>): ChatServerFrame {
  const frame = parseChatServerFrame(raw);
  if (frame === null) throw new Error("expected a valid chat server frame");
  return frame;
}

// The locked wire shape for engine-side idle eviction: one unsolicited error
// frame tagged with the chat id and the resumable session_unloaded code.
function sessionUnloadedFrame(): ChatServerFrame {
  return parsedFrame({
    type: "error",
    sessionId: "chat-1",
    code: "session_unloaded",
    message: "session unloaded after 30m idle",
  });
}

describe("ChatPane session_unloaded resumable state", () => {
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

  it("shows the resumable unloaded banner instead of the raw error or a terminal state", () => {
    const { deliver } = renderChatPane(root);

    act(() => {
      deliver(sessionUnloadedFrame());
      deliver({ type: "entries", sessionId: "chat-1", entries: [], final: true });
    });

    expect(container.textContent).toContain("chat.sessionUnloadedTitle");
    expect(container.textContent).toContain("chat.sessionUnloadedDetail");
    expect(container.textContent).toContain("chat.sessionUnloadedResume");
    expect(container.textContent).not.toContain("session unloaded after 30m idle");
    expect(container.querySelector(".th-chat-error")).toBeNull();
    expect(container.querySelector(".th-unloaded-banner")).not.toBeNull();
    // The pane stays usable: the composer is present, the pane is not a
    // terminal dead end.
    expect(container.querySelector(".th-chat-input")).not.toBeNull();
  });

  it("clears a stale in-flight run indicator when the unload frame lands", () => {
    const { deliver } = renderChatPane(root);

    act(() => {
      deliver({ type: "run.started", sessionId: "chat-1" });
    });
    expect(container.textContent).toContain("chat.responding");

    act(() => {
      deliver(sessionUnloadedFrame());
    });

    expect(container.textContent).not.toContain("chat.responding");
    expect(container.textContent).toContain("chat.sessionUnloadedTitle");
  });

  it("re-sends chat.create for the pane's session when the resume control is used", () => {
    const { deliver, sent } = renderChatPane(root);

    act(() => {
      deliver(sessionUnloadedFrame());
    });

    const resume = requireElement(
      container.querySelector<HTMLButtonElement>(".th-unloaded-banner-actions"),
      "resume control",
    );
    act(() => {
      resume.click();
    });

    expect(sent.at(-1)).toEqual({ type: "chat.create", wsId: "workspace-1", chatId: "chat-1" });
  });

  it("clears the unloaded state once the resumed chat is live again", () => {
    const { deliver, sent } = renderChatPane(root);

    act(() => {
      deliver(sessionUnloadedFrame());
    });
    const resume = requireElement(
      container.querySelector<HTMLButtonElement>(".th-unloaded-banner-actions"),
      "resume control",
    );
    act(() => {
      resume.click();
    });
    act(() => {
      deliver({ type: "ready", sessionId: "chat-1", piSessionId: "pi-1", resumed: true });
      deliver({ type: "entries", sessionId: "chat-1", entries: [], final: true });
    });

    expect(container.querySelector(".th-unloaded-banner")).toBeNull();
    expect(container.textContent).not.toContain("chat.sessionUnloadedTitle");
    expect(container.textContent).not.toContain("chat.sessionUnloadedResume");
    // The resume re-sent chat.create on top of the mount-time open frame;
    // later frames (ready-triggered chat.stats) may follow, so assert on the
    // create frames themselves.
    const creates = sent.filter((frame) => frame.type === "chat.create");
    expect(creates).toHaveLength(2);
    expect(creates.at(-1)).toEqual({ type: "chat.create", wsId: "workspace-1", chatId: "chat-1" });
  });

  it("keeps the unloaded banner visible until the chat is live again, not on later entries alone", () => {
    const { deliver } = renderChatPane(root);

    act(() => {
      deliver(sessionUnloadedFrame());
      deliver({ type: "entries", sessionId: "chat-1", entries: [], final: true });
    });

    expect(container.querySelector(".th-unloaded-banner")).not.toBeNull();
  });
});
