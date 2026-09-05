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

  unobserve(target: Element): void {
    const index = this.observed.indexOf(target);
    if (index >= 0) this.observed.splice(index, 1);
  }

  disconnect(): void {
    this.disconnected = true;
  }

  fire(height: number): void {
    if (this.disconnected) return;
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

  /** Fire the callback with a measured height for ONE observed target only. */
  fireAt(target: Element, height: number): void {
    if (this.disconnected) return;
    const entries = this.observed
      .filter((observed) => observed === target)
      .map((observed) => ({
        target: observed,
        contentRect: { height, width: 600, x: 0, y: 0, top: 0, left: 0, bottom: height, right: 600, toJSON: () => ({}) },
      }) as unknown as ResizeObserverEntry);
    if (entries.length === 0) return;
    act(() => {
      this.callback(entries, this as unknown as ResizeObserver);
    });
  }
}

class ShelfMutationObserver {
  static instances: ShelfMutationObserver[] = [];
  disconnected = false;

  constructor(private readonly callback: MutationCallback) {
    ShelfMutationObserver.instances.push(this);
  }

  observe(): void {}
  takeRecords(): MutationRecord[] { return []; }

  disconnect(): void {
    this.disconnected = true;
  }

  fire(): void {
    act(() => {
      this.callback([], this as unknown as MutationObserver);
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

  describe("column clamp", () => {
    beforeEach(() => {
      HeadroomResizeObserver.instances = [];
      ShelfMutationObserver.instances = [];
      vi.stubGlobal("ResizeObserver", HeadroomResizeObserver);
      vi.stubGlobal("MutationObserver", ShelfMutationObserver);
    });

    /** jsdom rects are all-zero; fake one measured element height. */
    function mockRect(el: Element, height: number, top = 0): void {
      vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
        height,
        width: 600,
        top,
        bottom: top + height,
        left: 0,
        right: 600,
        x: 0,
        y: top,
        toJSON: () => ({}),
      } as DOMRect);
    }

    /** Render the shelf inside a chat column with the fixed-band siblings
     *  the clamp measures (composer, status strip, and the goal shelf's
     *  summary bar). Returns the mounted column and the siblings. */
    function mountInColumn(): { column: HTMLElement; composer: HTMLElement; status: HTMLElement; goalBarRow: HTMLElement } {
      const column = document.createElement("div");
      column.className = "th-chat-main";
      const composer = document.createElement("div");
      composer.className = "th-chat-input";
      const status = document.createElement("div");
      status.className = "th-chat-status";
      const goalBarRow = document.createElement("div");
      goalBarRow.className = "th-activity-bar-row";
      const mount = document.createElement("div");
      column.append(goalBarRow, mount, status, composer);
      container.appendChild(column);
      root = createRoot(mount);
      return { column, composer, status, goalBarRow };
    }

    function fixtureRects({ column, composer, status, goalBarRow }: ReturnType<typeof mountInColumn>): void {
      mockRect(column, 800);
      mockRect(composer, 120);
      mockRect(status, 24);
      mockRect(goalBarRow, 30);
      const activityBarRow = container.querySelector(".th-activity-shelf .th-activity-bar-row");
      if (!activityBarRow) throw new Error("missing activity summary bar");
      mockRect(activityBarRow, 30);
    }

    it("clamps the expanded panel to the column's real available space and stops the shelf yielding", () => {
      const fixture = mountInColumn();
      window.localStorage.setItem(STORAGE_KEY, "450");
      renderShelf();
      openShelf();
      const panel = panelOf();
      fixtureRects(fixture);
      const observer = HeadroomResizeObserver.instances.at(-1);
      expect(observer?.observed).toContain(panel);
      expect(observer?.observed).toContain(fixture.column);
      expect(observer?.observed).toContain(fixture.composer);
      expect(observer?.observed).toContain(fixture.status);
      expect(observer?.observed).toContain(handleOf());
      // Unmeasured so far: no inline clamp, CSS caps only.
      expect(panel.style.maxHeight).toBe("");
      // 800 − 120 composer − 24 status − 30 goal bar − 30 activity bar − 120
      // transcript reserve = 476; min(476, 60vh = 461) keeps the CSS cap.
      mockRect(fixture.column, 800);
      observer?.fireAt(fixture.column, 800);
      expect(panel.style.maxHeight).toBe(`${PANEL_MAX}px`);
      // Column shrinks to 500: 500 − 204 − 120 = 176 binds below the 450 height.
      mockRect(fixture.column, 500);
      observer?.fireAt(fixture.column, 500);
      expect(panel.style.maxHeight).toBe("176px");
      // While the clamp is active the shelf must not participate in flex
      // shrinking — the transcript alone absorbs the deficit.
      const shelf = container.querySelector<HTMLElement>(".th-activity-shelf");
      if (!shelf) throw new Error("missing activity shelf");
      expect(shelf.style.flexShrink).toBe("0");
    });

    it("recomputes when a sibling panel appears and disappears without a column resize", () => {
      const fixture = mountInColumn();
      window.localStorage.setItem(STORAGE_KEY, "450");
      renderShelf();
      openShelf();
      const panel = panelOf();
      fixtureRects(fixture);
      const observer = HeadroomResizeObserver.instances.at(-1);
      observer?.fireAt(fixture.column, 800);
      expect(panel.style.maxHeight).toBe(`${PANEL_MAX}px`);

      const siblingShelf = document.createElement("section");
      siblingShelf.className = "th-goal-shelf";
      const siblingBar = document.createElement("div");
      siblingBar.className = "th-activity-bar-row";
      const goalPanel = document.createElement("div");
      goalPanel.className = "th-goal-panel";
      siblingShelf.append(siblingBar, goalPanel);
      fixture.column.appendChild(siblingShelf);
      mockRect(siblingShelf, 0);
      mockRect(siblingBar, 30);
      mockRect(goalPanel, 100);
      ShelfMutationObserver.instances.at(-1)?.fire();
      expect(observer?.observed).toContain(siblingBar);
      expect(observer?.observed).toContain(goalPanel);
      expect(panel.style.maxHeight).toBe("346px");

      siblingShelf.remove();
      ShelfMutationObserver.instances.at(-1)?.fire();
      expect(panel.style.maxHeight).toBe(`${PANEL_MAX}px`);
    });

    it("recomputes when the composer grows while the column box stays fixed", () => {
      const fixture = mountInColumn();
      window.localStorage.setItem(STORAGE_KEY, "450");
      renderShelf();
      openShelf();
      fixtureRects(fixture);
      const observer = HeadroomResizeObserver.instances.at(-1);
      observer?.fireAt(fixture.column, 800);
      expect(panelOf().style.maxHeight).toBe(`${PANEL_MAX}px`);

      mockRect(fixture.composer, 240);
      observer?.fireAt(fixture.composer, 240);
      expect(panelOf().style.maxHeight).toBe("356px");
    });

    it("observes and subtracts the activity grip and all in-flow shelf spacing", () => {
      const fixture = mountInColumn();
      window.localStorage.setItem(STORAGE_KEY, "450");
      renderShelf();
      openShelf();
      fixtureRects(fixture);
      const grip = handleOf();
      mockRect(grip, 10);
      grip.style.marginTop = "2px";
      const shelf = requireElement(container.querySelector<HTMLElement>(".th-activity-shelf"), "activity shelf");
      shelf.style.marginTop = "8px";
      const panel = panelOf();
      panel.style.marginTop = "4px";
      const observer = HeadroomResizeObserver.instances.at(-1);
      expect(observer?.observed).toContain(grip);
      observer?.fireAt(fixture.column, 800);
      expect(panel.style.maxHeight).toBe("452px");
    });

    it("keeps a short-transcript panel naturally sized while preserving the transcript and composer bands", () => {
      const fixture = mountInColumn();
      const transcript = document.createElement("div");
      transcript.className = "th-chat-transcript";
      fixture.column.prepend(transcript);
      renderShelf();
      openShelf();
      fixtureRects(fixture);
      mockRect(transcript, 300);
      mockRect(panelOf(), 72, 330);
      mockRect(fixture.composer, 120, 680);
      const observer = HeadroomResizeObserver.instances.at(-1);
      observer?.fireAt(fixture.column, 800);

      expect(panelOf().style.height).toBe("");
      expect(panelOf().style.maxHeight).toBe("280px");
      expect(transcript.getBoundingClientRect().height).toBeGreaterThanOrEqual(120);
      expect(fixture.column.lastElementChild).toBe(fixture.composer);
      expect(fixture.composer.getBoundingClientRect().top).toBe(680);
      expect(fixture.composer.getBoundingClientRect().bottom).toBe(fixture.column.getBoundingClientRect().bottom);
      expect(fixture.column.getBoundingClientRect().height
        - transcript.getBoundingClientRect().height
        - panelOf().getBoundingClientRect().height
        - fixture.composer.getBoundingClientRect().height).toBeGreaterThanOrEqual(120);
    });

    it("does not latch a naturally sized panel into headless when ample space provides a 48px floor", () => {
      const fixture = mountInColumn();
      renderShelf();
      openShelf();
      fixtureRects(fixture);
      const observer = HeadroomResizeObserver.instances.at(-1);
      observer?.fireAt(fixture.column, 800);
      observer?.fireAt(panelOf(), 20);
      expect(panelOf().style.minHeight).toBe("48px");
      expect(panelOf().hasAttribute("data-headless")).toBe(false);
    });

    it("keeps the unsized panel at its CSS cap with surplus, and bottoms out at 0px", () => {
      const fixture = mountInColumn();
      renderShelf();
      openShelf();
      const panel = panelOf();
      fixtureRects(fixture);
      const observer = HeadroomResizeObserver.instances.at(-1);
      // Surplus: 476 available > the 280px default cap, so the cap wins.
      mockRect(fixture.column, 800);
      observer?.fireAt(fixture.column, 800);
      expect(panel.style.maxHeight).toBe("280px");
      // 300 − 204 − 120 = −24 clamps to 0 rather than a negative height.
      mockRect(fixture.column, 300);
      observer?.fireAt(fixture.column, 300);
      expect(panel.style.maxHeight).toBe("0px");
    });

    it("clears the inline clamp and the shelf's no-yield shrink when the shelf closes", () => {
      const fixture = mountInColumn();
      renderShelf();
      openShelf();
      fixtureRects(fixture);
      const observer = HeadroomResizeObserver.instances.at(-1);
      mockRect(fixture.column, 500);
      observer?.fireAt(fixture.column, 500);
      expect(panelOf().style.maxHeight).toBe("176px");
      const bar = requireElement(
        container.querySelector<HTMLButtonElement>(".th-activity-bar"),
        "collapsed summary bar",
      );
      act(() => {
        bar.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      expect(container.querySelector(".th-activity-panel")).toBeNull();
      act(() => {
        bar.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      // Reopened: the clamp resets until the column is measured again.
      expect(panelOf().style.maxHeight).toBe("");
      const shelf = container.querySelector<HTMLElement>(".th-activity-shelf");
      if (!shelf) throw new Error("missing activity shelf");
      expect(shelf.style.flexShrink).toBe("");
    });

    it("recomputes the clamp when the queue slot appears, grows, expands, collapses, and disappears", () => {
      const fixture = mountInColumn();
      window.localStorage.setItem(STORAGE_KEY, "450");
      renderShelf();
      openShelf();
      fixtureRects(fixture);
      const observer = HeadroomResizeObserver.instances.at(-1);
      observer?.fireAt(fixture.column, 800);
      // 800 − 120 − 24 − 30 − 30 − 120 = 476 available; the 60vh cap wins.
      expect(panelOf().style.maxHeight).toBe(`${PANEL_MAX}px`);

      // A collapsed queue appears between the shelves and the composer.
      const queue = document.createElement("section");
      queue.className = "th-queue";
      fixture.column.insertBefore(queue, fixture.status);
      mockRect(queue, 28);
      ShelfMutationObserver.instances.at(-1)?.fire();
      expect(observer?.observed).toContain(queue);
      // 476 − 28 queue = 448 available, below the 60vh cap.
      expect(panelOf().style.maxHeight).toBe("448px");

      // The queue grows (queued rows) without a column resize.
      mockRect(queue, 100);
      observer?.fireAt(queue, 100);
      expect(panelOf().style.maxHeight).toBe("376px");

      // Expanding mounts a body inside the slot: the mutation refreshes the
      // measured set and the larger slot height feeds the clamp.
      const body = document.createElement("div");
      body.className = "th-queue-body";
      queue.append(body);
      mockRect(queue, 220);
      ShelfMutationObserver.instances.at(-1)?.fire();
      expect(panelOf().style.maxHeight).toBe("256px");

      // Collapsing unmounts the body and the slot shrinks again.
      body.remove();
      mockRect(queue, 28);
      ShelfMutationObserver.instances.at(-1)?.fire();
      expect(panelOf().style.maxHeight).toBe("448px");

      // The queue empties and the slot disappears entirely.
      queue.remove();
      ShelfMutationObserver.instances.at(-1)?.fire();
      expect(observer?.observed).not.toContain(queue);
      expect(panelOf().style.maxHeight).toBe(`${PANEL_MAX}px`);
    });

    it("bounds the expanded queue body with an internal scrollport", () => {
      const css = readFileSync("src/styles/chat-pane.css", "utf8");
      const rule = css.match(/\.th-queue-body\s*\{[^}]*\}/)?.[0] ?? "";
      expect(rule).not.toBe("");
      expect(rule).toMatch(/max-height:/);
      expect(rule).toMatch(/overflow:\s*auto/);
    });

    it("never applies a clamp without a chat column (standalone render keeps CSS caps)", () => {
      renderShelf();
      openShelf();
      expect(panelOf().style.maxHeight).toBe("");
      const observer = HeadroomResizeObserver.instances.at(-1);
      expect(observer?.observed).toEqual([panelOf()]);
    });
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
      const observer = HeadroomResizeObserver.instances.at(-1);
      expect(observer).toBeDefined();
      expect(observer?.observed).toEqual([panel]);
      observer?.fire(18);
      expect(panel.getAttribute("data-headless")).toBe("true");
      observer?.fire(120);
      expect(panel.hasAttribute("data-headless")).toBe(false);
    });

    it("hides headers only below 24px: 30px and 24px keep them, 23px hides them", () => {
      renderShelf();
      openShelf();
      const observer = HeadroomResizeObserver.instances.at(-1);
      observer?.fire(30);
      expect(panelOf().hasAttribute("data-headless")).toBe(false);
      observer?.fire(23);
      expect(panelOf().getAttribute("data-headless")).toBe("true");
      observer?.fire(24);
      expect(panelOf().hasAttribute("data-headless")).toBe(false);
    });

    it("disconnects the observer, clears the flag on close, and starts fresh on reopen", () => {
      renderShelf();
      openShelf();
      const panel = panelOf();
      const observer = HeadroomResizeObserver.instances.at(-1);
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
      const reopenedObserver = HeadroomResizeObserver.instances.at(-1);
      expect(reopenedObserver).not.toBe(observer);
      expect(panelOf().hasAttribute("data-headless")).toBe(false);
    });

    it("re-observes the replacement panel when an open shelf empties and repopulates", () => {
      renderShelf();
      openShelf();
      const firstPanel = panelOf();
      const firstObserver = HeadroomResizeObserver.instances.at(-1);
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
      const secondPanel = panelOf();
      expect(secondPanel).not.toBe(firstPanel);
      const secondObserver = HeadroomResizeObserver.instances.at(-1);
      expect(secondObserver).not.toBe(firstObserver);
      expect(secondObserver?.observed).toEqual([secondPanel]);
      expect(secondPanel.hasAttribute("data-headless")).toBe(false);
      secondObserver?.fire(54);
      expect(secondPanel.hasAttribute("data-headless")).toBe(false);
      secondObserver?.fire(18);
      expect(secondPanel.getAttribute("data-headless")).toBe("true");
    });
  });
});
