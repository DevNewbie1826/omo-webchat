import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyActivityState } from "./activityState";
import {
  activityState,
  click,
  makeDag,
  makeTask,
  mountActivityShelf,
  openShelf,
  renderShelf,
  unmountActivityShelf,
  type ActivityShelfHarness,
} from "./ActivityShelf.support";
import { requireElement } from "./chatPaneTestHarness";

describe("ActivityShelf", () => {
  let harness: ActivityShelfHarness;

  beforeEach(() => {
    harness = mountActivityShelf();
  });

  afterEach(async () => {
    await unmountActivityShelf(harness);
  });

  it("renders nothing when there is no activity", () => {
    renderShelf(harness, emptyActivityState());
    expect(harness.container.querySelector(".th-activity-shelf")).toBeNull();
    expect(harness.container.textContent).toBe("");
  });

  it("keeps the bar mounted when every task and dag is terminal", () => {
    // Finished work is the transcript's record of what ran: the shelf stays
    // mounted with terminal entries sorted behind live ones.
    renderShelf(
      harness,
      activityState({
        tasks: [makeTask({ status: "completed" })],
        dags: [makeDag({ status: "completed" })],
      }),
    );
    expect(harness.container.querySelector(".th-activity-shelf")).not.toBeNull();
  });

  it("renders retained prefix rows and marks truncated history as partial in the affected contents", () => {
    renderShelf(harness, activityState({
      tasks: [makeTask({ name: "Retained prefix task" })],
      dags: [makeDag({ name: "Retained prefix DAG" })],
      truncatedTasks: true,
      truncatedDags: true,
    }));
    openShelf(harness.container);

    expect(harness.container.querySelector(".th-activity-agent-name")?.textContent).toContain("Retained prefix task");
    expect(harness.container.querySelector(".th-activity-dag-name")?.textContent).toContain("Retained prefix DAG");
    // The notice now lives inside the affected DAG contents; the Agents
    // tab shows exact scalar-authority counts only.
    const partials = [...harness.container.querySelectorAll(".th-activity-partial")];
    expect(partials.length).toBe(1);
    for (const partial of partials) {
      expect(partial.textContent).toBe("activity.partial");
      expect(partial.closest("[data-activity-tabpanel]")?.getAttribute("data-activity-tabpanel")).toMatch(/dag/);
    }
  });

  it("renders the partial marker in the DAG content even when no retained rows fit", () => {
    renderShelf(harness, activityState({ truncatedDags: true }));

    expect(harness.container.querySelector(".th-activity-shelf")).not.toBeNull();
    // Zero retained rows still reach the notice through the DAG tab.
    click(
      requireElement(
        harness.container.querySelector<HTMLButtonElement>('[role="tab"][data-activity-tab="dag"]'),
        "dag tab",
      ),
    );
    const dagPanel = requireElement(
      harness.container.querySelector<HTMLElement>('[data-activity-tabpanel="dag"]'),
      "dag tabpanel",
    );
    expect(dagPanel.querySelector(".th-activity-empty")?.textContent).toBe("activity.emptyDag");
    expect(dagPanel.querySelector(".th-activity-partial")?.textContent).toBe("activity.partial");
  });

  it("keeps the permanent tab strip as the collapsed shelf's information surface", () => {
    renderShelf(harness, activityState({
      todo: [{ name: "phase", tasks: [{ content: "done item", status: "completed" }] }],
      tasks: [makeTask()],
      dags: [makeDag()],
    }));
    // The summary pill row and its separate fold control are removed; the
    // counts that lived there now ride in the always-visible tabs.
    expect(harness.container.querySelector(".th-activity-bar-row")).toBeNull();
    expect(harness.container.querySelector("button.th-activity-fold")).toBeNull();
    expect(harness.container.querySelector(".th-activity-panel")).toBeNull();
    const tablist = requireElement(harness.container.querySelector("[role='tablist']"), "tablist");
    expect(tablist.getAttribute("aria-label")).toBe("activity.tabs");
    const counts = [...harness.container.querySelectorAll("[data-activity-tab]")].map(
      (tab) => tab.querySelector(".th-activity-tab-count")?.textContent,
    );
    expect(counts).toEqual(["1/1", "2/4", "2/3"]);
  });

  it("opens and closes through the tabs, exposing open and expanded state on the root", () => {
    renderShelf(harness, activityState({ tasks: [makeTask()] }));
    const shelf = requireElement(harness.container.querySelector(".th-activity-shelf"), "shelf");
    const selectedTab = () =>
      requireElement(
        harness.container.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]'),
        "selected activity tab",
      );
    expect(shelf.getAttribute("data-open")).toBe("false");
    expect(shelf.getAttribute("data-expanded")).toBe("false");

    click(selectedTab());
    expect(shelf.getAttribute("data-open")).toBe("true");
    expect(shelf.getAttribute("data-expanded")).toBe("true");
    expect(harness.container.querySelector(".th-activity-panel")).not.toBeNull();

    click(selectedTab());
    expect(shelf.getAttribute("data-open")).toBe("false");
    expect(shelf.getAttribute("data-expanded")).toBe("false");
    expect(harness.container.querySelector(".th-activity-panel")).toBeNull();
    // The selection survives the close.
    expect(selectedTab().getAttribute("data-activity-tab")).toBe("agents");
  });
});
