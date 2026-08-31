import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyActivityState } from "./activityState";
import {
  activityState,
  click,
  makeDag,
  makeTask,
  mountActivityShelf,
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

  it("renders a collapsed summary bar as a live status region while activity exists", () => {
    renderShelf(harness, activityState({ tasks: [makeTask()] }));
    const bar = requireElement(
      harness.container.querySelector<HTMLButtonElement>(".th-activity-bar"),
      "collapsed summary bar",
    );
    expect(bar.getAttribute("aria-expanded")).toBe("false");
    expect(harness.container.querySelector(".th-activity-panel")).toBeNull();
    const status = requireElement(harness.container.querySelector('[role="status"]'), "status region");
    expect(status.contains(bar)).toBe(true);
    expect(bar.textContent).toContain("activity.summaryAgents");
  });

  it("expands and collapses via the toggle button", () => {
    renderShelf(harness, activityState({ tasks: [makeTask()] }));
    const bar = requireElement(
      harness.container.querySelector<HTMLButtonElement>(".th-activity-bar"),
      "collapsed summary bar",
    );
    click(bar);
    expect(bar.getAttribute("aria-expanded")).toBe("true");
    expect(harness.container.querySelector(".th-activity-panel")).not.toBeNull();
    click(bar);
    expect(bar.getAttribute("aria-expanded")).toBe("false");
    expect(harness.container.querySelector(".th-activity-panel")).toBeNull();
  });
});
