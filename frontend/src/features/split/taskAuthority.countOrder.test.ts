import { describe, expect, it } from "vitest";
import { applyCountAuthority, reconcileTaskSources, type CountAuthority, type TaskAuthority } from "./taskAuthority";
import { parseTaskUpdated } from "./activityParseTask";

function bareState(running: number, total: number, admittedAt?: number): TaskAuthority {
  return {
    tasks: new Map(),
    taskAgentRunningCount: running,
    taskAgentTotalCount: total,
    ...(admittedAt === undefined ? {} : { agentCountsAdmissionMs: admittedAt }),
  };
}

const liveCounts: CountAuthority = { taskAgentRunningCount: 0, taskAgentTotalCount: 1 };
const staleCounts: CountAuthority = { taskAgentRunningCount: 1, taskAgentTotalCount: 1 };

describe("aggregate admission ordering (review r2 F4)", () => {
  it("a deferred REST response cannot overwrite live-admitted scalars", () => {
    const live = applyCountAuthority(bareState(1, 1), liveCounts, 200);
    expect(live.taskAgentRunningCount).toBe(0);
    expect(live.agentCountsAdmissionMs).toBe(200);

    const deferred = applyCountAuthority(live, staleCounts, 100);
    expect(deferred.taskAgentRunningCount).toBe(0);
    expect(deferred.agentCountsAdmissionMs).toBe(200);
  });

  it("a fresher REST response supersedes the live scalars", () => {
    const live = applyCountAuthority(bareState(1, 1), liveCounts, 200);
    const fresh = applyCountAuthority(live, staleCounts, 300);
    expect(fresh.taskAgentRunningCount).toBe(1);
    expect(fresh.agentCountsAdmissionMs).toBe(300);
  });

  it("a history digest deferred behind a live frame keeps the live aggregate", () => {
    const live = reconcileTaskSources(bareState(1, 1), parseTaskUpdated({
      tasks: [{ task_id: "t1", status: "completed", updated_at: "2026-09-10T12:00:10Z" }],
      running_count: 0, total_count: 1,
      agent_running_count: 0, agent_total_count: 1,
    }), undefined, { countAdmissionMs: 200 });
    expect(live.taskAgentRunningCount).toBe(0);

    const deferred = reconcileTaskSources(live, parseTaskUpdated({
      tasks: [{ task_id: "t1", status: "running", updated_at: "2026-09-10T12:00:05Z" }],
      running_count: 1, total_count: 1,
      agent_running_count: 1, agent_total_count: 1,
    }), undefined, { countRequestedMs: 100 });
    expect(deferred.taskAgentRunningCount).toBe(0);
    expect(deferred.agentCountsAdmissionMs).toBe(200);
  });

  it("a history digest newer than the live admission applies", () => {
    const live = reconcileTaskSources(bareState(1, 1), parseTaskUpdated({
      tasks: [{ task_id: "t1", status: "running", updated_at: "2026-09-10T12:00:00Z" }],
      agent_running_count: 1, agent_total_count: 1,
    }), undefined, { countAdmissionMs: 200 });

    const fresh = reconcileTaskSources(live, parseTaskUpdated({
      tasks: [{ task_id: "t1", status: "completed", updated_at: "2026-09-10T12:00:20Z" }],
      agent_running_count: 0, agent_total_count: 1,
    }), undefined, { countRequestedMs: 300 });
    expect(fresh.taskAgentRunningCount).toBe(0);
    expect(fresh.agentCountsAdmissionMs).toBe(300);
  });
});
