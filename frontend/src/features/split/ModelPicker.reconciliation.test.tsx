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

describe("ModelPicker fixed chrome reconciliation", () => {
  let container: HTMLDivElement;
  let root: Root;
  let resize: () => void;
  let anchorTop: number;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resize = callback; }
      observe(): void { /* Explicit delivery. */ }
      disconnect(): void { /* No async work. */ }
    });
    anchorTop = 500;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.matches(".th-model-picker")) return new DOMRect(0, anchorTop, 100, 24);
      if (this.matches(".th-chat-main")) return new DOMRect(0, 44, 1176, 656);
      return new DOMRect(0, 100, 260, 40);
    });
    container = document.createElement("div"); container.className = "th-chat-main";
    document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  });
  function setup(models: readonly ModelOption[]) {
    const selected = vi.fn(), changed = vi.fn();
    const renderCatalog = (values: readonly ModelOption[]): void => {
      root.render(<ModelPicker models={values} currentModelKey="long-provider/long-49"
        placeholder="Model" searchPlaceholder="Search" onSelect={selected}
        thinkingLevels={["off", "minimal", "low", "medium", "high"]}
        thinkingLevel="high" onThinkingChange={changed} />);
    };
    act(() => renderCatalog(models));
    act(() => required(container.querySelector<HTMLButtonElement>(".th-model-picker-btn")).click());
    const popup = required(document.querySelector<HTMLElement>(".th-model-picker-popover"));
    return { popup, renderCatalog, selected, changed };
  }
  it.each(["full", "empty"])("preserves focused reasoning when passive fit shrinks with a %s catalog", catalog => {
    const { popup, selected, changed } = setup(catalog === "empty" ? [] : [current, earlier]);
    const high = required(popup.querySelector<HTMLButtonElement>('.th-thinking-level[aria-pressed="true"]'));
    act(() => high.focus());
    act(() => { anchorTop = 89; resize(); });
    const panel = required(document.querySelector<HTMLElement>(".th-model-picker-popover--panel"));
    expect(document.activeElement).toBe(panel.querySelector('.th-thinking-level[aria-pressed="true"]'));
    expect(panel.scrollTop).toBe(0); expect(container.scrollTop).toBe(0);
    expect(selected).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
  });
  it.each([null, "ArrowUp", "ArrowDown"].flatMap(key => [false, true].map(fit => ({ key, fit }))))(
    "preserves reasoning after no-op navigation ($key, fit=$fit)", ({ key, fit }) => {
      const { popup, renderCatalog, selected, changed } = setup([current]);
      const option = required(popup.querySelector<HTMLButtonElement>('[role="option"]'));
      act(() => {
        if (key) popup.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
        else option.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
      });
      const high = required(popup.querySelector<HTMLButtonElement>('.th-thinking-level[aria-pressed="true"]'));
      act(() => high.focus());
      const list = required(popup.querySelector<HTMLElement>(".th-model-picker-list"));
      list.scrollTop = 58;
      act(() => {
        if (fit) { anchorTop = 89; resize(); }
        else renderCatalog([earlier, current]);
      });
      const next = required(document.querySelector<HTMLElement>(".th-model-picker-popover"));
      expect(document.activeElement).toBe(next.querySelector('.th-thinking-level[aria-pressed="true"]'));
      expect(next.scrollTop).toBe(0); expect(container.scrollTop).toBe(0);
      if (!fit) expect(list.scrollTop).toBe(58);
      expect(selected).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
    },
  );
  it("hydrates an empty catalog without moving reasoning focus or sending a control request", () => {
    const { popup, renderCatalog, selected, changed } = setup([]);
    const high = required(popup.querySelector<HTMLButtonElement>('.th-thinking-level[aria-pressed="true"]'));
    act(() => high.focus());
    act(() => renderCatalog([earlier, current]));
    expect(document.activeElement).toBe(high);
    expect(popup.querySelectorAll('[role="option"]')).toHaveLength(2);
    expect(popup.scrollTop).toBe(0);
    expect(selected).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
  });
});
