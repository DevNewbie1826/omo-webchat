import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n";
import { GoalBar } from "./GoalBar";
import type { ChatGoal } from "./goalState";
import { i18n as testI18n } from "./chatPaneTestHarness";

/** Controllable ResizeObserver fake for the goal shelf's column clamp. */
class GoalColumnObserver {
  static instances: GoalColumnObserver[] = [];
  readonly observed: Element[] = [];
  disconnected = false;

  constructor(private readonly callback: ResizeObserverCallback) {
    GoalColumnObserver.instances.push(this);
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

  fireAt(target: Element, height: number): void {
    if (this.disconnected || !this.observed.includes(target)) return;
    act(() => {
      this.callback([{
        target,
        contentRect: { height, width: 600, x: 0, y: 0, top: 0, left: 0, bottom: height, right: 600, toJSON: () => ({}) },
      } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
    });
  }
}

function renderBar(goal: ChatGoal | null): void {
  act(() => {
    root.render(
      <I18nContext.Provider value={testI18n}>
        <GoalBar goal={goal} />
      </I18nContext.Provider>,
    );
  });
}

let root: Root;
let container: HTMLDivElement;

describe("GoalBar", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("renders nothing when the goal is null", () => {
    renderBar(null);
    expect(container.querySelector(".th-goal-bar")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("renders the collapsed bar for an active goal", () => {
    renderBar({ objective: "골 상태 실시간 웹 표시", status: "active" });
    const bar = container.querySelector<HTMLButtonElement>("button.th-activity-bar.th-goal-bar");
    if (!bar) throw new Error("missing goal bar button");
    expect(bar.getAttribute("aria-expanded")).toBe("false");
    expect(bar.getAttribute("aria-controls")).not.toBe("");
    expect(bar.getAttribute("aria-label")).toBe("chat.goal.title — chat.goal.expand");
    expect(container.querySelector(".th-goal-title")?.textContent).toBe("chat.goal.title");
    expect(container.querySelector(".th-activity-chip--running")?.textContent).toBe("chat.goal.statusActive");
    expect(container.querySelector(".th-goal-summary")?.textContent).toContain("골 상태 실시간 웹 표시");
    expect(container.querySelector(".th-activity-caret")).not.toBeNull();
    expect(container.querySelector(".th-activity-caret--open")).toBeNull();
    expect(container.querySelector(".th-goal-panel")).toBeNull();
  });

  it("toggles the panel open and closed from the bar button", () => {
    const objective = "refactor the goal lane end to end without losing any detail";
    renderBar({ objective, status: "active" });
    const bar = container.querySelector<HTMLButtonElement>("button.th-goal-bar");
    if (!bar) throw new Error("missing goal bar button");
    act(() => {
      bar.click();
    });
    expect(bar.getAttribute("aria-expanded")).toBe("true");
    expect(bar.getAttribute("aria-label")).toBe("chat.goal.title — chat.goal.collapse");
    const panel = container.querySelector(".th-goal-panel");
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute("id")).toBe(bar.getAttribute("aria-controls"));
    expect(panel?.getAttribute("role")).toBe("group");
    expect(panel?.querySelector(".th-goal-objective-full")?.textContent).toBe(objective);
    act(() => {
      bar.click();
    });
    expect(bar.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".th-goal-panel")).toBeNull();
  });

  it("renders blocked with the error chip and the reason in the panel, complete with the ok chip", () => {
    renderBar({ objective: "ship the release", status: "blocked", blockedReason: "user interrupted the turn" });
    expect(container.querySelector(".th-activity-chip--error")?.textContent).toBe("chat.goal.statusBlocked");
    const bar = container.querySelector<HTMLButtonElement>("button.th-goal-bar");
    if (!bar) throw new Error("missing goal bar button");
    act(() => {
      bar.click();
    });
    const reason = container.querySelector(".th-goal-blocked-reason")?.textContent;
    expect(reason).toContain("chat.goal.blockedReason");
    expect(reason).toContain("user interrupted the turn");

    renderBar({ objective: "ship the release", status: "complete" });
    expect(container.querySelector(".th-activity-chip--ok")?.textContent).toBe("chat.goal.statusComplete");
    expect(container.querySelector(".th-goal-blocked-reason")).toBeNull();
  });

  it("falls back to the active presentation for an unknown status", () => {
    renderBar({ objective: "wait for review", status: "paused" });
    const chip = container.querySelector<HTMLElement>(".th-activity-chip");
    expect(chip?.className).toBe("th-activity-chip th-activity-chip--running");
    expect(chip?.textContent).toBe("chat.goal.statusActive");
  });

  it("updates the objective while the panel remains open", () => {
    renderBar({ objective: "first objective", status: "active" });
    const bar = container.querySelector<HTMLButtonElement>("button.th-goal-bar");
    if (!bar) throw new Error("missing goal bar button");
    act(() => {
      bar.click();
    });

    renderBar({ objective: "updated objective", status: "active" });

    expect(bar.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".th-goal-objective-full")?.textContent).toBe("updated objective");
  });

  it("unmounts the whole bar when the open goal disappears and disconnects its observer", () => {
    GoalColumnObserver.instances = [];
    vi.stubGlobal("ResizeObserver", GoalColumnObserver);
    act(() => root.unmount());
    const column = document.createElement("div");
    column.className = "th-chat-main";
    const mount = document.createElement("div");
    column.appendChild(mount);
    container.appendChild(column);
    root = createRoot(mount);
    renderBar({ objective: "goal that disappears", status: "active" });
    const bar = container.querySelector<HTMLButtonElement>("button.th-goal-bar");
    if (!bar) throw new Error("missing goal bar button");
    act(() => {
      bar.click();
    });
    expect(bar.getAttribute("aria-expanded")).toBe("true");
    const observer = GoalColumnObserver.instances.at(-1);

    renderBar(null);

    expect(container.querySelector(".th-goal-shelf")).toBeNull();
    expect(mount.innerHTML).toBe("");
    expect(observer?.disconnected).toBe(true);
  });

  it("marks a truncated objective with an ellipsis in the collapsed summary", () => {
    renderBar({ objective: "long objective", status: "active", objectiveTruncated: true });
    expect(container.querySelector(".th-goal-summary")?.textContent).toBe("long objective…");
  });

  describe("column clamp and expansion floor", () => {
    /** 40vh against the jsdom viewport — the same cap as the goal panel CSS. */
    const GOAL_CAP = Math.round(window.innerHeight * 0.4);
    const FLOOR = 48;
    // composer 120 + status 24 + goal bar 30 + activity bar 30 + 120 reserve.
    const FIXED_BAND = 324;

    beforeEach(() => {
      GoalColumnObserver.instances = [];
      vi.stubGlobal("ResizeObserver", GoalColumnObserver);
    });

    function mockRect(el: Element, height: number): void {
      vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
        height,
        width: 600,
        top: 0,
        bottom: height,
        left: 0,
        right: 600,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect);
    }

    /** Mount the bar inside a chat column with the fixed-band siblings the
     *  clamp measures (composer, status strip, activity shelf's summary bar). */
    function mountInColumn(): HTMLElement {
      const column = document.createElement("div");
      column.className = "th-chat-main";
      const composer = document.createElement("div");
      composer.className = "th-chat-input";
      const status = document.createElement("div");
      status.className = "th-chat-status";
      const activityBarRow = document.createElement("div");
      activityBarRow.className = "th-activity-bar-row";
      const mount = document.createElement("div");
      column.append(composer, status, activityBarRow, mount);
      container.appendChild(column);
      root = createRoot(mount);
      mockRect(column, 800);
      mockRect(composer, 120);
      mockRect(status, 24);
      mockRect(activityBarRow, 30);
      return column;
    }

    function openGoal(): void {
      const bar = container.querySelector<HTMLButtonElement>("button.th-goal-bar");
      if (!bar) throw new Error("missing goal bar button");
      act(() => {
        bar.click();
      });
      // The goal shelf's own summary bar is part of the fixed band; jsdom
      // has no layout, so pin its measured height.
      const goalBarRow = container.querySelector(".th-goal-shelf .th-activity-bar-row");
      if (!goalBarRow) throw new Error("missing goal summary bar");
      mockRect(goalBarRow, 30);
    }

    const panelOf = (): HTMLElement => {
      const panel = container.querySelector<HTMLElement>(".th-goal-panel");
      if (!panel) throw new Error("missing goal panel");
      return panel;
    };

    it("clamps the expanded panel to the column's real available space", () => {
      const column = mountInColumn();
      renderBar({ objective: "hold the line", status: "active" });
      openGoal();
      const observer = GoalColumnObserver.instances.at(-1);
      expect(observer?.observed).toContain(column);
      expect(observer?.observed).toContain(panelOf());
      expect(observer?.observed).toContain(column.querySelector(".th-chat-input"));
      expect(observer?.observed).toContain(column.querySelector(".th-chat-status"));
      // Registration measures immediately, without waiting for an observer.
      expect(panelOf().style.maxHeight).toBe(`${GOAL_CAP}px`);
      // 800 − 324 = 476 available > the 40vh cap, so the cap wins.
      observer?.fire(800);
      expect(panelOf().style.maxHeight).toBe(`${GOAL_CAP}px`);
      // 500 − 324 = 176 binds below the cap.
      mockRect(column, 500);
      observer?.fire(500);
      expect(panelOf().style.maxHeight).toBe("176px");
      // While the clamp is active the shelf must not participate in flex
      // shrinking — the transcript alone absorbs the deficit.
      const shelf = container.querySelector<HTMLElement>(".th-goal-shelf");
      if (!shelf) throw new Error("missing goal shelf");
      expect(shelf.style.flexShrink).toBe("0");
    });

    it("rebinds the self panel after floor collapse, restore, and another column resize", () => {
      const column = mountInColumn();
      renderBar({ objective: "hold the line", status: "active" });
      openGoal();
      const initialObserver = GoalColumnObserver.instances.at(-1);
      // 372 − 324 = 48: exactly at the floor the panel stays (never below).
      mockRect(column, 372);
      initialObserver?.fireAt(column, 372);
      expect(panelOf().style.maxHeight).toBe(`${FLOOR}px`);
      const firstPanel = panelOf();

      mockRect(column, 371);
      initialObserver?.fireAt(column, 371);
      expect(container.querySelector(".th-goal-panel")).toBeNull();
      expect(initialObserver?.disconnected).toBe(false);
      const collapsedObserver = GoalColumnObserver.instances.at(-1);
      expect(collapsedObserver).toBe(initialObserver);
      expect(collapsedObserver?.observed).not.toContain(firstPanel);
      const bar = container.querySelector<HTMLButtonElement>("button.th-goal-bar");
      if (!bar) throw new Error("missing goal bar button");
      expect(bar.getAttribute("aria-expanded")).toBe("false");

      mockRect(column, 800);
      collapsedObserver?.fireAt(column, 800);
      const restoredPanel = panelOf();
      expect(restoredPanel).not.toBe(firstPanel);
      const restoredObserver = GoalColumnObserver.instances.at(-1);
      expect(restoredObserver?.observed).toContain(restoredPanel);
      expect(restoredPanel.style.maxHeight).toBe(`${GOAL_CAP}px`);

      // A subsequent resize must exclude the replacement SELF panel rather
      // than subtracting it as another shelf. Give it a conspicuous height
      // so a stale captured reference produces 76px instead of 176px.
      mockRect(restoredPanel, 100);
      mockRect(column, 500);
      restoredObserver?.fireAt(column, 500);
      expect(panelOf().style.maxHeight).toBe("176px");
      expect(bar.getAttribute("aria-expanded")).toBe("true");
    });

    it("keeps a short intrinsic goal open instead of cycling through the floor", () => {
      const column = mountInColumn();
      renderBar({ objective: "short goal", status: "active" });
      openGoal();
      const content = container.querySelector(".th-goal-content")!;
      mockRect(content, 18);
      const observer = GoalColumnObserver.instances.at(-1);
      observer?.fireAt(column, 800);
      expect(container.querySelector(".th-goal-bar")?.getAttribute("aria-expanded")).toBe("true");
      expect(panelOf().style.maxHeight).toBe("48px");
      observer?.fireAt(content, 18);
      expect(panelOf().style.maxHeight).toBe("48px");
    });

    it("never counts a peer panel allocation as a fixed band", () => {
      const column = mountInColumn();
      renderBar({ objective: "hold the line", status: "active" });
      openGoal();
      const activityPanel = document.createElement("div");
      activityPanel.className = "th-activity-panel";
      column.appendChild(activityPanel);
      mockRect(activityPanel, 100);
      const observer = GoalColumnObserver.instances.at(-1);
      // Peer panels remain allocation outputs regardless of their mount position.
      observer?.fire(800);
      expect(panelOf().style.maxHeight).toBe(`${GOAL_CAP}px`);
      // 500 − 324 = 176: peer rendered height is not an input.
      mockRect(column, 500);
      observer?.fire(500);
      expect(panelOf().style.maxHeight).toBe("176px");
    });

    it("resets the clamp state on close", () => {
      const column = mountInColumn();
      renderBar({ objective: "hold the line", status: "active" });
      openGoal();
      const observer = GoalColumnObserver.instances.at(-1);
      mockRect(column, 500);
      observer?.fire(500);
      expect(panelOf().style.maxHeight).toBe("176px");
      const bar = container.querySelector<HTMLButtonElement>("button.th-goal-bar");
      if (!bar) throw new Error("missing goal bar button");
      act(() => {
        bar.click();
      });
      expect(container.querySelector(".th-goal-panel")).toBeNull();
      const shelf = container.querySelector<HTMLElement>(".th-goal-shelf");
      if (!shelf) throw new Error("missing goal shelf");
      expect(shelf.style.flexShrink).toBe("");
    });
  });
});
