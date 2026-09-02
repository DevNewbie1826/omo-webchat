import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activityState,
  click,
  makeDag,
  mountActivityShelf,
  openShelf,
  renderShelf,
  unmountActivityShelf,
  type ActivityShelfHarness,
} from "./ActivityShelf.support";
import { requireElement } from "./chatPaneTestHarness";
import { applyActivityEvent, emptyActivityState } from "./activityState";

describe("ActivityShelf", () => {
  let harness: ActivityShelfHarness;

  beforeEach(() => {
    harness = mountActivityShelf();
  });

  afterEach(async () => {
    await unmountActivityShelf(harness);
  });

  it("renders engine-shaped task and multi-node DAG snapshots", () => {
    const parentSessionId = "parent-session";
    const taskPayload = {
      parent_session_id: parentSessionId,
      truncated_tasks: false,
      tasks: [
        {
          task_id: "st_child_one",
          child_session_id: "child-session-1",
          status: "running",
          task_summary: "Inspect implementation",
          name: "inspect",
          category: "deep",
          execution_mode: "in-process",
          model: "test/model",
          run_stats: { runtime_ms: 2000, turns: 2, tool_calls: 1, total_tokens: 1200, output_tokens: 200 },
          live_progress: {
            activity: "reading",
            started_at: 1788393600000,
            current_tool: "read",
            last_assistant_line: "Inspecting",
            turns: 2,
            tool_calls: 1,
          },
          residency_state: "resident",
          depth: 1,
          created_at: "2026-09-03T00:00:00Z",
          updated_at: "2026-09-03T00:00:02Z",
        },
        {
          task_id: "st_child_two",
          child_session_id: "child-session-2",
          status: "pending",
          task_summary: "Verify behavior",
          name: "verify",
          category: "quick",
          execution_mode: "in-process",
          depth: 1,
          created_at: "2026-09-03T00:00:01Z",
          updated_at: "2026-09-03T00:00:01Z",
        },
      ],
    };
    const dagPayload = {
      parent_session_id: parentSessionId,
      truncated_runs: false,
      runs: [{
        run_id: "run-activity",
        run_key: "phase-c",
        name: "Phase C verification",
        status: "running",
        created_at: "2026-09-03T00:00:00Z",
        updated_at: "2026-09-03T00:00:02Z",
        counts: { total: 2, pending: 1, blocked: 0, scheduled: 0, running: 1, completed: 0, failed: 0, cancelled: 0, skipped: 0 },
        nodes: [
          { id: "inspect", label: "Inspect", prompt: "Inspect implementation", depends_on: [], state: "running", attempt: 1, task_id: "st_child_one", started_at: "2026-09-03T00:00:00Z" },
          { id: "verify", label: "Verify", prompt: "Verify behavior", depends_on: ["inspect"], state: "pending", attempt: 0, task_id: "st_child_two" },
        ],
        edges: [{ from: "inspect", to: "verify" }],
        waves: [{ index: 0, node_ids: ["inspect"] }, { index: 1, node_ids: ["verify"] }],
      }],
    };
    const withTasks = applyActivityEvent(emptyActivityState(), "omo.task.updated", taskPayload);
    const activities = applyActivityEvent(withTasks, "omo.dag.updated", dagPayload);

    renderShelf(harness, activities);
    openShelf(harness.container);

    expect(harness.container.querySelectorAll(".th-activity-agent")).toHaveLength(2);
    expect(harness.container.textContent).toContain("Inspecting");
    expect(harness.container.querySelectorAll(".th-activity-dnode")).toHaveLength(2);
    expect(harness.container.textContent).toContain("Phase C verification");
    expect(activities.tasks.get("st_child_one")?.taskSummary).toBe("Inspect implementation");
    expect(activities.tasks.get("st_child_one")?.liveProgress?.currentTool).toBe("read");
    expect(activities.dags.get("run-activity")?.edges).toEqual([{ from: "inspect", to: "verify" }]);
    expect(activities.dags.get("run-activity")?.waves).toEqual([
      { index: 0, nodeIds: ["inspect"] },
      { index: 1, nodeIds: ["verify"] },
    ]);
  });

  it("keeps every DAG node visible when wave metadata omits one", () => {
    renderShelf(harness, activityState({
      dags: [makeDag({ waves: [{ index: 0, nodeIds: ["a", "b"] }] })],
    }));
    openShelf(harness.container);
    const graphBtn = requireElement(
      harness.container.querySelector<HTMLButtonElement>('.th-activity-view-btn[data-view="graph"]'),
      "graph toggle",
    );
    click(graphBtn);

    const graph = requireElement(harness.container.querySelector(".th-activity-graph"), "graph view");
    expect(graph.querySelectorAll(".th-activity-gnode").length).toBe(3);
    expect(graph.querySelector('.th-activity-gnode[data-node="c"]')).not.toBeNull();
  });

  it("toggles the DAG view between list and graph with layered nodes", () => {
    renderShelf(harness, activityState({ dags: [makeDag()] }));
    openShelf(harness.container);
    const graphBtn = requireElement(
      harness.container.querySelector<HTMLButtonElement>('.th-activity-view-btn[data-view="graph"]'),
      "graph toggle",
    );
    expect(graphBtn.getAttribute("aria-pressed")).toBe("false");
    expect(harness.container.querySelector(".th-activity-graph")).toBeNull();
    expect(harness.container.querySelectorAll(".th-activity-dnode").length).toBe(3);
    click(graphBtn);
    expect(graphBtn.getAttribute("aria-pressed")).toBe("true");
    const graph = requireElement(harness.container.querySelector(".th-activity-graph"), "graph view");
    const nodes = graph.querySelectorAll(".th-activity-gnode");
    expect(nodes.length).toBe(3);
    const layerOf = (id: string): string | null =>
      graph.querySelector(`.th-activity-gnode[data-node="${id}"]`)?.getAttribute("data-layer") ?? null;
    expect(layerOf("a")).toBe("0");
    expect(layerOf("b")).toBe("0");
    expect(layerOf("c")).toBe("1");
  });
});
