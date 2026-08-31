import { describe, expect, it } from "vitest";
import {
  SEVERED_ACTIVITY_MS,
  STALE_ACTIVITY_MS,
  agentFreshness,
  applyActivityEvent,
  applyRunFlight,
  emptyActivityState,
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

describe("agentFreshness run-in-flight gating", () => {
  it("judges agents fresh while no run is in flight, however old the last update", () => {
    expect(agentFreshness(agentQuietFor(10 * 60_000), NOW_MS, false)).toBe("fresh");
  });

  it("keeps an agent fresh at or under the 30s threshold while a run is in flight", () => {
    expect(agentFreshness(agentQuietFor(STALE_ACTIVITY_MS - 1), NOW_MS, true)).toBe("fresh");
    expect(agentFreshness(agentQuietFor(STALE_ACTIVITY_MS), NOW_MS, true)).toBe("fresh");
  });

  it("judges an agent stale past 30s of quiet only while a run is in flight", () => {
    expect(agentFreshness(agentQuietFor(STALE_ACTIVITY_MS + 1), NOW_MS, true)).toBe("stale");
    expect(agentFreshness(agentQuietFor(STALE_ACTIVITY_MS + 1), NOW_MS, false)).toBe("fresh");
  });

  it("judges an agent severed past 90s of quiet as a distinct state", () => {
    expect(agentFreshness(agentQuietFor(SEVERED_ACTIVITY_MS), NOW_MS, true)).toBe("stale");
    expect(agentFreshness(agentQuietFor(SEVERED_ACTIVITY_MS + 1), NOW_MS, true)).toBe("severed");
    expect(agentFreshness(agentQuietFor(10 * 60_000), NOW_MS, true)).toBe("severed");
  });

  it("never flags terminal agents stale or severed", () => {
    expect(agentFreshness(agentQuietFor(10 * 60_000, "completed"), NOW_MS, true)).toBe("fresh");
    expect(agentFreshness(agentQuietFor(10 * 60_000, "failed"), NOW_MS, true)).toBe("fresh");
  });
});

describe("applyRunFlight", () => {
  it("toggles the run-in-flight flag on the activity state", () => {
    const started = applyRunFlight(emptyActivityState(), true);
    expect(started.runInFlight).toBe(true);
    expect(applyRunFlight(started, false).runInFlight).toBe(false);
  });

  it("keeps the state reference when the flag already matches", () => {
    const idle = emptyActivityState();
    expect(applyRunFlight(idle, false)).toBe(idle);
    const started = applyRunFlight(idle, true);
    expect(applyRunFlight(started, true)).toBe(started);
  });
});
