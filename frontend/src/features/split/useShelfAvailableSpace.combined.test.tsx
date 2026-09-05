import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n";
import { ActivityShelf } from "./ActivityShelf";
import { GoalBar } from "./GoalBar";
import { i18n, requireElement } from "./chatPaneTestHarness";
import { computeShelfAvailableSpace } from "./useShelfAvailableSpace";

class ColumnObserver implements ResizeObserver {
  static instances: ColumnObserver[] = [];
  readonly targets = new Set<Element>();
  constructor(readonly callback: ResizeObserverCallback) { ColumnObserver.instances.push(this); }
  observe(target: Element): void { this.targets.add(target); }
  unobserve(target: Element): void { this.targets.delete(target); }
  disconnect(): void { this.targets.clear(); }
  static measure(): void {
    act(() => {
      for (const observer of ColumnObserver.instances) {
        if (observer.targets.size) observer.callback([], observer);
      }
    });
  }
}

// Deliberate delivery: preference tests must not borrow a resize or mutation
// notification. Floor tests explicitly deliver repeated geometry evaluations.
class ColumnMutationObserver implements MutationObserver {
  disconnect(): void {}
  observe(): void {}
  takeRecords(): MutationRecord[] { return []; }
}

let root: Root;
let container: HTMLDivElement;
let style: HTMLStyleElement;
let columnHeight: number;
const activities = {
  tasks: new Map([["finished", { taskId: "finished", name: "Completed fixture", status: "completed", updatedAt: "2026-09-05T00:00:00Z" }]]),
  dags: new Map(), todo: null, heartbeats: new Map(),
};
const element = (selector: string): HTMLElement => requireElement(container.querySelector<HTMLElement>(selector), selector);
const click = (selector: string): void => { act(() => element(selector).click()); };
const key = (value: string): void => {
  act(() => element(".th-activity-resize").dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true })));
};
function render(): void {
  act(() => root.render(<I18nContext.Provider value={i18n}>
    <div className="th-chat-main">
      <div className="th-chat-scrollport" />
      <GoalBar goal={{ objective: "Small intrinsic goal", status: "active" }} />
      <ActivityShelf activities={activities} />
      <div className="th-chat-status" /><div className="th-chat-input" />
    </div>
  </I18nContext.Provider>));
}
function open(order: "goal" | "activity"): void {
  for (const shelf of order === "goal" ? ["goal", "activity"] : ["activity", "goal"]) {
    click(shelf === "goal" ? ".th-goal-bar" : ".th-activity-shelf .th-activity-bar");
    ColumnObserver.measure();
  }
}

describe("combined shelf allocation lifecycle", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("ResizeObserver", ColumnObserver);
    vi.stubGlobal("MutationObserver", ColumnMutationObserver);
    vi.stubGlobal("innerHeight", 800);
    ColumnObserver.instances = [];
    window.localStorage.clear();
    columnHeight = 800;
    style = document.createElement("style");
    // Use shipped spacing, resolving tokens only because jsdom has no custom
    // property layout. Changing which element owns the gap changes this test.
    style.textContent = readFileSync("src/styles/activity-shelf.css", "utf8")
      .replaceAll("var(--th-space-0-5)", "2px").replaceAll("var(--th-space-1)", "4px")
      .replaceAll("var(--th-space-2)", "8px");
    document.head.append(style);
    let measurements = 0;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.matches(".th-chat-main") && ++measurements > 100) throw new Error("column allocation did not settle within 100 measurements");
      const height = this.matches(".th-chat-main") ? columnHeight
        : this.matches(".th-chat-input") ? 100
        : this.matches(".th-chat-status") ? 24
        : this.matches(".th-activity-bar-row") ? 30
        : this.matches(".th-activity-resize") ? 10
        : this.matches(".th-goal-content") ? 48
        : this.matches(".th-fixture-banner") ? 20 : 0;
      return new DOMRect(0, 0, 600, height);
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove(); style.remove();
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  });

  for (const order of ["goal", "activity"] as const) {
    it.each([48, 49, 50, 51])("keeps open-intent spacing stable at the %ipx absent-panel boundary, " + order + " first", (floor) => {
      render(); open(order);
      const column = element(".th-chat-main");
      // Start with both shelves registered and find the budget excluding the
      // panel's 4px gap, then enter the mount boundary without closing intent.
      columnHeight -= computeShelfAvailableSpace(column) + 4 - floor;
      ColumnObserver.measure();
      const budgets: number[] = [];
      for (let frame = 0; frame < 6; frame++) {
        budgets.push(computeShelfAvailableSpace(column));
        ColumnObserver.measure();
      }
      expect(budgets).toEqual(Array(6).fill(floor - 4));
      expect(container.querySelector(".th-activity-panel")).toBeNull();
      expect(container.querySelector(".th-goal-panel")).toBeNull();
      expect(element(".th-activity-resize")).toBeDefined();
      // Dynamic fixed-band arrival/removal must not wake the recurrence.
      const banner = document.createElement("div");
      banner.className = "th-fixture-banner";
      column.prepend(banner); ColumnObserver.measure();
      expect(computeShelfAvailableSpace(column)).toBe(floor - 24);
      banner.remove(); ColumnObserver.measure();
      expect(computeShelfAvailableSpace(column)).toBe(floor - 4);
      columnHeight = 800; ColumnObserver.measure();
      expect(container.querySelector(".th-activity-panel")).not.toBeNull();
      expect(container.querySelector(".th-goal-panel")).not.toBeNull();
    });

    it("applies Home then ArrowUp immediately with both real shelves open, " + order + " first", () => {
      render(); open(order);
      key("Home"); ColumnObserver.measure();
      expect(element(".th-activity-panel").style.maxHeight).toBe("120px");
      key("ArrowUp");
      expect(element(".th-activity-panel").style.height).toBe("144px");
      expect(element(".th-activity-panel").style.maxHeight).toBe("144px");
      expect(element(".th-goal-panel").style.maxHeight).toBe("48px");
    });
  }

  it("retains saved480 through a short restore and growth without reloading", () => {
    vi.stubGlobal("innerHeight", 300); columnHeight = 300;
    window.localStorage.setItem("th-activity-panel-height", "480");
    render(); open("goal");
    expect(element(".th-activity-resize").getAttribute("aria-valuenow")).toBe("480");
    vi.stubGlobal("innerHeight", 800); columnHeight = 800;
    act(() => window.dispatchEvent(new Event("resize")));
    expect(element(".th-activity-panel").style.height).toBe("480px");
    expect(Number.parseFloat(element(".th-activity-panel").style.maxHeight)).toBeGreaterThan(180);
    expect(window.localStorage.getItem("th-activity-panel-height")).toBe("480");
  });
});
