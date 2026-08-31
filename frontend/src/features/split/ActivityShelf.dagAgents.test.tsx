import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activityState,
  iso,
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
 * Regression (live capture 2026-08-30, /tmp/ulw-shelf2-live.json): the omo
 * runtime reports workflow children ONLY as dag run nodes — zero
 * omo.task.updated frames exist for them — so the agents section stayed
 * permanently empty while DAG runs showed. Workflow node children must be
 * surfaced as agent rows.
 */
describe("ActivityShelf workflow nodes as agents", () => {
  let harness: ActivityShelfHarness;

  beforeEach(() => {
    harness = mountActivityShelf();
  });

  afterEach(async () => {
    await unmountActivityShelf(harness);
  });

  // Regression (round-2 review minor): nodes report lastActivityAt while
  // running; without mapping it into updatedAt, a child that has been alive
  // over two minutes but reported seconds ago renders as stale.
  it("maps node lastActivityAt into the agent row so reporting children are not stale", () => {
    renderShelf(harness, activityState({
      dags: [makeDag({
        runId: "run-fresh",
        nodes: [
          {
            id: "a",
            label: "오래 돌지만 방금 보고한 에이전트",
            prompt: "p",
            dependsOn: [],
            state: "running",
            startedAt: iso(200_000),
            lastActivityAt: iso(2_000),
          },
        ],
        waves: [{ index: 0, nodeIds: ["a"] }],
      })],
    }));
    openShelf(harness.container);

    const row = requireElement(harness.container.querySelector(".th-activity-agent"), "agent row");
    expect(row.classList.contains("th-activity-stale")).toBe(false);
    expect(row.textContent).not.toContain("activity.stale");
  });

  it("sorts skipped workflow nodes with finished work and keeps them listed", () => {
    renderShelf(harness, activityState({
      dags: [makeDag({
        runId: "run-skip",
        nodes: [
          { id: "live", label: "달리는 노드", prompt: "p", dependsOn: [], state: "running" },
          { id: "skip", label: "건너뛴 노드", prompt: "p", dependsOn: [], state: "skipped" },
        ],
        waves: [{ index: 0, nodeIds: ["live", "skip"] }],
      })],
    }));
    openShelf(harness.container);

    const rows = [...harness.container.querySelectorAll(".th-activity-agent")];
    expect(rows.length).toBe(2);
    expect(rows[0]?.textContent).toContain("달리는 노드");
    expect(rows[1]?.textContent).toContain("건너뛴 노드");
  });

  it("drops a node whose taskId already has a task row so a child is listed once", () => {
    renderShelf(harness, activityState({
      tasks: [makeTask({ taskId: "st_1", name: "a", status: "completed" })],
      dags: [makeDag({
        runId: "run-d",
        name: "dup",
        nodes: [
          { id: "a", label: "node a", prompt: "a", dependsOn: [], state: "completed", taskId: "st_1" },
          { id: "b", label: "node b", prompt: "b", dependsOn: [], state: "running" },
        ],
        waves: [{ index: 0, nodeIds: ["a", "b"] }],
      })],
    }));
    openShelf(harness.container);

    const rows = [...harness.container.querySelectorAll(".th-activity-agent")];
    expect(rows.length).toBe(2);
    expect(rows.some((row) => row.textContent?.includes("node a"))).toBe(false);
    expect(rows.some((row) => row.textContent?.includes("node b"))).toBe(true);
    expect(rows.some((row) => row.textContent?.includes("(dup)"))).toBe(true);
  });

  it("lists dag run nodes as agent rows when no task events exist", () => {
    renderShelf(harness, activityState({
      dags: [makeDag({
        runId: "run-9",
        name: "mass-ulw",
        nodes: [
          { id: "a", label: "audit lane", prompt: "audit", dependsOn: [], state: "completed", startedAt: "2026-08-30T12:00:00.000Z" },
          { id: "b", label: "구현 레인", prompt: "implement", dependsOn: [], state: "running", startedAt: "2026-08-30T12:05:00.000Z", currentTool: "bash", turns: 3 },
          { id: "c", label: "검증 레인", prompt: "verify", dependsOn: ["a"], state: "scheduled" },
        ],
        waves: [{ index: 0, nodeIds: ["a", "b", "c"] }],
      })],
    }));
    openShelf(harness.container);

    const rows = [...harness.container.querySelectorAll(".th-activity-agent")];
    expect(rows.length).toBe(3);

    // Live-first: running and scheduled sort before completed.
    expect(rows[0]?.textContent).toContain("구현 레인");
    expect(rows[2]?.textContent).toContain("audit lane");

    // Node live progress surfaces like a task's would.
    expect(rows[0]?.textContent).toContain("bash");

    // The collapsed bar counts workflow children as agents too.
    expect(harness.container.querySelector(".th-activity-bar-text")?.textContent).toContain("activity.summaryAgents");
  });
});
