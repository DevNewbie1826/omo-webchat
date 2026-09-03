import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n";
import { GoalBar } from "./GoalBar";
import type { ChatGoal } from "./goalState";
import { i18n as testI18n } from "./chatPaneTestHarness";

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

  it("marks a truncated objective with an ellipsis in the collapsed summary", () => {
    renderBar({ objective: "long objective", status: "active", objectiveTruncated: true });
    expect(container.querySelector(".th-goal-summary")?.textContent).toBe("long objective…");
  });
});
