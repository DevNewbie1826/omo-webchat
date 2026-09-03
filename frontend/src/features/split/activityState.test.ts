import { describe, expect, it } from "vitest";
import {
  ACTIVITY_HYDRATION_SIDE_LIMIT,
  applyActivityEvent,
  applyRunFlight,
  bufferActivityHydrationEvent,
  createActivityHydrationBuffer,
  emptyActivityState,
  lifeSeenThisRunOf,
  validatedActivityEvent,
} from "./activityState";
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

  it("latches life when a pre-existing task first gains live progress", () => {
    const seeded = applyActivityEvent(
      emptyActivityState(),
      "omo.task.updated",
      taskSnapshot([inFlightTask()]),
    );
    const next = applyActivityEvent(
      applyRunFlight(seeded, true),
      "omo.task.updated",
      taskSnapshot([inFlightTask({ live_progress: { current_tool: "ripgrep" } })]),
    );

    expect(lifeSeenThisRunOf(next).has("t1")).toBe(true);
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

describe("activity hydration buffer", () => {
  it("rejects unrelated and malformed activity frames before buffering", () => {
    expect(validatedActivityEvent("unrelated", { tasks: [] })).toBeNull();
    expect(validatedActivityEvent("omo.task.updated", { tasks: "nope" })).toBeNull();

    const buffer = createActivityHydrationBuffer();
    const valid = validatedActivityEvent("omo.task.updated", taskSnapshot([]));
    expect(valid).not.toBeNull();
    bufferActivityHydrationEvent(buffer, valid!);
    expect(buffer.taskSuperseded).toBe(true);
    expect(buffer.events).toHaveLength(1);
  });

  it("bounds each side under distinct-event floods and counts oldest-first drops", () => {
    const buffer = createActivityHydrationBuffer();
    for (let index = 0; index < ACTIVITY_HYDRATION_SIDE_LIMIT + 25; index += 1) {
      const event = validatedActivityEvent("omo.dag.activity", {
        runId: `run-${index}`,
        nodeId: `node-${index}`,
        at: NOW_ISO,
      });
      expect(event).not.toBeNull();
      bufferActivityHydrationEvent(buffer, event!);
    }

    expect(buffer.events).toHaveLength(ACTIVITY_HYDRATION_SIDE_LIMIT);
    expect(buffer.dropped).toBe(25);
    expect(buffer.taskOverflowed).toBe(true);
    expect(buffer.dagOverflowed).toBe(true);
    expect(buffer.events[0]?.key).toContain("run-25:node-25");
  });

  it("coalesces updates for the same activity id while preserving partial fields", () => {
    const buffer = createActivityHydrationBuffer();
    const first = validatedActivityEvent("omo.dag.activity", {
      runId: "run",
      nodeId: "node",
      at: NOW_ISO,
      currentTool: "bash",
    });
    const second = validatedActivityEvent("omo.dag.activity", {
      runId: "run",
      nodeId: "node",
      at: NOW_ISO,
      activity: "working",
    });
    bufferActivityHydrationEvent(buffer, first!);
    bufferActivityHydrationEvent(buffer, second!);

    expect(buffer.events).toHaveLength(1);
    expect(buffer.events[0]?.data).toMatchObject({ currentTool: "bash", activity: "working" });
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
