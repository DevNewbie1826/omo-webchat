import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext, translate } from "../../i18n";
import { SplitView } from "./SplitView";
import { setRatio, type PaneNode, type SplitDir } from "./paneTree";

vi.mock("../../lib/chatWs", () => ({ connectChat: vi.fn(handlers => {
  handlers.onOpen?.(); return { send: vi.fn(), close: vi.fn() };
}) }));
const leaf = (id: string, sessionId: string | null = null): PaneNode => ({ kind: "leaf", id, sessionId });
const split = (id: string, dir: SplitDir, first: PaneNode, second: PaneNode): PaneNode => ({ kind: "split", id, dir, ratio: .5, first, second });
const layouts = {
  h3: split("root", "h", split("inner", "h", leaf("a", "chat"), leaf("b")), leaf("c")),
  h4: split("root", "h", split("inner", "h", leaf("a", "chat"), leaf("b")), split("other", "h", leaf("c"), leaf("d"))),
  v3: split("root", "v", split("inner", "v", leaf("a", "chat"), leaf("b")), leaf("c")),
  v4: split("root", "v", split("inner", "v", leaf("a", "chat"), leaf("b")), split("other", "v", leaf("c"), leaf("d"))),
  mixed: split("root", "h", split("inner", "v", leaf("a", "chat"), leaf("b")), leaf("c")),
};
const session = { id: "chat", wsId: "ws", name: "Chat", cwd: "/fixture", provider: "omo" as const };

// A deterministic layout oracle: computes browser flex geometry from rendered
// flexGrow, not pane-tree ratios. ResizeObserver deliveries occur only on a
// measured size change, with no timers, frame waits or polling delays.
function box(element: Element): DOMRect {
  const parent = element.parentElement;
  if (!parent || element.classList.contains("fixture")) return new DOMRect(264, 0, 1800, 1600);
  const rect = box(parent);
  if (element.classList.contains("th-split-child")) {
    const children = [...parent.children].filter(e => e instanceof HTMLElement && e.classList.contains("th-split-child"));
    const first = children[0], second = children[1];
    if (!(first instanceof HTMLElement) || !(second instanceof HTMLElement)) throw new Error("Missing split children");
    const ratio = Number(first.style.flexGrow) / (Number(first.style.flexGrow) + Number(second.style.flexGrow));
    const horizontal = parent.classList.contains("th-split--h"), isFirst = element === first;
    const size = (horizontal ? rect.width : rect.height) - 4;
    return new DOMRect(rect.x + (horizontal && !isFirst ? size * ratio + 4 : 0), rect.y + (!horizontal && !isFirst ? size * ratio + 4 : 0),
      horizontal ? size * (isFirst ? ratio : 1 - ratio) : rect.width, horizontal ? rect.height : size * (isFirst ? ratio : 1 - ratio));
  }
  return rect;
}

describe("global pane resize interaction", () => {
  let container: HTMLDivElement, root: Root;
  let ratioChanges: ReturnType<typeof vi.fn<(id: string, ratio: number) => void>>;
  const observers = new Set<ResizeObserverFixture>();
  class ResizeObserverFixture {
    readonly targets = new Map<Element, string>();
    constructor(readonly callback: ResizeObserverCallback) { observers.add(this); }
    observe(target: Element) { this.targets.set(target, ""); }
    unobserve(target: Element) { this.targets.delete(target); }
    disconnect() { observers.delete(this); this.targets.clear(); }
    deliver() {
      const entries: ResizeObserverEntry[] = [];
      for (const [target, previous] of this.targets) {
        const rect = target.getBoundingClientRect(), size = `${rect.width}:${rect.height}`;
        if (size === previous) continue;
        this.targets.set(target, size);
        entries.push({ target, contentRect: rect, borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] });
      }
      // Callback receiver is not consumed by these components.
      if (entries.length) this.callback(entries, this);
      return entries.length;
    }
  }
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("ResizeObserver", ResizeObserverFixture);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) { return box(this); });
    vi.stubGlobal("PointerEvent", MouseEvent);
    Object.defineProperties(HTMLElement.prototype, {
      setPointerCapture: { configurable: true, value() {} },
      hasPointerCapture: { configurable: true, value() { return false; } },
      releasePointerCapture: { configurable: true, value() {} },
    });
    container = document.createElement("div"); container.className = "fixture"; document.body.append(container); root = createRoot(container);
    ratioChanges = vi.fn();
  });
  afterEach(() => {
    try {
      act(() => root.unmount());
      // Virtualization unobserves targets without disconnecting its empty
      // observer. An allocated fixture object is not a live subscription.
      expect([...observers].reduce((sum, observer) => sum + observer.targets.size, 0)).toBe(0);
    } finally {
      for (const observer of observers) observer.disconnect();
      observers.clear(); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
      for (const key of ["setPointerCapture", "hasPointerCapture", "releasePointerCapture"] as const) Reflect.deleteProperty(HTMLElement.prototype, key);
    }
  });
  function deliverGeometry() {
    for (let depth = 0; depth < 10; depth++) {
      let deliveries = 0;
      act(() => { for (const observer of observers) deliveries += observer.deliver(); });
      if (!deliveries) return;
    }
    throw new Error("ResizeObserver geometry failed to settle");
  }
  function Harness({ initial }: { readonly initial: PaneNode }) {
    const [node, setNode] = useState(initial), [focused, setFocused] = useState("a");
    return <SplitView node={node} focusedPaneId={focused} splitEnabled workspaces={[]} placed={new Set(["chat"])}
      sessions={new Map([["chat", session]])} sessionLists={new Map()} sessionPages={new Map()} onEnsureSessions={() => undefined}
      actions={{ onFocusPane: setFocused, onOpenSession: async () => "opened", onLoadMoreSessions: async () => undefined,
        onCreateTerminal() {}, onSplit() {}, onClosePane() {}, onOpenSidebar() {}, notify() {},
        onRatioChange(id, ratio) { ratioChanges(id, ratio); setNode(current => setRatio(current, id, ratio)); } }} />;
  }
  function render(node: PaneNode) { act(() => root.render(<I18nContext.Provider value={{ lang: "en", setLang() {}, font: "system", setFont() {}, fontSize: 13, setFontSize() {}, t: (key, vars) => translate("en", key, vars) }}><Harness initial={node} /></I18nContext.Provider>)); deliverGeometry(); }
  function element(selector: string) {
    const result = container.querySelector<HTMLElement>(selector);
    if (!result) throw new Error(`Missing ${selector}`);
    return result;
  }
  function key(target: HTMLElement, key: string) { act(() => target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))); deliverGeometry(); }
  function overlaysMatchGeometry(count: number) {
    const panes = [...container.querySelectorAll<HTMLElement>(".th-pane-wrap")];
    expect(panes).toHaveLength(count);
    const area = element(".th-session-workarea").getBoundingClientRect();
    for (const pane of panes) {
      const overlay = pane.querySelector<HTMLElement>(".th-pane-size");
      const rect = pane.getBoundingClientRect();
      expect(overlay).not.toBeNull();
      const visiblePercentages = [...(overlay?.textContent ?? "").matchAll(/(\d+)%/g)].map(match => Number(match[1]));
      expect(visiblePercentages).toEqual([Math.round(rect.width / area.width * 100), Math.round(rect.height / area.height * 100)]);
      expect(overlay?.dataset["widthPercent"]).toBe(String(Math.round(rect.width / area.width * 100)));
      expect(overlay?.dataset["heightPercent"]).toBe(String(Math.round(rect.height / area.height * 100)));
      expect(rect.left).toBeGreaterThanOrEqual(area.left); expect(rect.right).toBeLessThanOrEqual(area.right + .001);
      expect(rect.top).toBeGreaterThanOrEqual(area.top); expect(rect.bottom).toBeLessThanOrEqual(area.bottom + .001);
      expect(rect.width).toBeGreaterThanOrEqual(320 - 1e-9); expect(rect.height).toBeGreaterThanOrEqual(320 - 1e-9);
    }
  }
  it.each(Object.entries(layouts))("measures every occupied and empty leaf against the whole area at %s bounds", (name, node) => {
    render(node);
    const divider = element(".th-divider");
    act(() => divider.focus()); deliverGeometry();
    const count = name.endsWith("4") ? 4 : 3;
    overlaysMatchGeometry(count);
    key(divider, name.startsWith("v") ? "ArrowDown" : "ArrowRight"); overlaysMatchGeometry(count);
    key(divider, "Home"); overlaysMatchGeometry(count);
    key(divider, "End"); overlaysMatchGeometry(count);
    expect(container.querySelectorAll(".th-pane--focused")).toHaveLength(1);
  });
  it.each(["h", "v"] as const)("only handles %s-axis arrows in five point steps", dir => {
    render(split("root", dir, leaf("a", "chat"), leaf("b")));
    const divider = element(".th-divider");
    key(divider, dir === "h" ? "ArrowDown" : "ArrowRight"); expect(ratioChanges).not.toHaveBeenCalled();
    key(divider, dir === "h" ? "ArrowRight" : "ArrowDown"); expect(ratioChanges).toHaveBeenLastCalledWith("root", .55);
    key(divider, dir === "h" ? "ArrowLeft" : "ArrowUp"); expect(ratioChanges).toHaveBeenLastCalledWith("root", .5);
    expect(divider.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(divider.getAttribute("aria-describedby") ?? "")).not.toBeNull();
  });
  it("focuses on pointer down, retains all overlays until both drag and focus end, and Escape keeps the ratio", () => {
    render(layouts.h3);
    const divider = element(".th-divider"), origin = element('[data-pane-id="c"] .th-pane-resize');
    act(() => origin.focus());
    act(() => divider.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true })));
    deliverGeometry(); expect(document.activeElement).toBe(divider); overlaysMatchGeometry(3);
    act(() => divider.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 1600, clientY: 500 })));
    deliverGeometry(); overlaysMatchGeometry(3);
    const adjusted = ratioChanges.mock.lastCall?.[1];
    act(() => origin.focus()); deliverGeometry(); overlaysMatchGeometry(3);
    act(() => divider.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })));
    expect(container.querySelectorAll(".th-pane-size")).toHaveLength(0);
    act(() => divider.focus()); deliverGeometry(); overlaysMatchGeometry(3);
    key(divider, "Escape");
    expect(document.activeElement).toBe(origin);
    expect(ratioChanges.mock.lastCall?.[1]).toBe(adjusted);
    expect(container.querySelectorAll(".th-pane-size")).toHaveLength(0);
  });
  it("offers ancestor boundaries from the header before transcript tab stops and restores the invoking control", () => {
    render(layouts.mixed);
    const origin = element('[data-pane-id="a"] .th-pane-resize');
    expect(origin.closest(".th-termhead")).not.toBeNull();
    act(() => { origin.focus(); origin.click(); });
    const outer = element('.th-pane-resize-menu [data-split-target="root"]');
    act(() => outer.click()); deliverGeometry();
    const divider = element('[data-split-id="root"] > .th-divider');
    expect(document.activeElement).toBe(divider); overlaysMatchGeometry(3);
    key(divider, "ArrowRight"); expect(ratioChanges).toHaveBeenLastCalledWith("root", .55);
    key(divider, "Escape"); expect(document.activeElement).toBe(origin);
    expect(container.querySelectorAll(".th-pane-size")).toHaveLength(0);
  });
});
