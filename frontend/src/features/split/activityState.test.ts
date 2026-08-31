import { describe, expect, it } from "vitest";
import { applyActivityEvent, applyRunFlight, emptyActivityState, lifeSeenThisRunOf } from "./activityState";
import { NOW_ISO, dagRun, taskSnapshot } from "./activityState.support";

describe("applyActivityEvent omo.task.updated", () => {
  it("replaces the task map from a full snapshot keyed by task_id", () => {
    const first = applyActivityEvent(
      emptyActivityState(),
      "omo.task.updated",
      taskSnapshot([
        { task_id: "t1", name: "Old", status: "running" },
        { task_id: "t2", name: "Stay", status: "running" },
      ]),
    );

    const next = applyActivityEvent(
      first,
      "omo.task.updated",
      taskSnapshot([
        { task_id: "t2", name: "Stay", status: "running", task_summary: "updated" },
        { task_id: "t3", name: "New", status: "pending" },
      ]),
    );

    expect([...next.tasks.keys()].sort()).toEqual(["t2", "t3"]);
    expect(next.tasks.get("t2")?.taskSummary).toBe("updated");
  });

  it("keeps a terminal task absent from the next snapshot and drops a non-terminal absentee", () => {
    const seeded = applyActivityEvent(
      emptyActivityState(),
      "omo.task.updated",
      taskSnapshot([
        { task_id: "done", name: "Done", status: "completed" },
        { task_id: "live", name: "Live", status: "running" },
        { task_id: "fail", name: "Fail", status: "failed" },
      ]),
    );

    const next = applyActivityEvent(
      seeded,
      "omo.task.updated",
      taskSnapshot([{ task_id: "now", name: "Now", status: "pending" }]),
    );

    expect([...next.tasks.keys()].sort()).toEqual(["done", "fail", "now"]);
    expect(next.tasks.get("live")).toBeUndefined();
  });
});

describe("per-task life latches", () => {
  const inFlightTask = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    task_id: "t1",
    name: "A",
    status: "running",
    updated_at: NOW_ISO,
    ...overrides,
  });

  it("latches life when an in-flight snapshot first contains a task", () => {
    const next = applyActivityEvent(
      applyRunFlight(emptyActivityState(), true),
      "omo.task.updated",
      taskSnapshot([inFlightTask()]),
    );
    expect(lifeSeenThisRunOf(next).has("t1")).toBe(true);
  });

  it("does not latch when an in-flight snapshot repeats a task unchanged", () => {
    // Snapshot re-delivery of an untouched task (goal-loop wake refresh) is
    // not evidence of life: this is the ghost-task false-alarm guard.
    const seeded = applyActivityEvent(
      emptyActivityState(),
      "omo.task.updated",
      taskSnapshot([inFlightTask()]),
    );
    const next = applyActivityEvent(
      applyRunFlight(seeded, true),
      "omo.task.updated",
      taskSnapshot([inFlightTask()]),
    );
    expect(lifeSeenThisRunOf(next).size).toBe(0);
  });

  it("latches life when an in-flight snapshot changes updatedAt, status, or live progress", () => {
    const seeded = applyActivityEvent(
      emptyActivityState(),
      "omo.task.updated",
      taskSnapshot([
        inFlightTask({ task_id: "t-time" }),
        inFlightTask({ task_id: "t-status" }),
        inFlightTask({ task_id: "t-progress", live_progress: { current_tool: "ripgrep" } }),
      ]),
    );
    const next = applyActivityEvent(
      applyRunFlight(seeded, true),
      "omo.task.updated",
      taskSnapshot([
        inFlightTask({ task_id: "t-time", updated_at: "2026-08-19T11:59:30.000Z" }),
        inFlightTask({ task_id: "t-status", status: "completed" }),
        inFlightTask({ task_id: "t-progress", live_progress: { current_tool: "bash", turns: 2 } }),
      ]),
    );
    expect([...lifeSeenThisRunOf(next)].sort()).toEqual(["t-progress", "t-status", "t-time"]);
  });

  it("does not latch snapshot changes while no run is in flight", () => {
    const next = applyActivityEvent(
      emptyActivityState(),
      "omo.task.updated",
      taskSnapshot([inFlightTask({ updated_at: "2026-08-19T11:59:30.000Z" })]),
    );
    expect(lifeSeenThisRunOf(next).size).toBe(0);
  });

  it("latches life when dag activity maps to the task via its taskId", () => {
    const seeded = applyActivityEvent(
      applyRunFlight(emptyActivityState(), true),
      "omo.task.updated",
      taskSnapshot([inFlightTask()]),
    );
    const withDag = applyActivityEvent(seeded, "omo.dag.updated", { runs: [dagRun()] });
    const next = applyActivityEvent(withDag, "omo.dag.activity", {
      runId: "r1",
      nodeId: "n1",
      taskId: "t1",
      at: NOW_ISO,
      activity: "thinking",
    });
    expect(lifeSeenThisRunOf(next).has("t1")).toBe(true);
  });

  it("keeps the latch set reference when nothing new latches", () => {
    const seeded = applyActivityEvent(
      applyRunFlight(emptyActivityState(), true),
      "omo.task.updated",
      taskSnapshot([inFlightTask()]),
    );
    // Same task, same updatedAt/status/live progress: nothing latches, so the
    // latch set keeps its reference (honest version bump).
    const next = applyActivityEvent(seeded, "omo.task.updated", taskSnapshot([inFlightTask()]));
    expect(lifeSeenThisRunOf(next)).toBe(lifeSeenThisRunOf(seeded));
  });
});

describe("unknown activity events", () => {
  it("is a no-op for an unknown event name", () => {
    const state = applyActivityEvent(
      emptyActivityState(),
      "omo.task.updated",
      taskSnapshot([{ task_id: "t1", name: "A", status: "running" }]),
    );
    const next = applyActivityEvent(state, "omo.unknown", { tasks: [] });
    expect(next).toBe(state);
  });

  it("is a no-op when a known event payload is malformed", () => {
    const state = emptyActivityState();
    expect(applyActivityEvent(state, "omo.task.updated", { tasks: "nope" })).toBe(state);
    expect(applyActivityEvent(state, "omo.dag.updated", null)).toBe(state);
    expect(applyActivityEvent(state, "omo.dag.activity", { runId: "r1" })).toBe(state);
    expect(applyActivityEvent(state, "omo.dag.heartbeat", { runs: [] })).toBe(state);
  });
});
