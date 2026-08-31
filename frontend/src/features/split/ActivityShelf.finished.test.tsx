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

/**
 * The shelf is the transcript's record of agent and DAG work: finished
 * entries must stay mounted (sorted behind live ones by orderActivities)
 * instead of vanishing the moment everything reaches a terminal status.
 * It hides only when there is genuinely nothing to show.
 */
describe("ActivityShelf finished work", () => {
  let harness: ActivityShelfHarness;

  beforeEach(() => {
    harness = mountActivityShelf();
  });

  afterEach(async () => {
    await unmountActivityShelf(harness);
  });

  it("keeps finished agents and finished dag runs visible after they complete", () => {
    renderShelf(
      harness,
      activityState({
        tasks: [makeTask({ status: "completed" })],
        dags: [makeDag({ status: "completed" })],
      }),
    );

    // The whole panel must not unmount once every entry is terminal.
    const shelf = harness.container.querySelector(".th-activity-shelf");
    expect(shelf).not.toBeNull();
    expect(harness.container.innerHTML).not.toBe("");

    // The finished entries themselves are reachable behind the summary bar,
    // each reading as complete through a visible word, never colour alone.
    openShelf(harness.container);
    const agentRow = requireElement(
      [...harness.container.querySelectorAll(".th-activity-agent")].find((row) => row.textContent?.includes("Spawned agent")) ?? null,
      "finished agent row",
    );
    expect(agentRow.textContent).toContain("Spawned agent");
    expect(agentRow.querySelector(".th-activity-chip--ok")?.textContent).toBe(
      "activity.status.completed",
    );
    const dagRow = requireElement(
      harness.container.querySelector(".th-activity-dag"),
      "finished dag run",
    );
    expect(dagRow.textContent).toContain("Ship");
    expect(dagRow.querySelector(".th-activity-chip--ok")?.textContent).toBe(
      "activity.status.completed",
    );
  });

  it("marks each finished graph node with a status glyph, not colour alone", () => {
    renderShelf(harness, activityState({ dags: [makeDag({ status: "completed" })] }));
    openShelf(harness.container);
    click(
      requireElement(
        harness.container.querySelector<HTMLButtonElement>('.th-activity-view-btn[data-view="graph"]'),
        "graph toggle",
      ),
    );

    const graph = requireElement(harness.container.querySelector(".th-activity-graph"), "graph view");
    const glyphOf = (id: string): Element | null =>
      graph.querySelector(`.th-activity-gnode[data-node="${id}"] .th-activity-gstatus`) ?? null;
    // Completed nodes carry a check glyph; the running node carries a ring.
    expect(glyphOf("a")?.textContent).toBe("✓");
    expect(glyphOf("b")?.textContent).toBe("✓");
    expect(glyphOf("c")?.classList.contains("th-activity-gstatus--running")).toBe(true);
    for (const glyph of graph.querySelectorAll(".th-activity-gstatus")) {
      expect(glyph.getAttribute("aria-hidden")).toBe("true");
    }
    // The node's accessible tooltip names its status in words too.
    expect(
      graph.querySelector('.th-activity-gnode[data-node="a"] title')?.textContent,
    ).toContain("activity.status.completed");
  });

  it("stays hidden when there is nothing at all to show", () => {
    renderShelf(harness, emptyActivityState());
    expect(harness.container.querySelector(".th-activity-shelf")).toBeNull();
    expect(harness.container.textContent).toBe("");
  });
});
