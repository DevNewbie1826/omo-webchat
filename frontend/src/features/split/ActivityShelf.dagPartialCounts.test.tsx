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
import type { ActivityDagRun } from "./activityTypes";
import { applyActivityEvent, applyActivityHistorySnapshot, emptyActivityState } from "./activityState";
import { parseDagUpdated } from "./activityParseDag";
import { requireElement } from "./chatPaneTestHarness";

function sourceRun(overrides: Partial<ActivityDagRun> = {}): ActivityDagRun {
  return makeDag({
    counts: {
      total: 2, running: 2, completed: 0, pending: 0, blocked: 0,
      scheduled: 0, failed: 0, cancelled: 0, skipped: 0,
    },
    nodes: [
      { id: "a", prompt: "retained child", dependsOn: [], state: "running", taskId: "task-a" },
      { id: "b", prompt: "other child", dependsOn: [], state: "running" },
    ],
    edges: [],
    waves: [],
    ...overrides,
  });
}

/** The Subagents count slot always renders exact running/total numbers.
 * Server task scalars override retained task-row counts; scalar-less inputs
 * use the exact local rows, regardless of history truncation markers. */
describe("ActivityShelf exact DAG-derived Subagents counts", () => {
  let harness: ActivityShelfHarness;

  beforeEach(() => {
    harness = mountActivityShelf();
  });

  afterEach(async () => {
    await unmountActivityShelf(harness);
  });

  function agentsTab(): HTMLButtonElement {
    return requireElement(
      harness.container.querySelector<HTMLButtonElement>('[data-activity-tab="agents"]'),
      "Subagents tab",
    );
  }

  function count(): string | null {
    return agentsTab().querySelector(".th-activity-tab-count")?.textContent ?? null;
  }

  function agentsPanel(): HTMLElement {
    return requireElement(
      harness.container.querySelector<HTMLElement>('[data-activity-tabpanel="agents"]'),
      "Subagents panel",
    );
  }

  it("uses exact local retained counts through partial-to-full DAG updates", () => {
    const full = sourceRun();
    const partial = sourceRun({ nodes: full.nodes.slice(0, 1), truncated: true });
    renderShelf(harness, activityState({ dags: [partial], truncatedDags: true }));

    expect(count()).toBe("1/1");
    expect(agentsTab().getAttribute("title")).toBeNull();
    expect([...harness.container.querySelectorAll("[data-activity-tab]")].map(tab =>
      tab.getAttribute("data-activity-tab"))).toEqual(["todo", "agents", "dag"]);
    click(agentsTab());
    expect(agentsPanel().querySelectorAll(".th-activity-agent")).toHaveLength(1);
    expect(agentsPanel().querySelector(".th-activity-partial")).toBeNull();
    click(agentsTab());
    expect(count()).toBe("1/1");

    renderShelf(harness, activityState({ dags: [full], truncatedDags: false }));
    expect(count()).toBe("2/2");
    expect(agentsTab().getAttribute("title")).toBeNull();
    click(agentsTab());
    expect(agentsPanel().querySelectorAll(".th-activity-agent")).toHaveLength(2);
    expect(agentsPanel().querySelector(".th-activity-partial")).toBeNull();
  });

  it("scales exact local counts for larger retained rosters", () => {
    const retained = Array.from({ length: 12 }, (_unused, index) => ({
      id: `n${index}`, prompt: `child ${index}`, dependsOn: [], state: "running" as const,
    }));
    renderShelf(harness, activityState({
      dags: [sourceRun({
        counts: { ...sourceRun().counts, total: 20, running: 14 },
        nodes: retained,
        truncated: true,
      })],
    }));
    expect(count()).toBe("12/12");
    expect(agentsTab().getAttribute("title")).toBeNull();
  });

  it("keeps exact local counts with a run-local truncation marker", () => {
    renderShelf(harness, activityState({
      dags: [sourceRun({ nodes: sourceRun().nodes.slice(0, 1), truncated: true })],
    }));
    expect(count()).toBe("1/1");
  });

  it.each([
    ["omitted runs", activityState({ truncatedDags: true })],
    ["omitted nodes", activityState({ dags: [sourceRun({ nodes: [], truncated: true })] })],
    ["omitted task rows", activityState({ truncatedTasks: true })],
  ])("renders an empty exact local count slot for %s", (_name, activities) => {
    renderShelf(harness, activities);
    click(agentsTab());
    expect(agentsPanel().querySelector(".th-activity-empty")?.textContent).toBe("activity.emptyAgents");
    expect(count()).toBeNull();
    expect(agentsPanel().querySelector(".th-activity-partial")).toBeNull();
  });

  it("renders exact zero running for retained completed nodes", () => {
    renderShelf(harness, activityState({
      dags: [sourceRun({
        truncated: true,
        counts: { ...sourceRun().counts, total: 3, completed: 1 },
        nodes: [{ id: "done", prompt: "done child", dependsOn: [], state: "completed" }],
      })],
      truncatedDags: true,
    }));
    expect(count()).toBe("0/1");
  });

  it("preserves task status authority and task-ID dedup through partial to full", () => {
    const task = makeTask({ taskId: "task-a", status: "completed", name: "authoritative task" });
    const full = sourceRun();
    renderShelf(harness, activityState({
      tasks: [task], dags: [sourceRun({ nodes: full.nodes.slice(0, 1), truncated: true })],
      truncatedDags: true,
    }));
    click(agentsTab());
    expect(agentsPanel().querySelectorAll(".th-activity-agent")).toHaveLength(1);
    expect(agentsPanel().querySelector(".th-activity-agent")?.textContent).toContain(task.name);
    expect(count()).toBe("0/1");

    renderShelf(harness, activityState({ tasks: [task], dags: [full] }));
    expect(agentsPanel().querySelectorAll(".th-activity-agent")).toHaveLength(2);
    expect(count()).toBe("1/2");
    expect(agentsTab().getAttribute("title")).toBeNull();
    expect(agentsPanel().textContent).not.toContain("retained child");
  });

  it("uses exact task payload scalars as the base and adds deduplicated workflow rows", () => {
    let state = applyActivityHistorySnapshot(emptyActivityState(), "omo.task.updated", {
      truncated_tasks: true,
      running_count: 3,
      total_count: 5,
      tasks: [{
        task_id: "task-a", name: "authoritative task", status: "running",
        updated_at: "2026-09-09T10:00:00Z",
      }],
    });
    state = applyActivityHistorySnapshot(state, "omo.dag.updated", {
      truncated_runs: true,
      runs: [{
        run_id: "scalar-run", run_key: "plan", name: "Scalar graph", status: "running",
        updated_at: "2026-09-09T10:00:00Z", counts: { total: 2, running: 2 },
        nodes: [
          { id: "a", prompt: "task-backed", depends_on: [], state: "running", task_id: "task-a" },
          { id: "b", prompt: "workflow-only", depends_on: [], state: "running" },
        ],
        edges: [], waves: [], truncated_nodes: true,
      }],
    });

    renderShelf(harness, state);
    expect(count()).toBe("4/6");
    expect(agentsTab().getAttribute("title")).toBeNull();
    click(agentsTab());
    expect(agentsPanel().querySelectorAll(".th-activity-agent")).toHaveLength(2);
    expect(agentsPanel().querySelector(".th-activity-partial")).toBeNull();
  });

  describe.each([
    ["live", applyActivityEvent],
    ["REST", applyActivityHistorySnapshot],
  ] as const)("%s raw DAG count boundary", (_source, apply) => {
    const revision = "2026-09-09T10:00:00Z";
    const newer = "2026-09-09T10:01:00Z";
    const nodeA = { id: "a", prompt: "retained child", depends_on: [], state: "running", task_id: "task-a" };
    const nodeB = { id: "b", prompt: "other child", depends_on: [], state: "running" };
    const malformedNode = { id: "b", prompt: "other child", state: "running" };
    function wireRun(overrides: Record<string, unknown> = {}) {
      return {
        run_id: "raw-run", run_key: "plan", name: "Raw graph", status: "running",
        updated_at: revision, counts: { total: 2, running: 2 },
        nodes: [nodeA, nodeB], edges: [], waves: [], ...overrides,
      };
    }
    function snapshot(runs: readonly unknown[]) {
      return { truncated_runs: false, runs };
    }

    describe.each(["running", "completed"] as const)("lossy identity with authoritative %s task", (status) => {
      const taskId = "t".repeat(600) + "a";
      const prefix = taskId.slice(0, 512);
      it.each([
        [false, false], [false, true], [true, false], [true, true],
      ] as const)("does not double count with truncated_nodes=%s and prior exact=%s", (truncated_nodes, priorExact) => {
        const exactNode = { ...nodeA, task_id: taskId };
        const exactRun = wireRun({ nodes: [exactNode], counts: { total: 1, running: 1 } });
        let state = apply(emptyActivityState(), "omo.task.updated", { truncated_tasks: false, tasks: [
          { task_id: taskId, name: "authoritative task", status, updated_at: newer },
        ] });
        const task = state.tasks.get(taskId);
        const exactCount = status === "running" ? "1/1" : "0/1";
        if (priorExact) {
          state = apply(state, "omo.dag.updated", snapshot([exactRun]));
          renderShelf(harness, state);
          expect(count()).toBe(exactCount);
        }
        state = apply(state, "omo.dag.updated", snapshot([{
          ...exactRun, updated_at: newer, truncated_nodes,
          nodes: [{ ...exactNode, task_id: prefix, task_id_truncated: true }],
        }]));
        expect(state.dags.get("raw-run")?.nodes[0]?.taskId).toBeUndefined();
        expect(state.dags.get("raw-run")?.nodes[0]?.taskIdPrefix).toBe(prefix);
        expect(state.tasks.get(taskId)).toBe(task);
        renderShelf(harness, state);
        expect(count()).toBe(exactCount);
        expect(agentsTab().getAttribute("title")).toBeNull();
        click(agentsTab());
        expect(agentsPanel().querySelectorAll(".th-activity-agent")).toHaveLength(1);
        expect(agentsPanel().querySelector(".th-activity-partial")).toBeNull();

        state = apply(state, "omo.dag.updated", snapshot([{
          ...exactRun, updated_at: "2026-09-09T10:02:00Z",
        }]));
        renderShelf(harness, state);
        expect(count()).toBe(exactCount);
        expect(state.dags.get("raw-run")?.nodes[0]?.taskId).toBe(taskId);
        expect(state.dags.get("raw-run")?.nodes[0]?.taskIdPrefix).toBeUndefined();
        expect(state.tasks.get(taskId)).toBe(task);
        expect(agentsTab().getAttribute("title")).toBeNull();
        expect(agentsPanel().querySelectorAll(".th-activity-agent")).toHaveLength(1);
        expect(agentsPanel().querySelector(".th-activity-partial")).toBeNull();
      });
    });

    it.each([
      ["distinct exact ID", { task_id: "different" }],
      ["distinct exact ID sharing a prefix", { task_id: "t".repeat(600) + "b" }],
      ["nonoverlapping lossy prefix", { task_id: "other", task_id_truncated: true }],
      ["plain omission", {}],
    ])("keeps node rows for %s", (_case, identity) => {
      let state = apply(emptyActivityState(), "omo.task.updated", { tasks: [
        { task_id: "t".repeat(600) + "a", name: "task", status: "running", updated_at: newer },
      ] });
      state = apply(state, "omo.dag.updated", snapshot([wireRun({
        nodes: [{ id: "a", prompt: "child", depends_on: [], state: "running", ...identity }],
        counts: { total: 1, running: 1 },
      })]));
      renderShelf(harness, state);
      expect(count()).toBe("2/2");
      expect(agentsTab().getAttribute("title")).toBeNull();
      click(agentsTab());
      expect(agentsPanel().querySelectorAll(".th-activity-agent")).toHaveLength(2);
    });

    it("preserves both exact task rows sharing a prefix and suppresses only ambiguous nodes", () => {
      const prefix = "t".repeat(512);
      const taskIds = [prefix + "a", prefix + "b"];
      let state = apply(emptyActivityState(), "omo.task.updated", { tasks: taskIds.map(task_id => ({
        task_id, name: task_id, status: "running", updated_at: newer,
      })) });
      const nodes = taskIds.map((task_id, index) => ({ ...nodeA, id: `n${index}`, task_id }));
      state = apply(state, "omo.dag.updated", snapshot([wireRun({ nodes })]));
      renderShelf(harness, state);
      expect(count()).toBe("2/2");
      state = apply(state, "omo.dag.updated", snapshot([wireRun({
        updated_at: newer, nodes: nodes.map(node => ({ ...node, task_id: prefix, task_id_truncated: true })),
      })]));
      renderShelf(harness, state);
      expect(count()).toBe("2/2");
      click(agentsTab());
      expect(agentsPanel().querySelectorAll(".th-activity-agent")).toHaveLength(2);
    });

    it.each([
      ["duplicate runs", [wireRun({ nodes: [nodeA], counts: { total: 1, running: 1 } }), wireRun({ nodes: [nodeB], counts: { total: 1, running: 1 } })], null, 0, true],
      ["duplicate nodes", [wireRun({ nodes: [nodeA, nodeA] })], null, 0, false],
      ["conflicting duplicate nodes", [wireRun({ nodes: [nodeA, { ...nodeA, state: "completed" }, nodeB] })], "1/1", 1, false],
      ["malformed duplicate node", [wireRun({ nodes: [nodeA, { id: "a" }, nodeB] })], "1/1", 1, false],
      ["malformed duplicate run", [wireRun(), { run_id: "raw-run" }], null, 0, true],
      ["duplicate runs with different revisions", [wireRun(), wireRun({ updated_at: newer })], null, 0, true],
    ] as const)("quarantines %s through raw parser/reducer/Shelf and recovers exact2", (_case, runs, expected, retained, lostRuns) => {
      const parsed = parseDagUpdated(snapshot(runs));
      let state = apply(emptyActivityState(), "omo.dag.updated", snapshot(runs));
      renderShelf(harness, state);
      expect(count()).toBe(expected);
      expect(parsed?.truncatedRuns).toBe(lostRuns);
      expect(parsed?.runs.every(run => run.truncated === true)).toBe(true);
      expect(state.truncatedDags).toBe(true);
      expect(state.dags.size).toBe(1);
      expect(state.dags.get("raw-run")?.nodes).toHaveLength(retained);
      click(agentsTab());
      expect(agentsPanel().querySelectorAll(".th-activity-agent")).toHaveLength(retained);
      expect(agentsPanel().querySelector(".th-activity-partial")).toBeNull();
      const incumbent = state.dags.get("raw-run");
      state = apply(state, "omo.dag.updated", snapshot([wireRun()]));
      expect(state.dags.get("raw-run")).toBe(incumbent);
      expect(state.truncatedDags).toBe(true);
      state = apply(state, "omo.dag.updated", snapshot([wireRun({ updated_at: "2026-09-09T10:02:00Z" })]));
      renderShelf(harness, state);
      expect(count()).toBe("2/2");
      expect(state.truncatedDags).toBe(false);
      expect(state.dags.get("raw-run")?.nodes.map(node => node.id)).toEqual(["a", "b"]);
      expect(agentsPanel().querySelectorAll(".th-activity-agent")).toHaveLength(2);
    });

    it("keeps distinct exact run and node IDs authoritative", () => {
      const prefix = "x".repeat(512);
      const runs = [wireRun({ run_id: prefix + "a", nodes: [{ ...nodeA, id: prefix + "a", task_id: undefined }], counts: { total: 1, running: 1 } }),
        wireRun({ run_id: prefix + "b", nodes: [{ ...nodeB, id: prefix + "b" }], counts: { total: 1, running: 1 } })];
      const state = apply(emptyActivityState(), "omo.dag.updated", snapshot(runs));
      renderShelf(harness, state);
      expect(state.dags.size).toBe(2);
      expect(state.truncatedDags).toBe(false);
      expect(count()).toBe("2/2");
    });

    it.each([
      ["missing depends_on", [wireRun({ nodes: [nodeA, malformedNode] })], "1/1", 1],
      ["all nodes dropped", [wireRun({ nodes: [malformedNode, null] })], null, 0],
      ["missing nodes", [wireRun({ nodes: undefined })], null, 0],
      ["advertised total exceeds retention", [wireRun({ nodes: [nodeA] })], "1/1", 1],
      ["advertised running exceeds retention", [wireRun({ nodes: [nodeA], counts: { running: 2 } })], "1/1", 1],
      ["run-local truncation with recomputed counts", [wireRun({ nodes: [nodeA], counts: { total: 1, running: 1 }, truncated_nodes: true })], "1/1", 1],
      ["zero-retained run-local truncation", [wireRun({ nodes: [], counts: { total: 0, running: 0 }, truncated_nodes: true })], null, 0],
      ["dropped sibling run", [wireRun({ nodes: [nodeA], counts: { total: 1, running: 1 } }), { run_id: "lost" }], "1/1", 1],
      ["all runs dropped", [{ run_id: "lost" }, null], null, 0],
    ] as const)("renders exact local counts for %s and restores accepted complete2", (_case, runs, expected, retained) => {
      let state = apply(emptyActivityState(), "omo.dag.updated", snapshot(runs));
      renderShelf(harness, state);
      expect(count()).toBe(expected);
      expect(state.truncatedDags).toBe(true);
      click(agentsTab());
      expect(agentsPanel().querySelectorAll(".th-activity-agent")).toHaveLength(retained);
      expect(agentsPanel().querySelector(".th-activity-empty") === null).toBe(retained > 0);
      expect(agentsPanel().querySelector(".th-activity-partial")).toBeNull();

      state = apply(state, "omo.dag.updated", snapshot([wireRun({ updated_at: newer })]));
      renderShelf(harness, state);
      expect(count()).toBe("2/2");
      expect(state.truncatedDags).toBe(false);
      expect(state.dags.get("raw-run")?.truncated).toBe(false);
      expect(agentsPanel().querySelectorAll(".th-activity-agent")).toHaveLength(2);
      expect(agentsPanel().querySelector(".th-activity-partial")).toBeNull();
    });

    it.each(["2026-09-09T09:59:00Z", revision, undefined])("does not contaminate complete authority with rejected partial revision %s", (updated_at) => {
      const complete = apply(emptyActivityState(), "omo.dag.updated", snapshot([wireRun()]));
      for (const overrides of [
        { nodes: [nodeA, malformedNode] },
        { nodes: [], counts: { total: 0, running: 0 }, truncated_nodes: true },
      ]) {
        const stale = apply(complete, "omo.dag.updated", snapshot([wireRun({ ...overrides, updated_at })]));
        expect(stale.dags.get("raw-run")).toBe(complete.dags.get("raw-run"));
        expect(stale.truncatedDags).toBe(false);
        renderShelf(harness, stale);
        expect(count()).toBe("2/2");
      }
    });

    it("does not let equal or older complete replay erase accepted parse loss", () => {
      const partial = apply(emptyActivityState(), "omo.dag.updated", snapshot([wireRun({ nodes: [nodeA, malformedNode] })]));
      for (const updated_at of ["2026-09-09T09:59:00Z", revision, undefined]) {
        const stale = apply(partial, "omo.dag.updated", snapshot([wireRun({ updated_at })]));
        expect(stale.dags.get("raw-run")).toBe(partial.dags.get("raw-run"));
        expect(stale.truncatedDags).toBe(true);
        renderShelf(harness, stale);
        expect(count()).toBe("1/1");
      }
    });

    it("retains omitted known rows when a raw run fails to parse", () => {
      const complete = apply(emptyActivityState(), "omo.dag.updated", snapshot([wireRun()]));
      const lost = apply(complete, "omo.dag.updated", snapshot([{ run_id: "raw-run" }]));
      expect(lost.dags.get("raw-run")).toBe(complete.dags.get("raw-run"));
      expect(lost.truncatedDags).toBe(true);
      renderShelf(harness, lost);
      expect(count()).toBe("2/2");
    });

    it("preserves raw task authority and deduplication through partial to complete", () => {
      let state = apply(emptyActivityState(), "omo.task.updated", { tasks: [
        { task_id: "task-a", name: "authoritative task", status: "completed", updated_at: newer },
      ] });
      state = apply(state, "omo.dag.updated", snapshot([wireRun({ nodes: [nodeA, malformedNode] })]));
      const task = state.tasks.get("task-a");
      expect(task?.status).toBe("completed");
      renderShelf(harness, state);
      expect(count()).toBe("0/1");
      click(agentsTab());
      expect(agentsPanel().querySelectorAll(".th-activity-agent")).toHaveLength(1);

      state = apply(state, "omo.dag.updated", snapshot([wireRun({ updated_at: newer })]));
      expect(state.tasks.get("task-a")).toBe(task);
      renderShelf(harness, state);
      expect(count()).toBe("1/2");
      expect(agentsPanel().querySelectorAll(".th-activity-agent")).toHaveLength(2);
      expect(agentsPanel().querySelector(".th-activity-partial")).toBeNull();
    });

    it("keeps dropped topology local and preserves F1 task identity provenance", () => {
      const prefix = "t".repeat(512);
      const parsed = parseDagUpdated(snapshot([wireRun({
        nodes: [{ ...nodeA, task_id: prefix, task_id_truncated: true }, nodeB],
        edges: [{ from: "a" }], waves: [{ index: 0 }],
      })]));
      expect(parsed?.truncatedRuns).toBe(false);
      expect(parsed?.runs[0]?.truncated).toBe(true);
      expect(parsed?.runs[0]?.nodes[0]?.taskId).toBeUndefined();
      expect(parsed?.runs[0]?.nodes[0]?.taskIdPrefix).toBe(prefix);
      const complete = parseDagUpdated(snapshot([wireRun()]));
      expect(complete?.truncatedRuns).toBe(false);
      expect(complete?.runs[0]?.truncated).not.toBe(true);
      expect(complete?.runs[0]?.nodes[0]?.taskId).toBe("task-a");
      expect(complete?.runs[0]?.nodes[0]?.taskIdPrefix).toBeUndefined();
    });
  });

  it("keeps task-only complete counts exact and authoritative empty content empty", () => {
    renderShelf(harness, activityState({ tasks: [makeTask()] }));
    expect(count()).toBe("1/1");
    renderShelf(harness, activityState({ todo: [] }));
    expect(count()).toBeNull();
    click(agentsTab());
    expect(agentsPanel().querySelector(".th-activity-empty")?.textContent).toBe("activity.emptyAgents");
    expect(agentsPanel().querySelector(".th-activity-partial")).toBeNull();
  });
});
