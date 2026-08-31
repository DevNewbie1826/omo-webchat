import { describe, expect, it } from "vitest";
import { applyActivityEvent, emptyActivityState } from "./activityState";
import { dagRun, NOW_ISO } from "./activityState.support";

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
