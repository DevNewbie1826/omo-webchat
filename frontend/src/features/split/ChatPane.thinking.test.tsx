import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatSession, ControlledResizeObserver, renderChatPane } from "./chatPaneTestHarness";

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

  function thinkingSelect(): HTMLSelectElement {
    const select = container.querySelector<HTMLSelectElement>(".th-thinking-select");
    if (!select) throw new Error("thinking select missing");
    return select;
  }

  it("includes the narrow model and thinking control inside the measured composer", () => {
    vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
    const { deliver } = renderChatPane(root, chatSession);
    const pane = container.querySelector(".th-chat-pane")!;
    const observer = ControlledResizeObserver.instances.find((item) => item.targets.has(pane))!;
    const resizePane = (width: number): void => {
      act(() => observer.callback([{ target: pane, contentRect: { width, height: 740 } } as ResizeObserverEntry],
        observer as unknown as ResizeObserver));
    };
    act(() => {
      deliver({ type: "models", sessionId: "chat-1", models: [{ provider: "openai", modelId: "gpt-5", name: "GPT-5" }] });
      deliver({ type: "state", sessionId: "chat-1", isStreaming: false, isCompacting: false,
        model: { provider: "openai", modelId: "gpt-5" }, thinkingLevel: "high" });
    });
    resizePane(375);
    const picker = container.querySelector(".th-model-picker");
    expect(picker?.closest(".th-chat-input")).not.toBeNull();
    expect(container.querySelectorAll(".th-model-picker")).toHaveLength(1);
    expect(picker?.textContent).toContain("GPT-5");
    expect(picker?.textContent).toContain("high");
    resizePane(800);
    expect(container.querySelector(".th-model-picker")?.closest(".th-termhead")).not.toBeNull();
    expect(container.querySelectorAll(".th-model-picker")).toHaveLength(1);
  });

  it("offers every Omo thinking level", () => {
    renderChatPane(root, chatSession);
    const options = Array.from(thinkingSelect().querySelectorAll("option")).map((option) => option.value);
    expect(options).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  it("retains an authoritative unknown thinking level as an option", () => {
    const { deliver } = renderChatPane(root, chatSession);
    act(() => {
      deliver({
        type: "state",
        sessionId: "chat-1",
        isStreaming: false,
        isCompacting: false,
        thinkingLevel: "ultra",
      });
    });
    const select = thinkingSelect();
    const options = Array.from(select.querySelectorAll("option")).map((option) => option.value);
    expect(options).toContain("ultra");
    expect(select.value).toBe("ultra");
  });

  it("sends chat.set with the chosen thinking level", () => {
    const { sent } = renderChatPane(root, chatSession);
    const select = thinkingSelect();
    act(() => {
      select.value = "xhigh";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(sent).toContainEqual(
      expect.objectContaining({ type: "chat.set", sessionId: "chat-1", thinkingLevel: "xhigh" }),
    );
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
