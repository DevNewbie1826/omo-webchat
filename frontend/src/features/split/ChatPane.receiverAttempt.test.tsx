import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseChatServerFrame } from "../../lib/chatWs";
import disk from "../../../../internal/session/testdata/receiver-disk.json";
import tail from "../../../../internal/session/testdata/receiver-tail.json";
import exhausted from "../../../../internal/session/testdata/receiver-exhausted.json";
import { chatSession, ControlledResizeObserver, renderChatPane, requireElement, setTextareaValue } from "./chatPaneTestHarness";

describe("ChatPane receiver attempt preservation", () => {
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

  it.each([["disk", disk], ["pre-tail", tail], ["exhausted", exhausted]] as const)(
    "retains both drafts and sibling across %s replacement",
    (boundary, stream) => {
      const siblingContainer = document.createElement("div");
      document.body.appendChild(siblingContainer);
      const siblingRoot = createRoot(siblingContainer);
      try {
        const primary = renderChatPane(root);
        const sibling = renderChatPane(siblingRoot, { ...chatSession, id: "chat-2" });
        act(() => {
          for (const [pane, sessionId] of [[primary, "chat-1"], [sibling, "chat-2"]] as const) {
            pane.deliver({ type: "ready", sessionId, piSessionId: `pi-${sessionId}`, resumed: true });
            pane.deliver({ type: "entries", sessionId, entries: [{ id: sessionId, type: "message", message: { role: "user", content: "retained transcript" } }], final: true });
          }
        });
        const draft = requireElement(container.querySelector<HTMLTextAreaElement>(".th-chat-input textarea"), "primary composer");
        const siblingDraft = requireElement(siblingContainer.querySelector<HTMLTextAreaElement>(".th-chat-input textarea"), "sibling composer");
        act(() => {
          setTextareaValue(draft, "primary unsent draft");
          setTextareaValue(siblingDraft, "sibling unsent draft");
        });
        const siblingBefore = siblingContainer.innerHTML;
        const siblingSent = [...sibling.sent];
        act(() => requireElement(container.querySelector<HTMLButtonElement>(".th-chat-resync-btn"), "resync").click());
        for (const value of stream) {
          const frame = parseChatServerFrame(value);
          if (frame === null) throw new Error("Invalid recorded receiver frame");
          act(() => primary.deliver(frame));
          expect(draft.value).toBe("primary unsent draft");
          expect(siblingContainer.innerHTML).toBe(siblingBefore);
          expect(sibling.sent).toEqual(siblingSent);
        }
        if (boundary === "exhausted") {
          act(() => primary.deliver({ type: "error", sessionId: "chat-1", code: "resume_failed", command: "get_entries", message: "Automatic recovery failed" }));
          expect(container.textContent).toContain("retained transcript");
          expect(container.querySelector(".th-chat-error")).not.toBeNull();
        } else {
          expect(container.querySelector(".th-chat-error")).toBeNull();
          act(() => primary.deliver({ type: "message", sessionId: "chat-1", message: { role: "assistant", blocks: [{ kind: "text", text: "subsequent live delivery" }] } }));
          // JSDOM has no layout/scrolling engine. Drive the real virtualizer's
          // scroll event to the measured history bottom before inspecting DOM.
          const body = requireElement(container.querySelector<HTMLDivElement>(".th-chat-body"), "scroll body");
          const history = requireElement(container.querySelector<HTMLDivElement>(".th-chat-history"), "history");
          act(() => {
            body.scrollTop = Number.parseFloat(history.style.height) - body.offsetHeight;
            body.dispatchEvent(new Event("scroll"));
          });
          expect(container.textContent).toContain("subsequent live delivery");
        }
        expect(draft.value).toBe("primary unsent draft");
        expect(siblingDraft.value).toBe("sibling unsent draft");
        expect(siblingDraft.disabled).toBe(false);
        expect(siblingContainer.innerHTML).toBe(siblingBefore);
        expect(sibling.sent).toEqual(siblingSent);
      } finally {
        act(() => siblingRoot.unmount());
        siblingContainer.remove();
      }
    },
  );
});
