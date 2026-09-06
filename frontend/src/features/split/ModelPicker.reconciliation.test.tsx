import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelPicker, type ModelOption } from "./ModelPicker";

const current = { provider: "long-provider", modelId: "long-49" };
const earlier = { provider: "provider-a", modelId: "model-a" };

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing picker control");
  return value;
}

describe("ModelPicker no-op navigation reconciliation", () => {
  let container: HTMLDivElement;
  let root: Root;
  let resize: () => void;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resize = callback; }
      observe(): void { /* The test delivers geometry changes explicitly. */ }
      disconnect(): void { /* No asynchronous observer remains. */ }
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

  it.each(["full", "empty"])("reveals focused reasoning when passive fit shrinks with a %s catalog", catalog => {
    // Given visible high in the taller popup, reached by forward Tab.
    const selected = vi.fn();
    const changed = vi.fn();
    const models = catalog === "empty" ? [] : [
      current,
      ...Array.from({ length: 52 }, (_, index) => ({
        provider: "provider-a", modelId: `model-${index}`,
      })),
    ];
    act(() => root.render(<ModelPicker models={models}
      currentModelKey="long-provider/long-49" placeholder="Model"
      searchPlaceholder="Search" onSelect={selected}
      thinkingLevels={["off", "minimal", "low", "medium", "high"]}
      thinkingLevel="high" onThinkingChange={changed} />));
    const trigger = required(container.querySelector<HTMLButtonElement>(".th-model-picker-btn"));
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 44, 1176, 656));
    const triggerRect = vi.spyOn(trigger, "getBoundingClientRect")
      .mockReturnValue(new DOMRect(0, 139, 71, 19));
    act(() => trigger.click());
    const popup = required(container.querySelector<HTMLElement>(".th-model-picker-popover"));
    for (let index = 0; index < 5; index++) {
      act(() => required(document.activeElement).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
      ));
    }
    const high = required(popup.querySelector<HTMLButtonElement>('.th-thinking-level[aria-pressed="true"]'));
    expect(document.activeElement).toBe(high);
    const clientHeight = vi.spyOn(popup, "clientHeight", "get").mockReturnValue(85);
    vi.spyOn(popup, "clientTop", "get").mockReturnValue(1);
    vi.spyOn(popup, "getBoundingClientRect").mockImplementation(
      () => new DOMRect(0, 47, 260, popup.clientHeight + 2),
    );
    vi.spyOn(high, "getBoundingClientRect").mockImplementation(
      () => new DOMRect(0, 120 - popup.scrollTop, 40, 21),
    );
    popup.scrollTop = 8;
    expect(high.getBoundingClientRect().bottom).toBeLessThanOrEqual(48 + popup.clientHeight);

    // When the column tightens without navigation or catalog hydration.
    act(() => {
      clientHeight.mockReturnValue(35);
      triggerRect.mockReturnValue(new DOMRect(0, 89, 71, 19));
      resize();
    });

    // Then high stays visible using only popup-local scrolling.
    expect(document.activeElement).toBe(high);
    expect(high.getBoundingClientRect().top).toBeGreaterThanOrEqual(48);
    expect(high.getBoundingClientRect().bottom).toBeLessThanOrEqual(48 + popup.clientHeight);
    expect(popup.scrollTop).toBe(58);
    expect(container.scrollTop).toBe(0);
    expect(selected).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  });

  it.each(
    [null, "ArrowUp", "ArrowDown"].flatMap(key =>
      [false, true].map(fit => ({ key, fit }))),
  )("preserves reasoning after no-op navigation ($key, fit=$fit)", ({ key, fit }) => {
    // Given a single active model and a navigation action that keeps its key.
    const selected = vi.fn();
    const changed = vi.fn();
    const renderCatalog = (models: readonly ModelOption[]): void => {
      root.render(<ModelPicker models={models} currentModelKey="long-provider/long-49"
        placeholder="Model" searchPlaceholder="Search" onSelect={selected}
        thinkingLevels={["off", "minimal", "low", "medium", "high"]}
        thinkingLevel="high" onThinkingChange={changed} />);
    };
    act(() => renderCatalog([current]));
    const trigger = required(container.querySelector<HTMLButtonElement>(".th-model-picker-btn"));
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 44, 1176, 656));
    const triggerRect = vi.spyOn(trigger, "getBoundingClientRect")
      .mockReturnValue(new DOMRect(0, 89, 71, 19));
    act(() => trigger.click());
    const popup = required(container.querySelector<HTMLElement>(".th-model-picker-popover"));
    const option = required(popup.querySelector<HTMLButtonElement>('[role="option"]'));
    const search = required(popup.querySelector<HTMLInputElement>("input"));
    expect(search.getAttribute("aria-activedescendant")).toBe(option.id);
    act(() => {
      if (key) popup.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      else option.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    });
    expect(search.getAttribute("aria-activedescendant")).toBe(option.id);
    for (let index = 0; index < 5; index++) {
      act(() => required(document.activeElement).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
      ));
    }
    const high = required(popup.querySelector<HTMLButtonElement>('.th-thinking-level[aria-pressed="true"]'));
    expect(document.activeElement).toBe(high);
    vi.spyOn(popup, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 47, 260, 37));
    const clientHeight = vi.spyOn(popup, "clientHeight", "get").mockReturnValue(35);
    vi.spyOn(popup, "clientTop", "get").mockReturnValue(1);
    vi.spyOn(high, "getBoundingClientRect").mockImplementation(
      () => new DOMRect(0, 120 - popup.scrollTop, 40, 21),
    );
    vi.spyOn(option, "getBoundingClientRect").mockImplementation(
      () => new DOMRect(0, 206 - popup.scrollTop, 250, 21),
    );
    popup.scrollTop = 58;

    // When a later passive change reconciles layout, not model navigation.
    act(() => {
      if (fit) {
        clientHeight.mockReturnValue(30);
        triggerRect.mockReturnValue(new DOMRect(0, 84, 71, 19));
        resize();
      } else {
        renderCatalog([earlier, current]);
      }
    });

    // Then focused reasoning owns reconciliation; stale model intent cannot.
    expect(document.activeElement).toBe(high);
    expect(high.getBoundingClientRect().top).toBeGreaterThanOrEqual(48);
    expect(high.getBoundingClientRect().bottom).toBeLessThanOrEqual(48 + popup.clientHeight);
    expect(popup.scrollTop).toBe(fit ? 63 : 58);
    expect(container.scrollTop).toBe(0);
    expect(selected).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  });
});
