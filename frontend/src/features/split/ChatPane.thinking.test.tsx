import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatSession, ControlledResizeObserver, pressKey, renderChatPane, requireElement } from "./chatPaneTestHarness";

describe("ChatPane thinking level selector", () => {
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

  function trigger(): HTMLButtonElement {
    return requireElement(container.querySelector<HTMLButtonElement>(".th-model-picker-btn"), "model trigger");
  }

  function level(value: string): HTMLButtonElement {
    return requireElement(Array.from(document.querySelectorAll<HTMLButtonElement>(".th-thinking-level"))
      .find(button => button.textContent === value), "thinking " + value);
  }

  it("keeps one bottom model and reported-thinking control at every pane width", () => {
    // Given a catalog and authoritative high state.
    vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
    const { deliver } = renderChatPane(root, chatSession);
    const pane = requireElement(container.querySelector(".th-chat-pane"), "pane");
    const observer = requireElement(ControlledResizeObserver.instances.find(item => item.targets.has(pane)), "observer");
    act(() => {
      deliver({ type: "models", sessionId: "chat-1", models: [{ provider: "openai", modelId: "gpt-5", name: "GPT-5" }] });
      deliver({ type: "state", sessionId: "chat-1", isStreaming: false, isCompacting: false,
        model: { provider: "openai", modelId: "gpt-5" }, thinkingLevel: "high" });
    });
    for (const width of [375, 800, 390]) {
      // When the same pane crosses the compact boundary.
      const entry: ResizeObserverEntry = { target: pane, contentRect: new DOMRect(0, 0, width, 740),
        borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] };
      act(() => observer.callback([entry], { observe() {}, unobserve() {}, disconnect() {} }));
      // Then one bottom control retains both visible and accessible state.
      expect(container.querySelectorAll(".th-model-picker-btn")).toHaveLength(1);
      expect(container.querySelectorAll(".th-thinking-select")).toHaveLength(0);
      expect(trigger().closest(".th-composer-model")?.closest(".th-chat-input")).not.toBeNull();
      expect(trigger().closest(".th-termhead")).toBeNull();
      expect(trigger().textContent).toContain("GPT-5");
      expect(trigger().querySelector(".th-model-picker-thinking")?.textContent).toBe("high");
      expect(trigger().getAttribute("aria-label")).toContain("GPT-5");
      expect(trigger().getAttribute("aria-label")).toContain("high");
    }
  });

  it.each(["loading", "empty", "failed"])("offers every level without selecting off when the catalog is %s", catalogState => {
    // Given no reported reasoning value and an unavailable catalog.
    const { deliver, sent } = renderChatPane(root, chatSession);
    act(() => {
      deliver({ type: "ready", sessionId: "chat-1", piSessionId: "pi-1", resumed: true });
      if (catalogState === "empty") deliver({ type: "models", sessionId: "chat-1", models: [] });
      if (catalogState === "failed") deliver({ type: "error", sessionId: "chat-1", code: "provider_error",
        command: "get_available_models", message: "catalog unavailable" });
    });
    // When opening the sole bottom control.
    act(() => trigger().click());
    // Then every level is offered without a fabricated selection or request.
    const levels = Array.from(document.querySelectorAll<HTMLButtonElement>(".th-thinking-level"));
    expect(levels.map(button => button.textContent)).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(levels.every(button => button.getAttribute("aria-pressed") === "false")).toBe(true);
    expect(trigger().querySelector(".th-model-picker-thinking")).toBeNull();
    expect(sent.filter(frame => frame.type === "chat.set")).toEqual([]);
  });

  it("preserves reported identity and high when the catalog arrives after opening", () => {
    // Given a known model and high reasoning before catalog hydration.
    const { deliver, sent } = renderChatPane(root, chatSession);
    act(() => deliver({ type: "state", sessionId: "chat-1", isStreaming: false, isCompacting: false,
      model: { provider: "openai", modelId: "gpt-5" }, thinkingLevel: "high" }));
    expect(trigger().textContent).toContain("openai/gpt-5");
    act(() => trigger().click());
    const high = level("high");
    act(() => high.focus());
    // When the catalog arrives.
    act(() => deliver({ type: "models", sessionId: "chat-1",
      models: [{ provider: "openai", modelId: "gpt-5", name: "GPT-5" }] }));
    // Then state and focus survive without implicit changes.
    expect(trigger().textContent).toContain("GPT-5");
    expect(trigger().querySelector(".th-model-picker-thinking")?.textContent).toBe("high");
    expect(high.getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(high);
    expect(sent.filter(frame => frame.type === "chat.set")).toEqual([]);
  });

  it("retains authoritative ultra as a visible selected control without a catalog", () => {
    // Given an unknown but authoritative level.
    const { deliver, sent } = renderChatPane(root, chatSession);
    act(() => deliver({ type: "state", sessionId: "chat-1", isStreaming: false,
      isCompacting: false, thinkingLevel: "ultra" }));
    // When opening the picker.
    act(() => trigger().click());
    // Then ultra is selected instead of normalizing to a known level.
    expect(trigger().querySelector(".th-model-picker-thinking")?.textContent).toBe("ultra");
    expect(level("ultra").getAttribute("aria-pressed")).toBe("true");
    expect(level("off").getAttribute("aria-pressed")).toBe("false");
    expect(sent.filter(frame => frame.type === "chat.set")).toEqual([]);
  });

  it.each(["off", "minimal", "low", "medium", "high", "xhigh", "max"])("sends exactly one explicit %s change", chosen => {
    // Given an open bottom picker without a catalog.
    const { sent } = renderChatPane(root, chatSession);
    act(() => trigger().click());
    // When choosing an offered level by pointer.
    act(() => level(chosen).click());
    // Then the exact level is transmitted once, without a model change.
    expect(sent.filter(frame => frame.type === "chat.set")).toEqual([
      { type: "chat.set", sessionId: "chat-1", requestId: expect.any(String), thinkingLevel: chosen },
    ]);
  });

  it.each(["confirm", "reject"])("sends one max change and reflects its %s result without a catalog", outcome => {
    // Given confirmed high and an open picker.
    const { deliver, sent } = renderChatPane(root, chatSession);
    act(() => deliver({ type: "state", sessionId: "chat-1", isStreaming: false,
      isCompacting: false, thinkingLevel: "high" }));
    act(() => trigger().click());
    // When max is explicitly requested and its authoritative result arrives.
    act(() => level("max").click());
    const request = sent.find(frame => frame.type === "chat.set");
    if (request?.type !== "chat.set" || !request.requestId) throw new Error("missing thinking request");
    const requestId = request.requestId;
    expect(sent.filter(frame => frame.type === "chat.set")).toEqual([
      { type: "chat.set", sessionId: "chat-1", requestId, thinkingLevel: "max" },
    ]);
    act(() => {
      if (outcome === "confirm") deliver({ type: "control.result", sessionId: "chat-1",
        requestId, command: "set_thinking_level", success: true });
      else deliver({ type: "error", sessionId: "chat-1", requestId,
        command: "set_thinking_level", code: "provider_error", message: "thinking rejected" });
    });
    // Then badge and selected chip reflect confirmation or rollback.
    const expected = outcome === "confirm" ? "max" : "high";
    expect(trigger().querySelector(".th-model-picker-thinking")?.textContent).toBe(expected);
    expect(level(expected).getAttribute("aria-pressed")).toBe("true");
    expect(level(expected === "max" ? "high" : "max").getAttribute("aria-pressed")).toBe("false");
  });

  it("reaches desktop max by forward Tab before search and preserves native activation and Escape", () => {
    // Given a desktop catalog and reported high state.
    const { deliver, sent } = renderChatPane(root, chatSession);
    act(() => {
      deliver({ type: "models", sessionId: "chat-1", models: [{ provider: "provider-b", modelId: "model-b" }] });
      deliver({ type: "state", sessionId: "chat-1", isStreaming: false, isCompacting: false, thinkingLevel: "high" });
    });
    act(() => trigger().click());
    const popup = requireElement(container.querySelector<HTMLElement>(".th-model-picker-popover"), "popup");
    expect(document.activeElement).toBe(popup);
    // When traversing in DOM order to max and activating the native button.
    for (const value of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      const focused = document.activeElement;
      if (!(focused instanceof HTMLElement)) throw new Error("missing keyboard focus");
      act(() => pressKey(focused, "Tab"));
      expect(document.activeElement).toBe(level(value));
    }
    expect(document.activeElement).toBe(level("max"));
    act(() => {
      expect(pressKey(level("max"), "Enter").defaultPrevented).toBe(false);
      level("max").click(); // jsdom does not synthesize native Enter activation.
    });
    // Then only reasoning changes; Escape restores the trigger.
    expect(sent.filter(frame => frame.type === "chat.set")).toEqual([
      expect.objectContaining({ type: "chat.set", sessionId: "chat-1", thinkingLevel: "max" }),
    ]);
    act(() => pressKey(level("max"), "Escape"));
    expect(container.querySelector(".th-model-picker-popover")).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });
});

describe("ChatPane thinking disclosure", () => {
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

  function liveThinking(): HTMLDetailsElement {
    const details = container.querySelector<HTMLDetailsElement>(
      ".th-chat-live .th-chat-thinking",
    );
    if (!details) throw new Error("live thinking disclosure missing");
    return details;
  }

  it("keeps the live thinking disclosure collapsed while reasoning streams", () => {
    const { deliver } = renderChatPane(root, chatSession);
    act(() => {
      deliver({
        type: "messageDelta",
        sessionId: "chat-1",
        delta: { kind: "thinking_delta", delta: "Deep thought in progress" },
      });
    });

    const details = liveThinking();
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe("chat.thinking");
    expect(details.querySelector("pre")?.textContent).toBe("Deep thought in progress");
  });

  it("reveals the streamed reasoning from the collapsed disclosure", () => {
    const { deliver } = renderChatPane(root, chatSession);
    act(() => {
      deliver({
        type: "messageDelta",
        sessionId: "chat-1",
        delta: { kind: "thinking_delta", delta: "Deep thought in progress" },
      });
    });

    const details = liveThinking();
    const summary = details.querySelector("summary");
    if (!summary) throw new Error("thinking summary missing");
    act(() => {
      summary.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(details.open).toBe(true);
    expect(details.querySelector("pre")?.textContent).toBe("Deep thought in progress");
  });
});
