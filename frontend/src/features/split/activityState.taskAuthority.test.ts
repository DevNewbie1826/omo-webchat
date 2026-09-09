import { describe, expect, it } from "vitest";
import { applyActivityEvent, applyActivityHistorySnapshot, applyTaskHistorySnapshot, applyRunFlight, emptyActivityState } from "./activityState";
import { parseTaskUpdated } from "./activityParseTask";
import { parseDagDigest, parseTaskDigest } from "../workspace/activityDigest";
import { applyCountAuthority, applyTaskActivity, mergeTaskAuthorities, rawTaskRevision, reconcileTaskSources, taskAuthorityPayload, type TaskAuthority } from "./taskAuthority";

const t1 = "2026-09-07T10:01:00Z";
const t2 = "2026-09-07T10:02:00Z";
const t3 = "2026-09-07T10:03:00Z";
const activityAt = "2026-09-07T10:05:00.000Z";
const row = (status: string, updated_at: unknown, extra = {}) => ({ task_id: "child-1", name: "Child", status, updated_at, ...extra });
const live = (state: ReturnType<typeof emptyActivityState>, tasks: unknown[], truncated_tasks = false) =>
  applyActivityEvent(state, "omo.task.updated", { tasks, truncated_tasks });
const rest = (state: ReturnType<typeof emptyActivityState>, tasks: unknown[], truncated_tasks = false) =>
  applyActivityHistorySnapshot(state, "omo.task.updated", { tasks, truncated_tasks });

describe("task source authority", () => {
  it("retains the entire newer raw row, supports correction and genuine same-ID revival", () => {
    let state = live(emptyActivityState(), [row("completed", t2, { final_response: "done" })]);
    const accepted = state.tasks.get("child-1");
    state = live(state, [row("running", t1)]);
    expect(state.tasks.get("child-1")).toBe(accepted);
    state = live(state, [row("running", t3)]);
    expect(state.tasks.get("child-1")).toMatchObject({ status: "running", updatedAt: t3 });
    expect(state.tasks.get("child-1")?.finalResponse).toBeUndefined();
  });

  it("accepts a matching equal-version derived correction, retains it over raw replay and conflicts", () => {
    let state = live(emptyActivityState(), [row("running", t1)]);
    state = live(state, [row("completed", t1, { raw_status: "running", name: "not raw authority" })]);
    expect(state.tasks.get("child-1")).toMatchObject({ status: "completed", name: "Child", updatedAt: t1 });
    state = live(state, [row("running", t1)]);
    state = live(state, [row("failed", t1, { raw_status: "running" })]);
    expect(state.tasks.get("child-1")?.status).toBe("completed");
    state = live(state, [row("running", t2)]);
    state = live(state, [row("completed", t1, { raw_status: "running" })]);
    state = applyRunFlight(applyRunFlight(state, true), false);
    expect(state.tasks.get("child-1")?.status).toBe("running");
  });

  it.each([undefined, null, 42, {}, [], true, "", "2026-02-30T10:00:00Z", "2026-09-07T10:00:00"].map(clock => ({ clock })))(
    "retains membership with an unknown JSON clock $clock in complete REST", ({ clock }) => {
      const payload = { tasks: [row("running", clock)] };
      expect(parseTaskUpdated(payload)?.tasks).toHaveLength(1);
      expect(parseTaskDigest({ tasks: [row("running", clock)], truncated: false })?.tasks).toHaveLength(1);
      const state = rest(live(emptyActivityState(), [row("completed", t2)]), payload.tasks);
      expect(state.tasks.get("child-1")?.status).toBe("completed");
    });

  it("keeps raw revision separate from newer activity and orders progress numerically", () => {
    let state = live(emptyActivityState(), [row("running", t1)]);
    state = applyActivityEvent(state, "omo.dag.updated", { runs: [{ run_id: "r", run_key: "r", name: "r", status: "running",
      nodes: [{ id: "n", prompt: "do", state: "running", depends_on: [], task_id: "child-1" }] }] });
    const activity = (at: string, currentTool: string) => ({ runId: "r", nodeId: "n", taskId: "child-1", at, currentTool });
    state = applyActivityEvent(state, "omo.dag.activity", activity(activityAt, "new"));
    state = live(state, [row("completed", t2)]);
    expect(state.tasks.get("child-1")).toMatchObject({ status: "completed", updatedAt: activityAt, liveProgress: { currentTool: "new" } });
    state = applyActivityEvent(state, "omo.dag.activity", activity("2026-09-07T19:04:00+09:00", "old"));
    expect(state.tasks.get("child-1")?.liveProgress?.currentTool).toBe("new");
    state = live(state, [row("running", t3)]);
    expect(state.tasks.get("child-1")?.status).toBe("running");
  });

  it("keeps omission watermarks, admits newer revival, and never removes through partial row loss", () => {
    let state = live(emptyActivityState(), [row("running", t2)]);
    state = live(state, [{ broken: true }]);
    expect(state.tasks.has("child-1")).toBe(true);
    state = rest(state, [], true);
    expect(state.tasks.has("child-1")).toBe(true);
    state = rest(state, []);
    expect(state.tasks.size).toBe(0);
    state = live(state, [row("completed", t2, { raw_status: "running" })]);
    state = live(state, [row("running", t1)]);
    expect(state.tasks.size).toBe(0);
    state = live(state, [row("running", t3)]);
    expect(state.tasks.size).toBe(1);
  });

  it("pins legacy unknown arrival, numeric offset equality and source-specific terminal omission", () => {
    let state = live(emptyActivityState(), [row("completed", undefined)]);
    state = live(state, [row("running", null)]);
    expect(state.tasks.get("child-1")?.status).toBe("running");
    state = live(state, [row("completed", t2)]);
    state = live(state, [row("running", "2026-09-07T19:02:00.0009+09:00")]);
    expect(state.tasks.get("child-1")?.status).toBe("completed");
    state = live(state, []);
    expect(state.tasks.size).toBe(1);
    state = rest(state, []);
    expect(state.tasks.size).toBe(0);
  });
  it("does not carry old raw progress fields through a newer raw row's activity overlay", () => {
    let state = live(emptyActivityState(), [row("running", t1, { live_progress: { total_tokens: 100, current_tool: "old" } })]);
    state = applyActivityEvent(state, "omo.dag.updated", { runs: [{ run_id: "r", run_key: "r", name: "r", status: "running",
      nodes: [{ id: "n", prompt: "do", state: "running", depends_on: [] }] }] });
    state = applyActivityEvent(state, "omo.dag.activity", { runId: "r", nodeId: "n", taskId: "child-1", at: activityAt, activity: "work" });
    state = live(state, [row("completed", t2, { live_progress: { total_tokens: 200, current_tool: "new" } })]);
    expect(state.tasks.get("child-1")?.liveProgress).toMatchObject({ totalTokens: 200, currentTool: "new", activity: "work" });
  });

  it.each(["completed", "unknown", 42, null, {}, "running"])("validates provenance against the raw base: %j", raw_status => {
    let state = live(emptyActivityState(), [row("pending", t1)]);
    state = live(state, [row("completed", t1, { raw_status })]);
    expect(state.tasks.get("child-1")?.status).toBe("pending");
  });

  it("retains completed rows and their revisions beyond 512 IDs across valid live snapshots", () => {
    let state = live(emptyActivityState(), [row("completed", t2, { final_response: "done" })]);
    const incumbent = state.tasks.get("child-1");
    for (let batch = 0; batch < 3; batch += 1) {
      state = live(state, Array.from({ length: 256 }, (_, index) =>
        row("completed", t2, { task_id: `batch-${batch}-${index}` })));
    }
    const retainedCount = state.tasks.size;
    const retainedRevisions = state.taskFreshness?.size;
    const partial = state.truncatedTasks;
    state = live(state, [row("running", t1)]);
    expect(state.tasks.get("child-1")?.status).toBe("completed");
    expect(state.tasks.get("child-1")).toBe(incumbent);
    expect(retainedCount).toBe(769);
    expect(retainedRevisions).toBe(769);
    expect(partial).toBe(false);
    state = live(state, [row("running", t3)]);
    expect(state.tasks.get("child-1")?.status).toBe("running");
    expect(state.tasks.size).toBe(769);
  });

  it("retains omission watermarks beyond 512 IDs until the owner retires", () => {
    let state = rest(emptyActivityState(), [row("completed", t2)]);
    for (let batch = 0; batch < 3; batch += 1) {
      state = rest(state, Array.from({ length: 256 }, (_, index) =>
        row("completed", t2, { task_id: `history-${batch}-${index}` })));
    }
    state = rest(state, []);
    const retainedRevisions = state.taskFreshness?.size;
    state = live(state, [row("running", t1)]);
    expect(state.tasks.has("child-1")).toBe(false);
    expect(retainedRevisions).toBe(769);
    state = live(state, [row("completed", t2)]);
    expect(state.tasks.has("child-1")).toBe(false);
    state = live(state, [row("running", t3)]);
    expect(state.tasks.get("child-1")?.status).toBe("running");
    expect(live(emptyActivityState(), [row("running", t1)]).tasks.get("child-1")?.status).toBe("running");
  });

  it("enriches compact descriptions without importing an older alias activity clock or overlay", () => {
    const digest = parseTaskDigest({ tasks: [row("completed", t2, { raw_status: "running" })], truncated: false });
    expect(digest).not.toBeNull();
    const compact = applyTaskHistorySnapshot(emptyActivityState(), null, new Set(), digest!);
    const current = { ...compact, tasks: new Map(compact.tasks).set("child-1",
      applyTaskActivity(compact.tasks.get("child-1")!, { at: activityAt, currentTool: "new" })) };
    const rich = live(emptyActivityState(), [row("running", t2, { name: "Rich" })]);
    const alias = { ...rich, tasks: new Map(rich.tasks).set("child-1",
      applyTaskActivity(rich.tasks.get("child-1")!, { at: t3, currentTool: "old" })) };
    const merged = mergeTaskAuthorities(current, alias);
    const enriched = merged.tasks.get("child-1")!;
    expect(enriched).toMatchObject({ name: "Rich", status: "completed", rawStatus: "running", rawUpdatedAt: t2,
      updatedAt: activityAt, activityAt, activityProgress: { currentTool: "new" }, liveProgress: { currentTool: "new" } });
    expect(rawTaskRevision(enriched)).toBe(Date.parse(t2));
    expect(taskAuthorityPayload(merged)).toMatchObject({ tasks: [expect.objectContaining({ updated_at: t2, raw_status: "running" })] });
    expect(applyTaskActivity(enriched, { at: "2026-09-07T10:04:00Z", currentTool: "stale" })).toBe(enriched);
  });

  it("carries the agent aggregate through digests, rich payloads, merges, and wire projection", () => {
    const digest = parseTaskDigest({
      tasks: [row("running", t3)], truncated: true,
      running_count: 50, total_count: 600, agent_running_count: 50, agent_total_count: 600,
    });
    expect(digest).not.toBeNull();
    let state = applyTaskHistorySnapshot(emptyActivityState(), null, new Set(), digest!);
    expect(state).toMatchObject({ taskAgentRunningCount: 50, taskAgentTotalCount: 600 });
    // A rich payload without the scalars retains the established authority.
    state = reconcileTaskSources(state, parseTaskUpdated({ tasks: [row("running", t3)] }), undefined);
    expect(state).toMatchObject({ taskAgentRunningCount: 50, taskAgentTotalCount: 600 });
    // A rich payload with newer scalars updates it.
    state = reconcileTaskSources(state, parseTaskUpdated({
      tasks: [row("running", t3)], running_count: 51, total_count: 601, agent_running_count: 51, agent_total_count: 601,
    }), undefined);
    expect(state).toMatchObject({ taskAgentRunningCount: 51, taskAgentTotalCount: 601 });
    // Alias migration keeps the newer side's aggregate.
    const merged = mergeTaskAuthorities(state, emptyActivityState());
    expect(merged).toMatchObject({ taskAgentRunningCount: 51, taskAgentTotalCount: 601 });
    expect(taskAuthorityPayload(state)).toMatchObject({
      running_count: 51, total_count: 601, agent_running_count: 51, agent_total_count: 601,
    });
  });

  it("applies count-only authority from either snapshot frame without inventing zeros", () => {
    const state = emptyActivityState();
    expect((state as TaskAuthority).taskAgentRunningCount).toBeUndefined();
    // A DAG frame carries only the agent pair; the node sum is not a task scalar.
    let next = applyCountAuthority(state, { taskAgentRunningCount: 4, taskAgentTotalCount: 8 });
    expect(next).toMatchObject({ taskAgentRunningCount: 4, taskAgentTotalCount: 8 });
    expect((next as TaskAuthority).taskRunningCount).toBeUndefined();
    // Omitted scalars retain the established authority; nothing pins a zero.
    expect(applyCountAuthority(next, {})).toBe(next);
    next = applyCountAuthority(next, { taskRunningCount: 2, taskTotalCount: 4, taskAgentRunningCount: 3, taskAgentTotalCount: 6 });
    expect(next).toMatchObject({ taskRunningCount: 2, taskTotalCount: 4, taskAgentRunningCount: 3, taskAgentTotalCount: 6 });
  });

  it("backfills the agent aggregate from the DAG digest when the task digest predates it", () => {
    const dagDigest = parseDagDigest({
      runs: [], truncated: true, running_count: 9, agent_running_count: 4, agent_total_count: 8,
    });
    expect(dagDigest).not.toBeNull();
    const state = applyCountAuthority(emptyActivityState(), {
      ...(dagDigest!.agentRunningCount === undefined ? {} : { taskAgentRunningCount: dagDigest!.agentRunningCount }),
      ...(dagDigest!.agentTotalCount === undefined ? {} : { taskAgentTotalCount: dagDigest!.agentTotalCount }),
    });
    expect(state).toMatchObject({ taskAgentRunningCount: 4, taskAgentTotalCount: 8 });
    expect((state as TaskAuthority).taskRunningCount).toBeUndefined();
  });

});
