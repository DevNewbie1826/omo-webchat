import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelPicker } from "./ModelPicker";

const catalog = [
  { provider: "provider-a", modelId: "model-a", name: "Model A" },
  { provider: "provider-b", modelId: "model-b", name: "Model B" },
  { provider: "provider-c", modelId: "model-b", name: "Model B" },
  ...Array.from({ length: 50 }, (_, i) => ({ provider: "long-provider", modelId: `long-${i}`,
    name: `Long model ${i}: 실험 검증용 긴 모델 이름 with readable identity` })),
];

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing picker control");
  return value;
}

function key(key: string, shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true });
  required(document.activeElement).dispatchEvent(event);
  return event;
}

describe("bounded desktop ModelPicker", () => {
  let container: HTMLDivElement;
  let root: Root;
  let resize: () => void;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resize = callback; }
      observe(): void { /* Geometry changes are delivered explicitly. */ }
      disconnect(): void { /* No async observer remains. */ }
    });
    container = document.createElement("div");
    container.className = "th-chat-main";
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function render(thinking = false): HTMLButtonElement {
    act(() => root.render(<ModelPicker models={catalog} currentModelKey="provider-a/model-a"
      placeholder="Model" searchPlaceholder="Search" onSelect={() => undefined}
      {...(thinking ? { thinkingLevels: ["off", "low", "medium", "high", "max"],
        thinkingLevel: "low", onThinkingChange: () => undefined } : {})} />));
    return required(container.querySelector<HTMLButtonElement>(".th-model-picker-btn"));
  }

  // R1 actual-App rectangles: every first pane's clipping column starts at 44.
  it.each([
    ["normal53-model", 817.203125, 765],
    ["v3-900", 214.484375, 162], ["v3-700", 147.6875, 95],
    ["v4-900", 139.203125, 87], ["v4-700", 89.203125, 37],
    ["mixed-900", 214.484375, 162], ["mixed-700", 147.6875, 95],
  ])("tightens both caps to the actual R1 %s column space", (_name, top, available) => {
    const trigger = render(true);
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 44, 1176, 856));
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(new DOMRect(0, top, 71, 19));
    act(() => trigger.click());
    const popup = required(container.querySelector<HTMLElement>(".th-model-picker-popover"));
    expect(popup.style.maxHeight).toBe(`min(280px, 50dvh, ${available}px)`);
    expect(popup.classList.contains("th-model-picker-popover--short")).toBe(available < 60);
    expect(popup.querySelectorAll('[role="option"]')).toHaveLength(53);
  });

  it("recomputes the bound without a floor when the trigger loses space", () => {
    const trigger = render();
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 44, 1176, 856));
    const rect = vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 817, 71, 19));
    act(() => trigger.click());
    rect.mockReturnValue(new DOMRect(0, 89, 71, 19));
    act(() => resize());
    expect(required(container.querySelector<HTMLElement>(".th-model-picker-popover")).style.maxHeight)
      .toBe("min(280px, 50dvh, 37px)");
    rect.mockReturnValue(new DOMRect(0, 48, 71, 19));
    act(() => resize());
    expect(required(container.querySelector<HTMLElement>(".th-model-picker-popover")).style.maxHeight)
      .toBe("min(280px, 50dvh, 0px)");
  });

  it("scrolls only the desktop popup to reveal the active option, never a hidden ancestor", () => {
    const scrollIntoView = vi.fn();
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
    try {
      const trigger = render();
      act(() => trigger.click());
      const popup = required(container.querySelector<HTMLElement>(".th-model-picker-popover"));
      const options = popup.querySelectorAll<HTMLElement>('[role="option"]');
      vi.spyOn(popup, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 260, 120));
      vi.spyOn(popup, "clientHeight", "get").mockReturnValue(118);
      vi.spyOn(popup, "clientTop", "get").mockReturnValue(1);
      vi.spyOn(required(options[1]), "getBoundingClientRect").mockReturnValue(new DOMRect(0, 300, 250, 50));
      act(() => key("ArrowDown"));
      expect(popup.scrollTop).toBe(131);
      expect(container.scrollTop).toBe(0);
      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", original);
      else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    }
  });

  it("allows Tab through desktop thinking and Shift+Tab back to search, then exits coherently", () => {
    const trigger = render(true);
    act(() => trigger.click());
    const search = required(container.querySelector<HTMLInputElement>("input"));
    const levels = Array.from(container.querySelectorAll<HTMLButtonElement>(".th-thinking-level"));
    expect(document.activeElement).toBe(search);
    for (const level of levels) {
      act(() => key("Tab"));
      expect(document.activeElement).toBe(level);
    }
    for (const control of [...levels.slice(0, -1).reverse(), search]) {
      act(() => key("Tab", true));
      expect(document.activeElement).toBe(control);
    }
    act(() => key("Tab", true));
    expect(container.querySelector(".th-model-picker-popover")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
