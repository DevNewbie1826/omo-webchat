import { describe, expect, it } from "vitest";
import { applyActivityEvent, emptyActivityState } from "./activityState";
import { taskSnapshot } from "./activityState.support";

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
