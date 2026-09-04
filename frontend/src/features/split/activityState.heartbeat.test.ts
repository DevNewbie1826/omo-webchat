import { describe, expect, it } from "vitest";
import {
  SEVERED_ACTIVITY_MS,
  agentFreshness,
  applyActivityEvent,
  applyRunFlight,
  emptyActivityState,
  lifeSeenThisRunOf,
  runActivityMsByTaskOf,
  type AgentFreshnessContext,
} from "./activityState";
import { NOW_MS, dagRun, NOW_ISO, taskSnapshot } from "./activityState.support";

describe("heartbeat staleness selector", () => {
  it("records the latest heartbeat snapshot without discarding dag runs", () => {
    const seeded = applyActivityEvent(emptyActivityState(), "omo.dag.updated", {
      runs: [dagRun(), dagRun({ run_id: "r2", status: "running" })],
    });
    const next = applyActivityEvent(seeded, "omo.dag.heartbeat", {
      at: NOW_ISO,
      runs: [{ runId: "r1", headSeq: 4 }],
    });

    expect(next.dags.size).toBe(2);
    expect(next.heartbeats.get("r1")).toEqual({ runId: "r1", headSeq: 4, at: NOW_ISO });
    expect(next.heartbeats.has("r2")).toBe(false);
  });

});

describe("runActivityMsByTaskOf", () => {
  it("maps each node's taskId to its own run's activity stamp", () => {
    const seeded = applyActivityEvent(emptyActivityState(), "omo.dag.updated", {
      runs: [dagRun(), dagRun({ run_id: "r2" })],
    });
    const first = applyActivityEvent(seeded, "omo.dag.activity", {
      runId: "r1",
      nodeId: "n1",
      taskId: "t1",
      at: new Date(NOW_MS - 40_000).toISOString(),
    });
    const second = applyActivityEvent(first, "omo.dag.activity", {
      runId: "r2",
      nodeId: "n1",
      at: NOW_ISO,
    });
    // The unrelated run's fresher stamp must not touch t1's own-run entry.
    expect(runActivityMsByTaskOf(second).get("t1")).toBe(NOW_MS - 40_000);
  });

  it("returns an empty map when no run carries an activity stamp", () => {
    const seeded = applyActivityEvent(emptyActivityState(), "omo.dag.updated", { runs: [dagRun()] });
    expect(runActivityMsByTaskOf(seeded).size).toBe(0);
    expect(runActivityMsByTaskOf(emptyActivityState()).size).toBe(0);
  });
});

describe("own-run severance corroboration through the reducers", () => {
  it("severs a member agent only once its own run is stale too, and never a non-member", () => {
    // Latched agents, quiet past the threshold, with run activity stamps
    // built through the real reducers (node activity stamps the run and maps
    // the node's taskId).
    const latched = applyActivityEvent(
      applyRunFlight(emptyActivityState(), true),
      "omo.task.updated",
      taskSnapshot([
        { task_id: "t1", name: "Spawn", status: "running", updated_at: new Date(NOW_MS - SEVERED_ACTIVITY_MS - 1_000).toISOString() },
        { task_id: "solo", name: "Unmapped", status: "running", updated_at: new Date(NOW_MS - SEVERED_ACTIVITY_MS - 1_000).toISOString() },
      ]),
    );
    const withRun = applyActivityEvent(
      applyActivityEvent(
        latched,
        "omo.dag.updated",
        { runs: [dagRun(), dagRun({ run_id: "r2", name: "Other" })] },
      ),
      "omo.dag.activity",
      { runId: "r1", nodeId: "n1", taskId: "t1", at: new Date(NOW_MS - SEVERED_ACTIVITY_MS - 1).toISOString() },
    );
    const task = withRun.tasks.get("t1");
    if (task === undefined) throw new Error("fixture task missing");
    const solo = withRun.tasks.get("solo");
    if (solo === undefined) throw new Error("fixture task missing");
    expect(lifeSeenThisRunOf(withRun).has("t1")).toBe(true);
    const contextOf = (state: typeof withRun): AgentFreshnessContext => ({
      runInFlight: true,
      lifeSeenThisRun: lifeSeenThisRunOf(state),
      runActivityMsByTask: runActivityMsByTaskOf(state),
    });
    // No dag run contains "solo": its silence alone never severs it, even
    // though the run that contains t1 is stale past the threshold.
    expect(agentFreshness(solo, NOW_MS, contextOf(withRun))).toBe("quiet");

    // t1's own run is stale too: severed.
    expect(agentFreshness(task, NOW_MS, contextOf(withRun))).toBe("severed");

    // An unrelated run pulsing fresh changes nothing for t1: its own run
    // decides.
    const otherRunFresh = applyActivityEvent(withRun, "omo.dag.activity", {
      runId: "r2",
      nodeId: "n1",
      at: NOW_ISO,
    });
    expect(agentFreshness(task, NOW_MS, contextOf(otherRunFresh))).toBe("severed");

    // Once the row's own run pulses fresh again, the row is only quiet.
    const ownRunFresh = applyActivityEvent(withRun, "omo.dag.activity", {
      runId: "r1",
      nodeId: "n1",
      taskId: "t1",
      at: new Date(NOW_MS - 5_000).toISOString(),
    });
    expect(agentFreshness(task, NOW_MS, contextOf(ownRunFresh))).toBe("quiet");
  });
});
