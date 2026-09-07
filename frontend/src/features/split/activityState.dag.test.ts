import { describe, expect, it } from "vitest";
import { applyActivityEvent, applyActivityHistorySnapshot, applyRunFlight, emptyActivityState } from "./activityState";
import { parseDagUpdated, parseDagUpdatedAt } from "./activityParseDag";
import { dagRun, FRESH_AT, orderingDagRun, taskSnapshot, UNKNOWN_DAG_TIMESTAMPS } from "./activityState.support";

describe("applyActivityEvent omo.dag.updated", () => {
  it("replaces the dag map from a full snapshot keyed by run_id", () => {
    const first = applyActivityEvent(emptyActivityState(), "omo.dag.updated", {
      parent_session_id: "sess-1",
      runs: [dagRun(), dagRun({ run_id: "r2", status: "pending", updated_at: "2026-09-07T10:01:00Z" })],
    });
    const next = applyActivityEvent(first, "omo.dag.updated", {
      parent_session_id: "sess-1",
      runs: [dagRun({ run_id: "r2", name: "Renamed", status: "running", updated_at: "2026-09-07T10:02:00Z" })],
    });

    expect([...next.dags.keys()]).toEqual(["r2"]);
    expect(next.dags.get("r2")?.name).toBe("Renamed");
    expect(next.dags.get("r2")?.status).toBe("running");
    expect(next.dags.get("r2")?.updatedAt).toBe("2026-09-07T10:02:00Z");
    expect(next.dags.get("r2")?.nodes[0]?.id).toBe("n1");
    expect(next.dags.get("r2")?.waves[0]?.nodeIds).toEqual(["n1"]);
    expect(next.dags.get("r2")?.parentSessionId).toBe("sess-1");
  });

  it("keeps a terminal run absent from the next snapshot and drops a non-terminal absentee", () => {
    const seeded = applyActivityEvent(emptyActivityState(), "omo.dag.updated", {
      runs: [
        dagRun({ run_id: "done", status: "completed" }),
        dagRun({ run_id: "live", status: "running" }),
        dagRun({ run_id: "paused", status: "paused" }),
      ],
    });
    const next = applyActivityEvent(seeded, "omo.dag.updated", {
      runs: [dagRun({ run_id: "now", status: "pending" })],
    });

    expect([...next.dags.keys()].sort()).toEqual(["done", "now"]);
  });
});

describe("applyActivityEvent omo.dag.activity", () => {
  it("merges camelCase live progress into the matching node and sets lastActivityAt", () => {
    const seeded = applyActivityEvent(emptyActivityState(), "omo.dag.updated", {
      runs: [dagRun({ nodes: [{ id: "n1", prompt: "do", depends_on: [], state: "running" }, { id: "n2", prompt: "next", depends_on: ["n1"], state: "pending" }] })],
    });
    const withTask = applyActivityEvent(
      seeded,
      "omo.task.updated",
      taskSnapshot([{ task_id: "t9", name: "Node work", status: "running" }]),
    );

    const next = applyActivityEvent(withTask, "omo.dag.activity", {
      runId: "r1",
      nodeId: "n2",
      taskId: "t9",
      at: FRESH_AT,
      activity: "tool",
      currentTool: "bash",
      lastAssistantLine: "ok",
      turns: 3,
      toolCalls: 1,
    });

    const node = next.dags.get("r1")?.nodes.find((item) => item.id === "n2");
    expect(node).toMatchObject({
      id: "n2",
      taskId: "t9",
      activity: "tool",
      currentTool: "bash",
      lastAssistantLine: "ok",
      turns: 3,
      toolCalls: 1,
      lastActivityAt: FRESH_AT,
    });
    expect(next.dags.get("r1")?.lastActivityAt).toBe(FRESH_AT);
    expect(next.tasks.get("t9")?.liveProgress).toMatchObject({
      activity: "tool",
      currentTool: "bash",
      lastAssistantLine: "ok",
      turns: 3,
      toolCalls: 1,
    });
  });

  // Regression (round-3b review blocker): a dag.activity heartbeat refreshes
  // the matched task's liveProgress but must also stamp updatedAt, because the
  // shelf's taskId dedup drops the fresher node projection in favour of the
  // task row - a reporting, deduplicated child would otherwise render stale.
  it("stamps the matched task's updatedAt from the dag.activity heartbeat", () => {
    const seeded = applyActivityEvent(emptyActivityState(), "omo.dag.updated", {
      runs: [dagRun()],
    });
    const withTask = applyActivityEvent(
      seeded,
      "omo.task.updated",
      taskSnapshot([{ task_id: "t9", name: "Node work", status: "running", updated_at: "2026-08-19T10:00:00.000Z" }]),
    );

    const next = applyActivityEvent(withTask, "omo.dag.activity", {
      runId: "r1",
      nodeId: "n1",
      taskId: "t9",
      at: FRESH_AT,
      activity: "tool",
      currentTool: "bash",
    });

    expect(next.tasks.get("t9")?.updatedAt).toBe(FRESH_AT);
  });

  it("preserves merged lastActivityAt when a later snapshot still contains the node", () => {
    const seeded = applyActivityEvent(emptyActivityState(), "omo.dag.updated", {
      runs: [dagRun({ updated_at: "2026-08-19T11:58:00Z" })],
    });
    const live = applyActivityEvent(seeded, "omo.dag.activity", {
      runId: "r1",
      nodeId: "n1",
      at: FRESH_AT,
      activity: "thinking",
    });
    const next = applyActivityEvent(live, "omo.dag.updated", {
      runs: [dagRun({ updated_at: "2026-08-19T12:00:00Z", nodes: [{ id: "n1", prompt: "do", depends_on: [], state: "running", task_id: "t1" }] })],
    });

    expect(next.dags.get("r1")?.lastActivityAt).toBe(FRESH_AT);
    expect(next.dags.get("r1")?.nodes[0]).toMatchObject({
      taskId: "t1",
      activity: "thinking",
      lastActivityAt: FRESH_AT,
    });
  });
});

describe("DAG ordering lifecycle PIN", () => {
  it("parent start and done preserve completed DAG state", () => {
    const completed = applyActivityEvent(emptyActivityState(), "omo.dag.updated", {
      runs: [orderingDagRun("2026-09-07T10:02:00.000Z")],
    });
    const started = applyRunFlight(completed, true);
    expect(started.dags).toBe(completed.dags);
    expect(applyRunFlight(started, false).dags).toBe(completed.dags);
  });

  it("a strictly newer restart replaces completion and attempts as a unit", () => {
    const completed = applyActivityEvent(emptyActivityState(), "omo.dag.updated", {
      runs: [orderingDagRun("2026-09-07T10:02:00.000Z")],
    });
    const restarted = applyActivityEvent(completed, "omo.dag.updated", {
      runs: [orderingDagRun("2026-09-07T10:03:00.000Z", "running")],
    });
    expect(restarted.dags.get("ordering-run")).toMatchObject({
      status: "running", updatedAt: "2026-09-07T10:03:00.000Z",
      counts: { total: 1, running: 1, completed: 0 }, nodes: [{ state: "running", attempt: 2 }],
    });
  });
});

describe("DAG snapshot freshness", () => {
  const known = "2026-09-07T10:02:00.123Z";
  it.each([
    ["older", known, "2026-09-07T10:01:00.000Z", false],
    ["equal", known, known, false],
    ["equivalent offset", known, "2026-09-07T12:32:00.123+02:30", false],
    ["equal submillisecond", known, "2026-09-07T10:02:00.123999Z", false],
    ["newer offset", known, "2026-09-07T09:03:00.000-01:00", true],
    ["known beats missing", known, undefined, false],
    ["known beats empty", known, "", false],
    ["known beats invalid", known, "invalid", false],
    ["invalid calendar", known, "2026-02-30T10:03:00Z", false],
    ["timezone missing", known, "2026-09-07T10:03:00", false],
    ["invalid offset", known, "2026-09-07T10:03:00+24:00", false],
    ["invalid hour", known, "2026-09-07T24:00:00Z", false],
    ["invalid leap second", known, "2026-09-07T10:03:60Z", false],
    ["missing yields to known", undefined, known, true],
    ["invalid yields to known", "invalid", known, true],
    ["both missing legacy", undefined, undefined, true],
    ["both invalid legacy", "invalid", "also-invalid", true],
    ["both unknown mixed legacy", "", undefined, true],
  ])("%s", (_case, currentAt, incomingAt, accept) => {
    const seeded = applyActivityEvent(emptyActivityState(), "omo.dag.updated", {
      runs: [orderingDagRun(currentAt)],
    });
    const next = applyActivityEvent(seeded, "omo.dag.updated", {
      runs: [orderingDagRun(incomingAt, "running", { edges: [{ from: "n1", to: "n1" }], waves: [] })],
    });
    if (accept) {
      expect(next.dags.get("ordering-run")).toMatchObject({
        status: "running", counts: { completed: 0, running: 1 },
        nodes: [{ state: "running", attempt: 2 }], edges: [{ from: "n1", to: "n1" }], waves: [],
      });
      expect(next.dags.get("ordering-run")?.updatedAt).toBe(incomingAt);
    } else {
      expect(next.dags.get("ordering-run")).toBe(seeded.dags.get("ordering-run"));
    }
  });

  it("selects mixed identities independently without rolling completion backward", () => {
    const seeded = applyActivityEvent(emptyActivityState(), "omo.dag.updated", {
      runs: [orderingDagRun(known), orderingDagRun(known, "running", { run_id: "other" })],
    });
    const next = applyActivityEvent(seeded, "omo.dag.updated", {
      runs: [orderingDagRun("2026-09-07T10:01:00Z", "running"), orderingDagRun("2026-09-07T10:03:00Z", "completed", { run_id: "other" })],
    });
    expect(next.dags.get("ordering-run")).toBe(seeded.dags.get("ordering-run"));
    expect(next.dags.get("other")?.status).toBe("completed");
  });

  it.each([false, true])("live omission honors truncated_runs=%s", (truncated) => {
    const seeded = applyActivityEvent(emptyActivityState(), "omo.dag.updated", {
      runs: [orderingDagRun(known), orderingDagRun(known, "running", { run_id: "other" })],
    });
    const next = applyActivityEvent(seeded, "omo.dag.updated", { runs: [], truncated_runs: truncated });
    expect(next.dags.has("ordering-run")).toBe(true);
    expect(next.dags.has("other")).toBe(truncated);
    expect(next.truncatedDags).toBe(truncated);
  });

  it.each(["live", "REST"])("retains freshness after %s membership removal", (source) => {
    const seeded = applyActivityEvent(emptyActivityState(), "omo.dag.updated", {
      runs: [orderingDagRun(known, source === "live" ? "running" : "completed")],
    });
    const removed = source === "live"
      ? applyActivityEvent(seeded, "omo.dag.updated", { runs: [] })
      : applyActivityHistorySnapshot(seeded, "omo.dag.updated", { runs: [] });
    expect(removed.dags.size).toBe(0);
    for (const at of ["2026-09-07T10:01:00Z", known, undefined]) {
      expect(applyActivityEvent(removed, "omo.dag.updated", { runs: [orderingDagRun(at, "running")] }).dags.size).toBe(0);
      expect(applyActivityHistorySnapshot(removed, "omo.dag.updated", { runs: [orderingDagRun(at, "running")] }).dags.size).toBe(0);
    }
    expect(applyActivityEvent(removed, "omo.dag.updated", {
      runs: [orderingDagRun("2026-09-07T10:03:00Z", "running")],
    }).dags.get("ordering-run")?.status).toBe("running");
  });

  it("progress and heartbeats preserve snapshot freshness and matching overlays on a newer partial graph", () => {
    let state = applyActivityEvent(emptyActivityState(), "omo.dag.updated", {
      runs: [orderingDagRun(known, "running", {
        nodes: [
          { id: "n1", prompt: "one", depends_on: [], state: "running" },
          { id: "n2", prompt: "two", depends_on: ["n1"], state: "pending" },
        ], counts: { total: 2, running: 1, pending: 1 },
        edges: [{ from: "n1", to: "n2" }], waves: [{ index: 0, node_ids: ["n1"] }, { index: 1, node_ids: ["n2"] }],
      })],
    });
    state = applyActivityEvent(state, "omo.dag.activity", {
      runId: "ordering-run", nodeId: "n1", at: "2026-09-07T11:00:00Z", activity: "thinking",
    });
    state = applyActivityEvent(state, "omo.dag.heartbeat", {
      at: "2026-09-07T11:01:00Z", runs: [{ runId: "ordering-run", headSeq: 99 }],
    });
    expect(state.dags.get("ordering-run")?.updatedAt).toBe(known);
    const next = applyActivityEvent(state, "omo.dag.updated", {
      truncated_runs: true, runs: [orderingDagRun("2026-09-07T10:03:00Z")],
    });
    expect(next.dags.get("ordering-run")).toMatchObject({
      status: "completed", counts: { total: 1, completed: 1, pending: 0, running: 0 },
      nodes: [{ id: "n1", state: "completed", activity: "thinking" }],
      edges: [], waves: [{ index: 0, nodeIds: ["n1"] }],
    });
    expect(next.dags.get("ordering-run")?.nodes).toHaveLength(1);
    expect(next.truncatedDags).toBe(true);
    const stale = applyActivityEvent(next, "omo.dag.updated", { truncated_runs: true, runs: [orderingDagRun(known, "running")] });
    expect(stale.dags.get("ordering-run")).toBe(next.dags.get("ordering-run"));
  });
  it("newer oversized partial rows reject stale bounded replay without losing their partial marker", () => {
    const oversized = orderingDagRun("2026-09-07T10:03:00Z", "completed", {
      nodes: [{ id: "n1", prompt: "x".repeat(70_000), depends_on: [], state: "completed" }],
    });
    expect(JSON.stringify(oversized).length).toBeGreaterThan(64 * 1024);
    const partial = applyActivityEvent(emptyActivityState(), "omo.dag.updated", { runs: [oversized], truncated_runs: true });
    const stale = applyActivityEvent(partial, "omo.dag.updated", {
      runs: [orderingDagRun("2026-09-07T10:02:00Z", "running")], truncated_runs: false,
    });
    expect(stale.dags.get("ordering-run")).toBe(partial.dags.get("ordering-run"));
    expect(stale.truncatedDags).toBe(true);
    const complete = applyActivityEvent(stale, "omo.dag.updated", {
      runs: [orderingDagRun("2026-09-07T10:04:00Z", "running")], truncated_runs: false,
    });
    expect(complete.truncatedDags).toBe(false);
    expect(complete.dags.get("ordering-run")?.status).toBe("running");
  });

});

describe("DAG timestamp parser membership", () => {
  it.each(UNKNOWN_DAG_TIMESTAMPS)("$label preserves a valid row with unknown freshness", ({ value }) => {
    const parsed = parseDagUpdated({ runs: [orderingDagRun(value)] });
    expect(parsed?.runs).toHaveLength(1);
    expect(parsed?.runs[0]?.runId).toBe("ordering-run");
    expect(parsed?.runs[0]?.updatedAt).toBe(typeof value === "string" ? value : undefined);
    expect(parseDagUpdatedAt(parsed?.runs[0]?.updatedAt)).toBeUndefined();
  });

  it.each([
    { run_id: null }, { run_key: 42 }, { name: false }, { status: [] },
    { created_at: null }, { counts: { total: "one" } },
    { nodes: {} }, { edges: false }, { waves: 42 },
  ])("still drops a genuinely malformed row: %j", (overrides) => {
    const parsed = parseDagUpdated({ runs: [dagRun({ updated_at: null, ...overrides })] });
    expect(parsed?.runs).toEqual([]);
  });
});

describe.each(["live", "REST"] as const)("%s unknown timestamp membership", (source) => {
  const apply = source === "live" ? applyActivityEvent : applyActivityHistorySnapshot;
  const known = "2026-09-07T10:02:00.000Z";

  describe.each([false, true])("truncated_runs=%s", (truncated) => {
    describe.each(["running", "completed"])("known %s incumbent", (status) => {
      it.each(UNKNOWN_DAG_TIMESTAMPS)("$label cannot remove or replace it, including equal replay", ({ value }) => {
        const row = orderingDagRun(known, status);
        const seeded = applyActivityEvent(emptyActivityState(), "omo.dag.updated", { runs: [row] });
        const incumbent = seeded.dags.get("ordering-run");
        const next = apply(seeded, "omo.dag.updated", {
          runs: [orderingDagRun(value, status === "running" ? "completed" : "running")], truncated_runs: truncated,
        });
        expect(next.dags.size).toBe(1);
        expect(next.dags.get("ordering-run")).toBe(incumbent);
        expect(next.dagFreshness?.get("ordering-run")).toBe(Date.parse(known));
        for (const replay of [applyActivityEvent, applyActivityHistorySnapshot]) {
          const equal = replay(next, "omo.dag.updated", { runs: [row] });
          expect(equal.dags.size).toBe(1);
          expect(equal.dags.get("ordering-run")).toBe(incumbent);
        }
      });
    });

    it.each(UNKNOWN_DAG_TIMESTAMPS)("$label admits unknown-only rows, preserves legacy arrival order, then yields to known", ({ value }) => {
      const first = apply(emptyActivityState(), "omo.dag.updated", {
        runs: [orderingDagRun(value)], truncated_runs: truncated,
      });
      expect(first.dags.get("ordering-run")).toMatchObject({
        status: "completed", counts: { completed: 1, running: 0 }, nodes: [{ state: "completed", attempt: 1 }],
        truncated,
      });
      expect(first.dagFreshness?.size).toBe(0);
      const next = apply(first, "omo.dag.updated", {
        runs: [orderingDagRun(value, "running")], truncated_runs: truncated,
      });
      expect(next.dags.get("ordering-run")).toMatchObject({
        status: "running", counts: { completed: 0, running: 1 }, nodes: [{ state: "running", attempt: 2 }],
      });
      expect(next.dagFreshness?.size).toBe(0);
      const authoritative = apply(next, "omo.dag.updated", { runs: [orderingDagRun(known)] });
      expect(authoritative.dags.get("ordering-run")).toMatchObject({ status: "completed", updatedAt: known });
      expect(authoritative.dagFreshness?.get("ordering-run")).toBe(Date.parse(known));
    });
  });
});
