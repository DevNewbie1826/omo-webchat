import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mountActivityShelf,
  renderShelf,
  unmountActivityShelf,
  type ActivityShelfHarness,
} from "./ActivityShelf.support";
import { applyActivityEvent, applyActivityHistorySnapshot, emptyActivityState } from "./activityState";
import { requireElement } from "./chatPaneTestHarness";

/** The scalar-less DAG tab fallback judges RUN-MEMBERSHIP completeness, never
 * graph/node completeness: a run whose nodes were truncated still carries its
 * identity and status, so it counts. Only a genuinely incomplete run list
 * (observed engine contract: the snapshot's run-membership truncation signal)
 * suppresses the slot. Every case flows through the real wire parser and
 * reconciliation reducers into the mounted shelf — no hand-built state. */
describe("ActivityShelf DAG tab run-membership fallback", () => {
  let harness: ActivityShelfHarness;

  beforeEach(() => {
    harness = mountActivityShelf();
  });

  afterEach(async () => {
    await unmountActivityShelf(harness);
  });

  function dagTab(): HTMLButtonElement {
    return requireElement(
      harness.container.querySelector<HTMLButtonElement>('[data-activity-tab="dag"]'),
      "DAG tab",
    );
  }

  function count(): string | null {
    return dagTab().querySelector(".th-activity-tab-count")?.textContent ?? null;
  }

  /** The tab renders exactly its label plus the exact pair, or the label
   * alone — no approximate marker may ever appear. */
  function exactDagSurface(expected: string | null): void {
    expect([...dagTab().querySelectorAll("span")].map(span => span.textContent))
      .toEqual(expected === null ? ["activity.dag"] : ["activity.dag", expected]);
    expect(dagTab().getAttribute("title")).toBeNull();
  }

  const nodeA = { id: "a", prompt: "first step", depends_on: [], state: "running" };

  function wireRun(runId: string, status: string, overrides: Record<string, unknown> = {}) {
    return {
      run_id: runId, run_key: "plan", name: `Graph ${runId}`, status,
      updated_at: "2026-09-09T10:00:00Z",
      counts: { total: 1, running: status === "running" ? 1 : 0, completed: status === "completed" ? 1 : 0 },
      nodes: [nodeA], edges: [], waves: [], ...overrides,
    };
  }

  it.each([
    ["live", applyActivityEvent],
    ["REST", applyActivityHistorySnapshot],
  ] as const)("%s: node-truncated runs with complete run membership render the exact run pair", (_source, apply) => {
    // One running run whose NODE projection is truncated (observed engine
    // behavior: retained node prefix smaller than the advertised total) and
    // one completed run. Both run identities and statuses survive, so the
    // exact answer is 1/2 even though the graph marker is set.
    const state = apply(emptyActivityState(), "omo.dag.updated", {
      truncated_runs: false,
      runs: [
        wireRun("run-live", "running", { truncated_nodes: true, counts: { total: 5, running: 1 } }),
        wireRun("run-done", "completed", { nodes: [], counts: { total: 0, running: 0, completed: 0 } }),
      ],
    });
    // Graph/node completeness markers are untouched by the count fallback:
    // the panel's graph-safety gates keep seeing exactly what they saw before.
    expect(state.truncatedDags).toBe(true);
    expect(state.dags.get("run-live")?.truncated).toBe(true);
    expect(state.dags.size).toBe(2);

    renderShelf(harness, state);
    expect(count()).toBe("1/2");
    exactDagSurface("1/2");
  });

  it.each([
    ["live", applyActivityEvent],
    ["REST", applyActivityHistorySnapshot],
  ] as const)("%s: genuinely incomplete run membership renders no count", (_source, apply) => {
    const state = apply(emptyActivityState(), "omo.dag.updated", {
      truncated_runs: true,
      runs: [wireRun("run-live", "running")],
    });
    expect(state.dags.size).toBe(1);

    renderShelf(harness, state);
    expect(count()).toBeNull();
    exactDagSurface(null);
  });

  it("counts a completed run toward the exact total", () => {
    const state = applyActivityEvent(emptyActivityState(), "omo.dag.updated", {
      truncated_runs: false,
      runs: [
        wireRun("run-done-a", "completed", { nodes: [], counts: { total: 0, running: 0, completed: 0 } }),
        wireRun("run-done-b", "completed", { nodes: [], counts: { total: 0, running: 0, completed: 0 } }),
      ],
    });
    renderShelf(harness, state);
    expect(count()).toBe("0/2");
    exactDagSurface("0/2");
  });

  it("recovers the exact pair when complete membership follows a truncated snapshot", () => {
    let state = applyActivityEvent(emptyActivityState(), "omo.dag.updated", {
      truncated_runs: true,
      runs: [wireRun("run-live", "running")],
    });
    renderShelf(harness, state);
    expect(count()).toBeNull();

    state = applyActivityEvent(state, "omo.dag.updated", {
      truncated_runs: false,
      runs: [
        wireRun("run-live", "running", { updated_at: "2026-09-09T10:01:00Z", truncated_nodes: true, counts: { total: 5, running: 1 } }),
        wireRun("run-done", "completed", { nodes: [], counts: { total: 0, running: 0, completed: 0 } }),
      ],
    });
    renderShelf(harness, state);
    expect(count()).toBe("1/2");
    exactDagSurface("1/2");
  });

  it.each([
    ["live", applyActivityEvent],
    ["REST", applyActivityHistorySnapshot],
  ] as const)("%s: a stale complete snapshot after a newer partial one keeps the slot empty", (_source, apply) => {
    // Partial membership, run r running at 10:02: exactness cannot be
    // established, so nothing renders.
    let state = apply(emptyActivityState(), "omo.dag.updated", {
      truncated_runs: true,
      runs: [wireRun("run-live", "running", { updated_at: "2026-09-09T10:02:00Z" })],
    });
    renderShelf(harness, state);
    expect(count()).toBeNull();
    exactDagSurface(null);

    // A nominally complete snapshot whose only row is OLDER (10:01) is
    // rejected as stale: the retained row stays at 10:02 and the latest
    // ACCEPTED membership is still the partial one, so no count may appear.
    state = apply(state, "omo.dag.updated", {
      truncated_runs: false,
      runs: [wireRun("run-live", "completed", { updated_at: "2026-09-09T10:01:00Z" })],
    });
    expect(state.dags.get("run-live")?.status).toBe("running");
    expect(state.dags.get("run-live")?.updatedAt).toBe("2026-09-09T10:02:00Z");
    renderShelf(harness, state);
    expect(count()).toBeNull();
    exactDagSurface(null);
  });

  it.each([
    ["live", applyActivityEvent],
    ["REST", applyActivityHistorySnapshot],
  ] as const)("%s: a genuinely newer complete membership starts counting", (_source, apply) => {
    let state = apply(emptyActivityState(), "omo.dag.updated", {
      truncated_runs: true,
      runs: [wireRun("run-live", "running", { updated_at: "2026-09-09T10:02:00Z" })],
    });
    renderShelf(harness, state);
    expect(count()).toBeNull();

    // The complete snapshot's row is NEWER (10:03), so the delivery is
    // accepted and its complete membership becomes the authority.
    state = apply(state, "omo.dag.updated", {
      truncated_runs: false,
      runs: [wireRun("run-live", "completed", { updated_at: "2026-09-09T10:03:00Z", nodes: [], counts: { total: 0, running: 0, completed: 0 } })],
    });
    expect(state.dags.get("run-live")?.status).toBe("completed");
    renderShelf(harness, state);
    expect(count()).toBe("0/1");
    exactDagSurface("0/1");
  });

  it.each([
    ["live", applyActivityEvent],
    ["REST", applyActivityHistorySnapshot],
  ] as const)("%s: a rejected stale partial snapshot never revokes accepted complete membership", (_source, apply) => {
    let state = apply(emptyActivityState(), "omo.dag.updated", {
      truncated_runs: false,
      runs: [wireRun("run-live", "running", { updated_at: "2026-09-09T10:02:00Z" })],
    });
    renderShelf(harness, state);
    expect(count()).toBe("1/1");

    // Completeness only moves with accepted membership authority: a stale
    // truncated delivery must not flip the slot back to unknown either.
    state = apply(state, "omo.dag.updated", {
      truncated_runs: true,
      runs: [wireRun("run-live", "running", { updated_at: "2026-09-09T10:01:00Z" })],
    });
    renderShelf(harness, state);
    expect(count()).toBe("1/1");
    exactDagSurface("1/1");
  });
});
