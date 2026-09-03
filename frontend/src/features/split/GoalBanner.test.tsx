import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n";
import { GoalBanner } from "./GoalBanner";
import type { ChatGoal } from "./goalState";
import { i18n as testI18n } from "./chatPaneTestHarness";

function renderBanner(goal: ChatGoal): void {
  act(() => {
    root.render(
      <I18nContext.Provider value={testI18n}>
        <GoalBanner goal={goal} />
      </I18nContext.Provider>,
    );
  });
}

let root: Root;
let container: HTMLDivElement;

describe("GoalBanner", () => {
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

  it("renders objective, active status, and the goal banner contract classes", () => {
    renderBanner({ objective: "골 상태 실시간 웹 표시", status: "active" });
    const banner = container.querySelector(".th-alert--info.th-goal-banner");
    expect(banner).not.toBeNull();
    expect(banner?.getAttribute("role")).toBe("status");
    expect(container.querySelector(".th-goal-headline")?.textContent).toContain("chat.goal.title");
    expect(container.querySelector(".th-goal-status--active")?.textContent).toBe("chat.goal.statusActive");
    expect(container.querySelector(".th-goal-objective")?.textContent).toContain("골 상태 실시간 웹 표시");
    expect(container.querySelector(".th-goal-blocked")).toBeNull();
  });

  it("renders the blocked reason with the warning tone", () => {
    renderBanner({ objective: "ship it", status: "blocked", blockedReason: "user interrupted the turn" });
    expect(container.querySelector(".th-alert--warning.th-goal-banner")).not.toBeNull();
    expect(container.querySelector(".th-goal-status--blocked")?.textContent).toBe("chat.goal.statusBlocked");
    expect(container.querySelector(".th-goal-blocked")?.textContent).toContain("user interrupted the turn");
  });

  it("marks truncated objectives and complete status", () => {
    renderBanner({ objective: "long objective", status: "complete", objectiveTruncated: true });
    expect(container.querySelector(".th-goal-status--complete")?.textContent).toBe("chat.goal.statusComplete");
    expect(container.querySelector(".th-goal-objective")?.textContent).toBe("long objective…");
  });
});
