import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translate } from "../../i18n";
import { chatSession, ControlledResizeObserver, i18n, renderChatPane, requireElement, setTextareaValue } from "./chatPaneTestHarness";

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

  it.each(["en", "ko"] as const)("allocates localized state labels separately from the original steer preview in %s", (lang) => {
    const { deliver, sent } = renderChatPane(root, chatSession, { ...i18n, lang, t: (key, vars) => translate(lang, key, vars) });
    act(() => deliver({ type: "run.started", sessionId: chatSession.id }));
    const original = "status-fit-original-".repeat(8);
    const input = requireElement(container.querySelector<HTMLTextAreaElement>("textarea"), "composer");
    act(() => setTextareaValue(input, original));
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true })));
    const request = sent.find(frame => frame.type === "chat.send");
    if (request?.type !== "chat.send" || !request.requestId) throw new Error("missing steer request");
    const requestId = request.requestId;
    expect(request.run).toEqual({ kind: "steer", message: original });
    for (const phase of ["sending", "admitted"] as const) {
      if (phase === "admitted") act(() => deliver({ type: "ack", command: "chat.send", sessionId: chatSession.id, requestId, phase }));
      const status = requireElement(container.querySelector(`[data-request-id="${requestId}"]`), "request status");
      expect(status.getAttribute("data-send-phase")).toBe(phase);
      expect(status.querySelector(".th-chat-status-label")?.textContent).toBe(`${translate(lang, `chat.send.${phase}`)}:`);
      expect(status.querySelector(".th-chat-send-preview")?.textContent).toBe(original);
      expect(status.getAttribute("title")).toBe(original);
      expect(status.querySelector(".th-chat-status-spinner")).not.toBeNull();
    }
    const steer = requireElement(container.querySelector(".th-chat-status-item--steer"), "steer status");
    expect(steer.querySelector(".th-chat-status-label")?.textContent).toBe(translate(lang, "chat.steerPending", { text: "" }));
    expect(steer.getAttribute("title")).toBe(original);
    expect(container.querySelector(".th-chat-status-item--live")).not.toBeNull();
    expect(container.querySelector(".th-chat-scrollport .th-chat-msg--user")).toBeNull();
    act(() => deliver({ type: "ack", command: "chat.send", sessionId: chatSession.id, requestId, phase: "completed" }));
    expect(container.querySelector(".th-chat-send-status")).toBeNull();
    expect(container.querySelector(".th-chat-status-item--steer")).toBeNull();
    expect(container.querySelector(".th-chat-status-item--live")).not.toBeNull();
  });

  it.each(["sending", "admitted", "unknown", "steer"] as const)("inspects the full %s original without mutating request, queue or draft state", async (phase) => {
    const { deliver, sent } = renderChatPane(root);
    const original = "same-request-prefix " + "readable-original ".repeat(10) + "TAIL-ALPHA";
    expect(original).toHaveLength(210);
    const input = requireElement(container.querySelector<HTMLTextAreaElement>("textarea"), "composer");
    if (phase === "steer") act(() => deliver({ type: "run.started", sessionId: chatSession.id }));
    act(() => setTextareaValue(input, original));
    act(() => phase === "steer"
      ? input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true }))
      : container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    const request = sent.find(frame => frame.type === "chat.send");
    if (request?.type !== "chat.send" || !request.requestId) throw new Error("missing request");
    const requestId = request.requestId;
    if (phase === "admitted") act(() => deliver({ type: "ack", command: "chat.send", sessionId: chatSession.id, requestId, phase }));
    if (phase === "unknown") act(() => deliver({ type: "run.done", sessionId: chatSession.id, reason: "local_command" }));
    act(() => setTextareaValue(input, "newer unsent draft"));
    const status = requireElement(container.querySelector(phase === "steer" ? ".th-chat-status-item--steer" : `[data-request-id="${request.requestId}"]`), "status");
    if (phase !== "steer") expect(status.getAttribute("data-send-phase")).toBe(phase);
    expect(status.getAttribute("title")).toBe(original);
    const before = { status: container.querySelector(".th-chat-status")!.innerHTML, queue: container.querySelector(".th-queue")?.innerHTML, frames: [...sent] };
    const trigger = status.querySelector<HTMLButtonElement>("button.th-chat-send-preview");
    expect(trigger, "original inspection must have a named, keyboard-focusable trigger").not.toBeNull();
    expect(trigger!.getAttribute("aria-label")).toBe(i18n.t("chat.send.inspect"));
    expect(trigger!.tabIndex).toBe(0);
    for (const close of ["escape", "button"] as const) {
      await act(async () => { trigger!.focus(); trigger!.click(); });
      const dialog = requireElement(document.querySelector<HTMLElement>('[role="dialog"]'), "original dialog");
      expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toBe(i18n.t("chat.send.original"));
      expect(dialog.querySelector(".th-chat-original-text")?.textContent).toBe(original);
      expect(dialog.contains(document.activeElement)).toBe(true);
      await act(async () => close === "escape"
        ? document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
        : dialog.querySelector<HTMLButtonElement>(".th-modal-close")!.click());
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(document.activeElement).toBe(trigger);
      expect(input.value).toBe("newer unsent draft");
      expect(container.querySelector(".th-chat-status")!.innerHTML).toBe(before.status);
      expect(container.querySelector(".th-queue")?.innerHTML).toBe(before.queue);
      expect(sent).toEqual(before.frames);
    }
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
