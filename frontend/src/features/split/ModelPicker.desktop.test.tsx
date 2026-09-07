import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelPicker } from "./ModelPicker";

const catalog = [
  { provider: "provider-a", modelId: "model-a", name: "Model A" },
  { provider: "provider-b", modelId: "model-b", name: "Model B" },
  { provider: "provider-c", modelId: "model-b", name: "Model B" },
  ...Array.from({ length: 50 }, (_, i) => ({ provider: "long-provider", modelId: `long-${i}`, name: `Long model ${i}` })),
];
const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
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
  let anchorTop: number;
  const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    if (!originalScrollIntoView) Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value() {} });
    vi.stubGlobal("innerHeight", 900);
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resize = callback; }
      observe(): void { /* Explicit geometry delivery. */ }
      disconnect(): void { /* No async work. */ }
    });
    anchorTop = 817;
    // jsdom has no layout. These are natural fixed chrome/row measurements,
    // not scroll mocks; actual Chrome validates all geometry in the SPA runner.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.matches(".th-chat-main")) return new DOMRect(0, 44, 1176, 856);
      if (this.matches(".th-model-picker")) return new DOMRect(0, anchorTop, 100, 24);
      if (this.matches(".th-model-picker-current,.th-model-picker-search,[role=option]")) return new DOMRect(0, 0, 260, 40);
      if (this.matches(".th-thinking-in-picker")) return new DOMRect(0, 0, 260, 72);
      return new DOMRect(0, 0, 260, 280);
    });
    container = document.createElement("div"); container.className = "th-chat-main";
    document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
    if (originalScrollIntoView) Object.defineProperty(Element.prototype, "scrollIntoView", originalScrollIntoView);
    else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  });
  function render() {
    const selected = vi.fn(), changed = vi.fn();
    act(() => root.render(<ModelPicker models={catalog} currentModelKey="provider-a/model-a"
      placeholder="Model" searchPlaceholder="Search" onSelect={selected}
      thinkingLevels={levels} thinkingLabel="Thinking" thinkingLevel="low" onThinkingChange={changed} />));
    const trigger = required(container.querySelector<HTMLButtonElement>(".th-model-picker-btn"));
    act(() => trigger.click());
    return { trigger, selected, changed, popup: required(document.querySelector<HTMLElement>(".th-model-picker-popover")) };
  }
  it.each([769, 166, 99, 91, 41, 0])("uses a fixed desktop panel when %spx cannot fit chrome plus one option", available => {
    anchorTop = available + 48;
    const { popup, trigger } = render();
    expect(popup.classList.contains("th-model-picker-popover--panel")).toBe(available < 202);
    expect(popup.parentElement).toBe(available < 202 ? document.body : trigger.parentElement);
    expect(popup.style.maxHeight).toBe(available < 202 ? "" : "280px");
    expect(popup.querySelectorAll('[role="option"]')).toHaveLength(53);
  });
  it("moves to a panel on local resize, preserving query, navigation and focused thinking", () => {
    const { popup, selected, changed } = render();
    const search = required(popup.querySelector<HTMLInputElement>("input"));
    act(() => {
      search.focus();
      required(Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set).call(search, "long-provider");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => key("ArrowUp"));
    const active = search.getAttribute("aria-activedescendant");
    const high = required(popup.querySelector<HTMLButtonElement>(".th-thinking-level:nth-child(5)"));
    act(() => high.focus());
    act(() => { anchorTop = 89; resize(); });
    const panel = required(document.querySelector<HTMLElement>(".th-model-picker-popover--panel"));
    expect(panel.parentElement).toBe(document.body);
    expect(panel.querySelector("input")?.value).toBe("long-provider");
    expect(panel.querySelectorAll('[role="option"]')).toHaveLength(50);
    expect(panel.querySelector("input")?.getAttribute("aria-activedescendant")).toBe(active);
    expect(document.activeElement?.textContent).toBe("high");
    expect(selected).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
  });
  it("uses a fixed native thinking select in a short viewport and traps focus without including all model options", () => {
    vi.stubGlobal("innerHeight", 150); anchorTop = 89;
    const { popup, changed, trigger } = render();
    expect(popup.classList.contains("th-model-picker-popover--dense")).toBe(true);
    const select = required(popup.querySelector<HTMLSelectElement>("select"));
    expect([...select.options].map(option => option.value)).toEqual(levels);
    act(() => { select.value = "max"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(changed).toHaveBeenCalledExactlyOnceWith("max");
    const close = required(popup.querySelector<HTMLButtonElement>(".th-btn-icon"));
    act(() => { popup.focus(); key("Tab"); }); expect(document.activeElement).toBe(close);
    act(() => key("Tab")); expect(document.activeElement).toBe(select);
    act(() => key("Tab")); expect(document.activeElement).toBe(popup.querySelector("input"));
    act(() => key("Tab")); expect(document.activeElement).toBe(close);
    act(() => key("Escape")); expect(document.querySelector(".th-model-picker-popover")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
  it("scrolls only the desktop list to reveal the active option, never chrome or a hidden ancestor", () => {
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
    const { popup } = render();
    const list = required(popup.querySelector<HTMLElement>(".th-model-picker-list"));
    const options = popup.querySelectorAll<HTMLElement>('[role="option"]');
    Object.defineProperty(list, "getBoundingClientRect", { configurable: true, value: () => new DOMRect(0, 100, 260, 120) });
    vi.spyOn(list, "clientHeight", "get").mockReturnValue(118);
    vi.spyOn(list, "clientTop", "get").mockReturnValue(1);
    list.scrollTop = 0;
    Object.defineProperty(required(options[1]), "getBoundingClientRect", { configurable: true, value: () => new DOMRect(0, 300, 250, 50) });
    act(() => key("ArrowDown"));
    expect(list.scrollTop).toBe(131); expect(popup.scrollTop).toBe(0); expect(container.scrollTop).toBe(0);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
  it("keeps hovered final model visible while reasoning retains keyboard focus", () => {
    const { popup, selected, changed } = render();
    const high = required(popup.querySelector<HTMLButtonElement>(".th-thinking-level:nth-child(5)"));
    const last = required(popup.querySelector<HTMLButtonElement>('[role="option"]:last-child'));
    const list = required(popup.querySelector<HTMLElement>(".th-model-picker-list"));
    Object.defineProperty(list, "getBoundingClientRect", { configurable: true, value: () => new DOMRect(0, 100, 260, 100) });
    vi.spyOn(list, "clientHeight", "get").mockReturnValue(100);
    Object.defineProperty(last, "getBoundingClientRect", { configurable: true, value: () => new DOMRect(0, 150, 250, 40) });
    list.scrollTop = 1576;
    act(() => { high.focus(); last.dispatchEvent(new MouseEvent("mousemove", { bubbles: true })); });
    expect(popup.querySelector("input")?.getAttribute("aria-activedescendant")).toBe(last.id);
    expect(list.scrollTop).toBe(1576); expect(popup.scrollTop).toBe(0);
    expect(document.activeElement).toBe(high); expect(selected).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
  });
  it("opens with non-text focus, follows reasoning/search Tab order in both directions, then exits", () => {
    const { popup, trigger } = render();
    const search = required(popup.querySelector<HTMLInputElement>("input"));
    const chips = [...popup.querySelectorAll<HTMLButtonElement>(".th-thinking-level")];
    expect(document.activeElement).toBe(popup);
    for (const control of [...chips, search]) { act(() => key("Tab")); expect(document.activeElement).toBe(control); }
    for (const control of [...chips].reverse()) { act(() => key("Tab", true)); expect(document.activeElement).toBe(control); }
    for (const control of [...chips.slice(1), search]) { act(() => key("Tab")); expect(document.activeElement).toBe(control); }
    let exit: KeyboardEvent | undefined; act(() => { exit = key("Tab"); });
    expect(exit?.defaultPrevented).toBe(false); expect(document.querySelector(".th-model-picker-popover")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
