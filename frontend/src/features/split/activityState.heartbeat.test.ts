import { describe, expect, it } from "vitest";
import {
  SEVERED_ACTIVITY_MS,
  agentFreshness,
  applyActivityEvent,
  applyRunFlight,
  emptyActivityState,
  freshestRunActivityMsOf,
  lifeSeenThisRunOf,
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

describe("freshestRunActivityMsOf", () => {
  it("picks the freshest run activity stamp across all runs", () => {
    const seeded = applyActivityEvent(emptyActivityState(), "omo.dag.updated", {
      runs: [dagRun(), dagRun({ run_id: "r2" })],
    });
    const first = applyActivityEvent(seeded, "omo.dag.activity", {
      runId: "r1",
      nodeId: "n1",
      at: new Date(NOW_MS - 40_000).toISOString(),
    });
    const second = applyActivityEvent(first, "omo.dag.activity", {
      runId: "r2",
      nodeId: "n1",
      at: NOW_ISO,
    });
    expect(freshestRunActivityMsOf(second)).toBe(NOW_MS);
  });

  it("returns null when no run carries an activity stamp", () => {
    const seeded = applyActivityEvent(emptyActivityState(), "omo.dag.updated", { runs: [dagRun()] });
    expect(freshestRunActivityMsOf(seeded)).toBe(null);
    expect(freshestRunActivityMsOf(emptyActivityState())).toBe(null);
  });
});

describe("run-heartbeat corroboration through the reducers", () => {
  it("keeps a latched quiet agent quiet while a run heartbeat is fresh, then severs when it goes stale", () => {
    // Latched agent, quiet past the threshold, with a run-level heartbeat
    // channel built through the real reducers (node activity stamps the run).
    const latched = applyActivityEvent(
      applyRunFlight(emptyActivityState(), true),
      "omo.task.updated",
      taskSnapshot([
        { task_id: "t1", name: "Spawn", status: "running", updated_at: new Date(NOW_MS - SEVERED_ACTIVITY_MS - 1_000).toISOString() },
      ]),
    );
    const withRun = applyActivityEvent(
      applyActivityEvent(latched, "omo.dag.updated", { runs: [dagRun()] }),
      "omo.dag.activity",
      { runId: "r1", nodeId: "n1", at: new Date(NOW_MS - 5_000).toISOString() },
    );
    const task = withRun.tasks.get("t1");
    if (task === undefined) throw new Error("fixture task missing");
    expect(lifeSeenThisRunOf(withRun).has("t1")).toBe(true);
    const context = {
      runInFlight: true,
      lifeSeenThisRun: lifeSeenThisRunOf(withRun),
      freshestRunActivityMs: freshestRunActivityMsOf(withRun),
    };
    expect(agentFreshness(task, NOW_MS, context)).toBe("quiet");

    // Once every run channel is stale too, the silence is corroborated.
    const staleRun = applyActivityEvent(withRun, "omo.dag.activity", {
      runId: "r1",
      nodeId: "n1",
      at: new Date(NOW_MS - SEVERED_ACTIVITY_MS - 1).toISOString(),
    });
    expect(agentFreshness(task, NOW_MS, {
      runInFlight: true,
      lifeSeenThisRun: lifeSeenThisRunOf(staleRun),
      freshestRunActivityMs: freshestRunActivityMsOf(staleRun),
    })).toBe("severed");
  });
});
