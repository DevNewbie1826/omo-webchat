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

  it("renders retained prefix rows and marks truncated history as partial", () => {
    renderShelf(harness, activityState({
      tasks: [makeTask({ name: "Retained prefix task" })],
      dags: [makeDag({ name: "Retained prefix DAG" })],
      truncatedTasks: true,
      truncatedDags: true,
    }));
    openShelf(harness.container);

    expect(harness.container.querySelector(".th-activity-agent-name")?.textContent).toContain("Retained prefix task");
    expect(harness.container.querySelector(".th-activity-dag-name")?.textContent).toContain("Retained prefix DAG");
    expect(harness.container.querySelector(".th-activity-partial")?.textContent).toBe("activity.partial");
  });

  it("renders the partial marker even when no retained rows fit", () => {
    renderShelf(harness, activityState({ truncatedDags: true }));

    expect(harness.container.querySelector(".th-activity-shelf")).not.toBeNull();
    expect(harness.container.querySelector(".th-activity-partial")?.textContent).toBe("activity.partial");
  });

  it("renders a collapsed summary bar as a live status region while activity exists", () => {
    renderShelf(harness, activityState({ tasks: [makeTask()] }));
    // P5: the summary row is status text; the fold control is a separate button.
    const bar = requireElement(harness.container.querySelector(".th-activity-bar"), "summary bar");
    const fold = requireElement(
      harness.container.querySelector<HTMLButtonElement>("button.th-activity-fold"),
      "separate fold control",
    );
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(harness.container.querySelector(".th-activity-panel")).toBeNull();
    const status = requireElement(harness.container.querySelector('[role="status"]'), "status region");
    expect(status.contains(bar)).toBe(true);
    expect(bar.textContent).toContain("activity.summaryAgents");
  });

  it("expands and collapses via the separate fold control", () => {
    renderShelf(harness, activityState({ tasks: [makeTask()] }));
    const fold = requireElement(
      harness.container.querySelector<HTMLButtonElement>("button.th-activity-fold"),
      "separate fold control",
    );
    click(fold);
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expect(harness.container.querySelector(".th-activity-panel")).not.toBeNull();
    click(fold);
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(harness.container.querySelector(".th-activity-panel")).toBeNull();
  });
});
