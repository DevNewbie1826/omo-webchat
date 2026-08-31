import { describe, expect, it } from "vitest";
import {
  SEVERED_ACTIVITY_MS,
  STALE_ACTIVITY_MS,
  agentFreshness,
  applyActivityEvent,
  applyRunFlight,
  emptyActivityState,
  lifeSeenThisRunOf,
  type AgentFreshnessContext,
} from "./activityState";
import { NOW_MS, taskSnapshot } from "./activityState.support";

function agentQuietFor(quietMs: number, status = "running") {
  // Built through the real reducer so the task shape matches production state.
  const state = applyActivityEvent(
    emptyActivityState(),
    "omo.task.updated",
    taskSnapshot([
      { task_id: "t1", name: "Spawn", status, updated_at: new Date(NOW_MS - quietMs).toISOString() },
    ]),
  );
  const task = state.tasks.get("t1");
  if (task === undefined) throw new Error("fixture task missing");
  return task;
}

const idle: AgentFreshnessContext = { runInFlight: false, lifeSeenThisRun: new Set() };
const inFlight = (lifeSeen: readonly string[] = []): AgentFreshnessContext => ({
  runInFlight: true,
  lifeSeenThisRun: new Set(lifeSeen),
});

describe("agentFreshness run-in-flight gating", () => {
  it("judges agents fresh while no run is in flight, however old the last update", () => {
    expect(agentFreshness(agentQuietFor(10 * 60_000), NOW_MS, idle)).toBe("fresh");
  });

  it("judges every in-flight non-terminal agent quiet while it is not severed", () => {
    // The 30s stale alarm is gone: short quiet is just quiet, and so is the
    // 30s boundary that used to brand rows.
    expect(agentFreshness(agentQuietFor(1_000), NOW_MS, inFlight())).toBe("quiet");
    expect(agentFreshness(agentQuietFor(STALE_ACTIVITY_MS), NOW_MS, inFlight())).toBe("quiet");
    expect(agentFreshness(agentQuietFor(STALE_ACTIVITY_MS + 1), NOW_MS, inFlight())).toBe("quiet");
    expect(agentFreshness(agentQuietFor(SEVERED_ACTIVITY_MS - 1), NOW_MS, inFlight())).toBe("quiet");
  });

  it("does not sever an agent that showed no life this run, however old it is", () => {
    // Goal-continuation wakes legitimately quiet a task for minutes: without
    // life seen during THIS run there is no death to signal.
    expect(agentFreshness(agentQuietFor(SEVERED_ACTIVITY_MS + 1), NOW_MS, inFlight())).toBe("quiet");
    expect(agentFreshness(agentQuietFor(10 * 60_000), NOW_MS, inFlight())).toBe("quiet");
    expect(agentFreshness(agentQuietFor(70 * 60_000), NOW_MS, inFlight())).toBe("quiet");
  });

  it("severs an agent that showed life this run and then went quiet past 90s", () => {
    expect(agentFreshness(agentQuietFor(SEVERED_ACTIVITY_MS), NOW_MS, inFlight(["t1"]))).toBe("quiet");
    expect(agentFreshness(agentQuietFor(SEVERED_ACTIVITY_MS + 1), NOW_MS, inFlight(["t1"]))).toBe("severed");
    expect(agentFreshness(agentQuietFor(10 * 60_000), NOW_MS, inFlight(["t1"]))).toBe("severed");
  });

  it("never flags terminal agents quiet or severed, even with life seen", () => {
    expect(agentFreshness(agentQuietFor(10 * 60_000, "completed"), NOW_MS, inFlight(["t1"]))).toBe("fresh");
    expect(agentFreshness(agentQuietFor(10 * 60_000, "failed"), NOW_MS, inFlight(["t1"]))).toBe("fresh");
  });
});

describe("applyRunFlight", () => {
  it("toggles the run-in-flight flag on the activity state", () => {
    const started = applyRunFlight(emptyActivityState(), true);
    expect(started.runInFlight).toBe(true);
    expect(applyRunFlight(started, false).runInFlight).toBe(false);
  });

  it("keeps the state reference only when an idle flag already matches", () => {
    const idleState = emptyActivityState();
    expect(applyRunFlight(idleState, false)).toBe(idleState);

    const started = applyRunFlight(idleState, true);
    const repeatedStart = applyRunFlight(started, true);
    expect(repeatedStart).not.toBe(started);
    expect(lifeSeenThisRunOf(repeatedStart).size).toBe(0);
  });

  it("starts every run with an empty life-latch set", () => {
    expect(lifeSeenThisRunOf(applyRunFlight(emptyActivityState(), true)).size).toBe(0);
  });

  it("resets all task life latches when a new run starts", () => {
    const latched = applyActivityEvent(
      applyRunFlight(emptyActivityState(), true),
      "omo.task.updated",
      taskSnapshot([{ task_id: "t1", name: "Spawn", status: "running", updated_at: new Date(NOW_MS - 1_000).toISOString() }]),
    );
    expect(lifeSeenThisRunOf(latched).has("t1")).toBe(true);

    const stopped = applyRunFlight(latched, false);
    const restarted = applyRunFlight(stopped, true);
    expect(lifeSeenThisRunOf(restarted).size).toBe(0);

    // Behaviorally: the previously latched task no longer counts as live.
    const task = restarted.tasks.get("t1");
    if (task === undefined) throw new Error("fixture task missing");
    expect(agentFreshness(task, NOW_MS + 120_000, {
      runInFlight: true,
      lifeSeenThisRun: lifeSeenThisRunOf(restarted),
    })).toBe("quiet");
  });

  it("drops task life latches when a run stops", () => {
    const latched = applyActivityEvent(
      applyRunFlight(emptyActivityState(), true),
      "omo.task.updated",
      taskSnapshot([{ task_id: "t1", name: "Spawn", status: "running", updated_at: new Date(NOW_MS - 1_000).toISOString() }]),
    );

    const stopped = applyRunFlight(latched, false);
    expect(lifeSeenThisRunOf(stopped).size).toBe(0);
  });

  it("clears stale latches when reconnect observes an in-flight run after a missed boundary", () => {
    const runOne = applyActivityEvent(
      applyRunFlight(emptyActivityState(), true),
      "omo.task.updated",
      taskSnapshot([{ task_id: "t1", name: "Spawn", status: "running", updated_at: new Date(NOW_MS - 100_000).toISOString() }]),
    );
    expect(lifeSeenThisRunOf(runOne).has("t1")).toBe(true);

    // The socket missed run.done and run.started between runs. Reconnect only
    // observes the new run's isStreaming=true state.
    const runTwo = applyRunFlight(runOne, true);
    const task = runTwo.tasks.get("t1");
    if (task === undefined) throw new Error("fixture task missing");
    expect(agentFreshness(task, NOW_MS, {
      runInFlight: true,
      lifeSeenThisRun: lifeSeenThisRunOf(runTwo),
    })).toBe("quiet");
  });
});
