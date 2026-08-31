import { describe, expect, it } from "vitest";
import { applyActivityEvent, emptyActivityState } from "./activityState";
import { dagRun, FRESH_AT, taskSnapshot } from "./activityState.support";

describe("applyActivityEvent omo.dag.updated", () => {
  it("replaces the dag map from a full snapshot keyed by run_id", () => {
    const first = applyActivityEvent(emptyActivityState(), "omo.dag.updated", {
      parent_session_id: "sess-1",
      runs: [dagRun(), dagRun({ run_id: "r2", status: "pending" })],
    });
    const next = applyActivityEvent(first, "omo.dag.updated", {
      parent_session_id: "sess-1",
      runs: [dagRun({ run_id: "r2", name: "Renamed", status: "running" })],
    });

    expect([...next.dags.keys()]).toEqual(["r2"]);
    expect(next.dags.get("r2")?.name).toBe("Renamed");
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
    const seeded = applyActivityEvent(emptyActivityState(), "omo.dag.updated", { runs: [dagRun()] });
    const live = applyActivityEvent(seeded, "omo.dag.activity", {
      runId: "r1",
      nodeId: "n1",
      at: FRESH_AT,
      activity: "thinking",
    });
    const next = applyActivityEvent(live, "omo.dag.updated", {
      runs: [dagRun({ nodes: [{ id: "n1", prompt: "do", depends_on: [], state: "running", task_id: "t1" }] })],
    });

    expect(next.dags.get("r1")?.lastActivityAt).toBe(FRESH_AT);
    expect(next.dags.get("r1")?.nodes[0]).toMatchObject({
      taskId: "t1",
      activity: "thinking",
      lastActivityAt: FRESH_AT,
    });
  });
});
