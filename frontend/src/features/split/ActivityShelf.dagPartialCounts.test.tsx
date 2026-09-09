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

/**
 * Collapsed Subagents count-slot contract under incomplete history. The
 * mobile tab strip cannot carry the localized "Partial history shown"
 * sentence in the count slot (it painted past its own button and over the
 * neighboring DAG tab at 390x844), so the slot shows a compact
 * machine-consumed qualifier: a confirmed running lower bound `N+` when at
 * least one retained row is running, otherwise `?` — zero retained running
 * must never read as an exact empty field. Complete data keeps the exact
 * `running/total` format. The localized explanation stays in the panel and
 * on the tab's accessible title.
 */
describe("ActivityShelf partial DAG-derived Subagents counts", () => {
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

  it("qualifies source running2/retained1/truncatedDags with the confirmed lower bound and restores exact full2", () => {
    const full = sourceRun();
    const partial = sourceRun({ nodes: full.nodes.slice(0, 1), truncated: true });
    renderShelf(harness, activityState({ dags: [partial], truncatedDags: true }));

    expect(count()).toBe("1+");
    expect(agentsTab().getAttribute("title")).toBe("activity.partial");
    expect([...harness.container.querySelectorAll("[data-activity-tab]")].map(tab =>
      tab.getAttribute("data-activity-tab"))).toEqual(["todo", "agents", "dag"]);
    click(agentsTab());
    expect(agentsPanel().querySelectorAll(".th-activity-agent")).toHaveLength(1);
    expect(agentsPanel().querySelector(".th-activity-partial")?.textContent).toBe("activity.partial");
    click(agentsTab());
    expect(count()).toBe("1+");

    renderShelf(harness, activityState({ dags: [full], truncatedDags: false }));
    expect(count()).toBe("2/2");
    expect(agentsTab().getAttribute("title")).toBeNull();
    click(agentsTab());
    expect(agentsPanel().querySelectorAll(".th-activity-agent")).toHaveLength(2);
    expect(agentsPanel().querySelector(".th-activity-partial")).toBeNull();
  });

  it("scales the confirmed lower bound for larger known running counts", () => {
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
    expect(count()).toBe("12+");
    expect(agentsTab().getAttribute("title")).toBe("activity.partial");
  });

  it("qualifies a run-local truncated marker without the aggregate marker", () => {
    renderShelf(harness, activityState({
      dags: [sourceRun({ nodes: sourceRun().nodes.slice(0, 1), truncated: true })],
    }));
    expect(count()).toBe("1+");
  });

  it.each([
    ["omitted runs", activityState({ truncatedDags: true })],
    ["omitted nodes", activityState({ dags: [sourceRun({ nodes: [], truncated: true })] })],
    ["omitted task rows", activityState({ truncatedTasks: true })],
  ])("does not certify no agents from %s", (_name, activities) => {
    renderShelf(harness, activities);
    click(agentsTab());
    expect(agentsPanel().querySelector(".th-activity-empty")).toBeNull();
    expect(count()).toBe("?");
    expect(agentsPanel().querySelector(".th-activity-partial")?.textContent).toBe("activity.partial");
  });

  it("does not certify zero running from only retained completed nodes", () => {
    renderShelf(harness, activityState({
      dags: [sourceRun({
        truncated: true,
        counts: { ...sourceRun().counts, total: 3, completed: 1 },
        nodes: [{ id: "done", prompt: "done child", dependsOn: [], state: "completed" }],
      })],
      truncatedDags: true,
    }));
    expect(count()).toBe("?");
    expect(count()).not.toContain("0");
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
    expect(count()).toBe("?");

    renderShelf(harness, activityState({ tasks: [task], dags: [full] }));
    expect(agentsPanel().querySelectorAll(".th-activity-agent")).toHaveLength(2);
    expect(count()).toBe("1/2");
    expect(agentsTab().getAttribute("title")).toBeNull();
    expect(agentsPanel().textContent).not.toContain("retained child");
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

    it.each([
      ["missing depends_on", [wireRun({ nodes: [nodeA, malformedNode] })], "1+", 1],
      ["all nodes dropped", [wireRun({ nodes: [malformedNode, null] })], "?", 0],
      ["missing nodes", [wireRun({ nodes: undefined })], "?", 0],
      ["advertised total exceeds retention", [wireRun({ nodes: [nodeA] })], "1+", 1],
      ["advertised running exceeds retention", [wireRun({ nodes: [nodeA], counts: { running: 2 } })], "1+", 1],
      ["run-local truncation with recomputed counts", [wireRun({ nodes: [nodeA], counts: { total: 1, running: 1 }, truncated_nodes: true })], "1+", 1],
      ["zero-retained run-local truncation", [wireRun({ nodes: [], counts: { total: 0, running: 0 }, truncated_nodes: true })], "?", 0],
      ["dropped sibling run", [wireRun({ nodes: [nodeA], counts: { total: 1, running: 1 } }), { run_id: "lost" }], "1+", 1],
      ["all runs dropped", [{ run_id: "lost" }, null], "?", 0],
    ] as const)("qualifies %s and restores accepted complete2", (_case, runs, expected, retained) => {
      let state = apply(emptyActivityState(), "omo.dag.updated", snapshot(runs));
      renderShelf(harness, state);
      expect(count()).toBe(expected);
      expect(state.truncatedDags).toBe(true);
      click(agentsTab());
      expect(agentsPanel().querySelectorAll(".th-activity-agent")).toHaveLength(retained);
      expect(agentsPanel().querySelector(".th-activity-empty")).toBeNull();
      expect(agentsPanel().querySelector(".th-activity-partial")).not.toBeNull();

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
        expect(count()).toBe("1+");
      }
    });

    it("retains omitted known rows when a raw run fails to parse", () => {
      const complete = apply(emptyActivityState(), "omo.dag.updated", snapshot([wireRun()]));
      const lost = apply(complete, "omo.dag.updated", snapshot([{ run_id: "raw-run" }]));
      expect(lost.dags.get("raw-run")).toBe(complete.dags.get("raw-run"));
      expect(lost.truncatedDags).toBe(true);
      renderShelf(harness, lost);
      expect(count()).toBe("2+");
    });

    it("preserves raw task authority and deduplication through partial to complete", () => {
      let state = apply(emptyActivityState(), "omo.task.updated", { tasks: [
        { task_id: "task-a", name: "authoritative task", status: "completed", updated_at: newer },
      ] });
      state = apply(state, "omo.dag.updated", snapshot([wireRun({ nodes: [nodeA, malformedNode] })]));
      const task = state.tasks.get("task-a");
      expect(task?.status).toBe("completed");
      renderShelf(harness, state);
      expect(count()).toBe("?");
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
