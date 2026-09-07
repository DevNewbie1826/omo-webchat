import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

/**
 * Collapsed tab-count contract (successor of the summary-bar separator
 * contract). The shelf no longer mounts a summary bar, so the per-region
 * information it carried — todo done/total, agents running/total, DAG
 * done/total — must ride in the permanent tab strip, visible while the
 * panel is closed, and survive a close/reopen round trip unchanged.
 */

describe("ActivityShelf collapsed tab counts", () => {
  let harness: ActivityShelfHarness;

  beforeEach(() => {
    harness = mountActivityShelf();
  });

  afterEach(async () => {
    await unmountActivityShelf(harness);
  });

  function tabCounts(): readonly (string | null)[] {
    return [...harness.container.querySelectorAll("[data-activity-tab]")].map(
      (tab) => tab.querySelector(".th-activity-tab-count")?.textContent ?? null,
    );
  }

  it("carries todo, agents, and dag counts in the permanent tab strip", () => {
    renderShelf(
      harness,
      activityState({
        tasks: [makeTask()],
        dags: [makeDag()],
        todo: [{ name: "phase", tasks: [] }],
      }),
    );
    expect(tabCounts()).toEqual(["0/0", "2/4", "2/3"]);
  });

  it("keeps the counts visible while the panel is closed and after a close/reopen", () => {
    renderShelf(
      harness,
      activityState({
        tasks: [makeTask()],
        dags: [makeDag()],
        todo: [{ name: "phase", tasks: [{ content: "done", status: "completed" }] }],
      }),
    );
    expect(tabCounts()).toEqual(["1/1", "2/4", "2/3"]);

    const selectedTab = () =>
      requireElement(
        harness.container.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]'),
        "selected activity tab",
      );
    click(selectedTab());
    expect(harness.container.querySelector(".th-activity-panel")).not.toBeNull();
    click(selectedTab());
    expect(harness.container.querySelector(".th-activity-panel")).toBeNull();
    // Collapsed again: the same counts, same order.
    expect(tabCounts()).toEqual(["1/1", "2/4", "2/3"]);
  });

  it("leaves the count off a tab with no content instead of showing an empty pair", () => {
    renderShelf(harness, activityState({ todo: [{ name: "phase", tasks: [] }] }));
    expect(tabCounts()).toEqual(["0/0", null, null]);
  });
});
