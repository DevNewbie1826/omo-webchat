import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n";
import type { ActivityState, ActivityTask } from "./activityTypes";
import { i18n, requireElement } from "./chatPaneTestHarness";
import { ActivityShelf } from "./ActivityShelf";

const PANEL_MIN = 120;
/** 60vh against the jsdom viewport — the same ceiling as the sized-panel CSS. */
const PANEL_MAX = Math.round(window.innerHeight * 0.6);
const STORAGE_KEY = "th-activity-panel-height";

const now = Date.now();
const iso = (msAgo: number): string => new Date(now - msAgo).toISOString();

function makeTask(): ActivityTask {
  return {
    taskId: "t1",
    name: "Spawned agent",
    status: "running",
    updatedAt: iso(5_000),
    liveProgress: { currentTool: "ripgrep", turns: 4 },
  };
}

function activityState(): ActivityState {
  const task = makeTask();
  return {
    tasks: new Map([[task.taskId, task]]),
    dags: new Map(),
    todo: null,
    heartbeats: new Map(),
  };
}

function emptyState(): ActivityState {
  return { tasks: new Map(), dags: new Map(), todo: null, heartbeats: new Map() };
}

let container: HTMLDivElement;
let root: Root;

const panelOf = (): HTMLElement =>
  requireElement(container.querySelector<HTMLElement>(".th-activity-panel"), "activity panel");
const handleOf = (): HTMLElement =>
  requireElement(container.querySelector<HTMLElement>(".th-activity-resize"), "resize handle");

/** jsdom layout is all-zero; fake the rendered panel height the drag maths reads. */
function mockPanelRect(height: number): void {
  vi.spyOn(panelOf(), "getBoundingClientRect").mockReturnValue({
    height,
    width: 600,
    top: 400,
    bottom: 400 + height,
    left: 0,
    right: 600,
    x: 0,
    y: 400,
    toJSON: () => ({}),
  } as DOMRect);
}

/** Controllable ResizeObserver fake: tests fire measured heights explicitly. */
class HeadroomResizeObserver {
  static instances: HeadroomResizeObserver[] = [];
  readonly observed: Element[] = [];
  disconnected = false;

  constructor(private readonly callback: ResizeObserverCallback) {
    HeadroomResizeObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.observed.push(target);
  }

  unobserve(): void {}

  disconnect(): void {
    this.disconnected = true;
  }

  fire(height: number): void {
    act(() => {
      this.callback(
        this.observed.map((target) => ({
          target,
          contentRect: { height, width: 600, x: 0, y: 0, top: 0, left: 0, bottom: height, right: 600, toJSON: () => ({}) },
        }) as unknown as ResizeObserverEntry),
        this as unknown as ResizeObserver,
      );
    });
  }
}

function pointerDown(clientY: number): void {
  act(() => {
    handleOf().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientY }));
  });
}

function pointerMove(clientY: number): void {
  act(() => {
    document.dispatchEvent(new PointerEvent("pointermove", { clientY }));
  });
}

function pointerUp(): void {
  act(() => {
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  });
}

function keyDown(key: string): void {
  act(() => {
    handleOf().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

describe("ActivityShelf resize", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    window.localStorage.removeItem(STORAGE_KEY);
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

  function renderShelfWith(activities: ActivityState): void {
    act(() => {
      root.render(
        <I18nContext.Provider value={i18n}>
          <ActivityShelf activities={activities} />
        </I18nContext.Provider>,
      );
    });
  }

  function renderShelf(): void {
    renderShelfWith(activityState());
  }

  function openShelf(): void {
    const bar = requireElement(
      container.querySelector<HTMLButtonElement>(".th-activity-bar"),
      "collapsed summary bar",
    );
    act(() => {
      bar.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
  }

  it("renders an accessible separator handle for the expanded shelf", () => {
    renderShelf();
    openShelf();
    const handle = handleOf();
    expect(handle.getAttribute("role")).toBe("separator");
    expect(handle.getAttribute("aria-orientation")).toBe("horizontal");
    expect(handle.getAttribute("aria-label")).toBe("activity.resize");
    expect(handle.getAttribute("aria-valuemin")).toBe(String(PANEL_MIN));
    expect(handle.getAttribute("aria-valuemax")).toBe(String(PANEL_MAX));
    expect(handle.tabIndex).toBe(0);
    expect(panelOf().contains(handle)).toBe(false);
  });

  it("renders the handle as a standalone grip between the summary bar and the panel", () => {
    renderShelf();
    openShelf();
    const handle = handleOf();
    expect(panelOf().contains(handle)).toBe(false);
    const barRow = requireElement(
      container.querySelector<HTMLElement>(".th-activity-bar-row"),
      "summary bar row",
    );
    expect(handle.previousElementSibling).toBe(barRow);
    expect(handle.nextElementSibling).toBe(panelOf());
    // The grip sits in normal flow, not absolutely positioned over the panel.
    const css = readFileSync("src/styles/activity-shelf.css", "utf8");
    const rule = css.match(/\.th-activity-resize\s*\{[^}]*\}/)?.[0] ?? "";
    expect(rule).not.toBe("");
    expect(rule).not.toMatch(/position:\s*absolute/);
  });

  it("resizes by pointer drag, clamped to [120px, 60vh], and persists the height", () => {
    renderShelf();
    openShelf();
    mockPanelRect(240);
    pointerDown(500);
    pointerMove(300);
    expect(panelOf().style.height).toBe("440px");
    pointerMove(-5000);
    expect(panelOf().style.height).toBe(`${PANEL_MAX}px`);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(String(PANEL_MAX));
    pointerMove(5000);
    expect(panelOf().style.height).toBe("120px");
    pointerUp();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("120");
  });

  it("resizes by keyboard: ArrowUp/Down step 24px, Home/End jump to the bounds", () => {
    renderShelf();
    openShelf();
    mockPanelRect(240);
    keyDown("ArrowUp");
    expect(panelOf().style.height).toBe("264px");
    expect(handleOf().getAttribute("aria-valuenow")).toBe("264");
    keyDown("ArrowDown");
    expect(panelOf().style.height).toBe("240px");
    keyDown("End");
    expect(panelOf().style.height).toBe(`${PANEL_MAX}px`);
    expect(handleOf().getAttribute("aria-valuenow")).toBe(String(PANEL_MAX));
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(String(PANEL_MAX));
    keyDown("Home");
    expect(panelOf().style.height).toBe("120px");
    keyDown("ArrowDown");
    expect(panelOf().style.height).toBe("120px");
  });

  it("resets to the default content-sized height on double-click and clears storage", () => {
    renderShelf();
    openShelf();
    mockPanelRect(240);
    pointerDown(500);
    pointerMove(400);
    pointerUp();
    expect(panelOf().style.height).toBe("340px");
    act(() => {
      handleOf().dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    });
    expect(panelOf().style.height).toBe("");
    expect(panelOf().className).not.toContain("th-activity-panel--sized");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("restores a persisted height on a fresh render", () => {
    window.localStorage.setItem(STORAGE_KEY, "400");
    renderShelf();
    openShelf();
    expect(panelOf().style.height).toBe("400px");
    expect(panelOf().className).toContain("th-activity-panel--sized");
  });

  it("uses default sizing when storage reads throw", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    try {
      expect(() => renderShelf()).not.toThrow();
      openShelf();
      expect(panelOf().style.height).toBe("");
    } finally {
      getItem.mockRestore();
    }
  });

  it("keeps a resized non-persistent height when storage writes throw", () => {
    renderShelf();
    openShelf();
    mockPanelRect(240);
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    try {
      expect(() => keyDown("ArrowUp")).not.toThrow();
      expect(panelOf().style.height).toBe("264px");
    } finally {
      setItem.mockRestore();
    }
  });

  it("clamps an out-of-range persisted height on restore", () => {
    window.localStorage.setItem(STORAGE_KEY, "99999");
    renderShelf();
    openShelf();
    expect(panelOf().style.height).toBe(`${PANEL_MAX}px`);
  });

  it("ignores a garbage persisted value and keeps the default sizing", () => {
    window.localStorage.setItem(STORAGE_KEY, "garbage");
    renderShelf();
    openShelf();
    expect(panelOf().style.height).toBe("");
  });

  it("keeps the drag handle available on narrow panes (mobile can resize too)", () => {
    // jsdom cannot evaluate container queries, so pin the contract in the
    // stylesheet the same way styleContracts.test.ts does.
    const css = readFileSync("src/styles/activity-shelf.css", "utf8");
    const narrow = css.match(/@container chat-pane \(max-width: 494px\) \{([\s\S]+)\}\s*$/)?.[1] ?? "";
    expect(narrow).not.toMatch(/\.th-activity-resize\s*\{[^}]*display:\s*none/);
  });

  describe("measured panel headroom", () => {
    beforeEach(() => {
      HeadroomResizeObserver.instances = [];
      vi.stubGlobal("ResizeObserver", HeadroomResizeObserver);
    });

    it("toggles data-headless from the measured panel height (18px hides headers, 120px restores them)", () => {
      renderShelf();
      openShelf();
      const panel = panelOf();
      expect(panel.hasAttribute("data-headless")).toBe(false);
      const [observer] = HeadroomResizeObserver.instances;
      expect(observer).toBeDefined();
      expect(observer?.observed).toEqual([panel]);
      observer?.fire(18);
      expect(panel.getAttribute("data-headless")).toBe("true");
      observer?.fire(120);
      expect(panel.hasAttribute("data-headless")).toBe(false);
    });

    it("disconnects the observer, clears the flag on close, and starts fresh on reopen", () => {
      renderShelf();
      openShelf();
      const panel = panelOf();
      const [observer] = HeadroomResizeObserver.instances;
      observer?.fire(18);
      expect(panel.getAttribute("data-headless")).toBe("true");
      const bar = requireElement(
        container.querySelector<HTMLButtonElement>(".th-activity-bar"),
        "collapsed summary bar",
      );
      act(() => {
        bar.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      expect(observer?.disconnected).toBe(true);
      expect(container.querySelector(".th-activity-panel")).toBeNull();
      act(() => {
        bar.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      expect(HeadroomResizeObserver.instances.length).toBe(2);
      expect(panelOf().hasAttribute("data-headless")).toBe(false);
    });

    it("re-observes the replacement panel when an open shelf empties and repopulates", () => {
      renderShelf();
      openShelf();
      const firstPanel = panelOf();
      const [firstObserver] = HeadroomResizeObserver.instances;
      firstObserver?.fire(18);
      expect(firstPanel.getAttribute("data-headless")).toBe("true");

      // Activity empties while the shelf stays open: the component returns
      // null without unmounting, so the observer must be torn down with the
      // panel instead of lingering attached to the detached element.
      renderShelfWith(emptyState());
      expect(container.querySelector(".th-activity-shelf")).toBeNull();
      expect(firstObserver?.disconnected).toBe(true);

      // Activity returns: the replacement panel is a NEW element and must be
      // observed by a NEW observer, with headless reset instead of inherited.
      renderShelfWith(activityState());
      expect(HeadroomResizeObserver.instances.length).toBe(2);
      const secondPanel = panelOf();
      expect(secondPanel).not.toBe(firstPanel);
      const [, secondObserver] = HeadroomResizeObserver.instances;
      expect(secondObserver?.observed).toEqual([secondPanel]);
      expect(secondPanel.hasAttribute("data-headless")).toBe(false);
      secondObserver?.fire(54);
      expect(secondPanel.hasAttribute("data-headless")).toBe(false);
      secondObserver?.fire(18);
      expect(secondPanel.getAttribute("data-headless")).toBe("true");
    });
  });
});
