import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n";
import type { ActivityState, ActivityTask } from "./activityTypes";
import { i18n, requireElement } from "./chatPaneTestHarness";
import { ActivityShelf } from "./ActivityShelf";

const PANEL_MIN = 120;
/** 70dvh against the jsdom viewport — same budget the CSS clamp uses. */
const PANEL_MAX = Math.round(window.innerHeight * 0.7);
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

  function renderShelf(): void {
    act(() => {
      root.render(
        <I18nContext.Provider value={i18n}>
          <ActivityShelf activities={activityState()} />
        </I18nContext.Provider>,
      );
    });
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

  it("resizes by pointer drag, clamped to [120px, 70dvh], and persists the height", () => {
    renderShelf();
    openShelf();
    mockPanelRect(240);
    pointerDown(500);
    pointerMove(300);
    expect(panelOf().style.height).toBe("440px");
    pointerMove(-5000);
    expect(panelOf().style.height).toBe(`${PANEL_MAX}px`);
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
});
