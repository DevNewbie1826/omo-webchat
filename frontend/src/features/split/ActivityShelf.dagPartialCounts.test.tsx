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
