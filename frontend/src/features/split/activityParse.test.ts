import { describe, expect, it } from "vitest";
import { parseTaskUpdated } from "./activityParse";

describe("parseTaskUpdated", () => {
  it("parses a well-formed snapshot and live_progress when present", () => {
    const parsed = parseTaskUpdated({
      parent_session_id: "sess-1",
      truncated_tasks: false,
      tasks: [
        {
          task_id: "t1",
          name: "Greeter",
          task_summary: "Say hi",
          status: "running",
          model: "glm",
          created_at: "2026-08-19T10:00:00.000Z",
          updated_at: "2026-08-19T10:01:00.000Z",
          live_progress: {
            activity: "thinking",
            started_at: "2026-08-19T10:00:30.000Z",
            current_tool: "bash",
            last_assistant_line: "ls",
            turns: 2,
            tool_calls: 1,
            total_tokens: 40,
            tokens_per_second: 12.5,
          },
        },
      ],
    });

    expect(parsed).toEqual({
      parentSessionId: "sess-1",
      truncatedTasks: false,
      tasks: [
        {
          taskId: "t1",
          name: "Greeter",
          status: "running",
          parentSessionId: "sess-1",
          taskSummary: "Say hi",
          model: "glm",
          createdAt: "2026-08-19T10:00:00.000Z",
          updatedAt: "2026-08-19T10:01:00.000Z",
          liveProgress: {
            activity: "thinking",
            startedAt: "2026-08-19T10:00:30.000Z",
            currentTool: "bash",
            lastAssistantLine: "ls",
            turns: 2,
            toolCalls: 1,
            totalTokens: 40,
            tokensPerSecond: 12.5,
          },
        },
      ],
    });
  });

  it("omits absent optional fields instead of writing undefined", () => {
    const parsed = parseTaskUpdated({
      tasks: [{ task_id: "t1", name: "A", status: "pending" }],
    });
    const task = parsed?.tasks[0];
    expect(task).toEqual({ taskId: "t1", name: "A", status: "pending" });
    expect(task && "taskSummary" in task).toBe(false);
    expect(task && "liveProgress" in task).toBe(false);
    expect(parsed && "parentSessionId" in parsed).toBe(false);
  });

  it("parses agent routing fields independently", () => {
    const parsed = parseTaskUpdated({
      tasks: [
        { task_id: "agent", name: "Explore", status: "running", agent_type: "explore" },
        { task_id: "category", name: "Quick", status: "running", category: "quick" },
      ],
    });
    expect(parsed?.tasks[0]).toMatchObject({ agentType: "explore" });
    expect(parsed?.tasks[0]).not.toHaveProperty("category");
    expect(parsed?.tasks[1]).toMatchObject({ category: "quick" });
    expect(parsed?.tasks[1]).not.toHaveProperty("agentType");
  });

  it("drops a malformed task and keeps siblings", () => {
    const parsed = parseTaskUpdated({
      tasks: [
        { task_id: "good", name: "Keep", status: "running" },
        { name: "Missing id", status: "running" },
        { task_id: "bad-status", name: "X", status: 1 },
        { task_id: "bad-opt", name: "Y", status: "pending", model: 3 },
        "nope",
      ],
    });
    expect(parsed?.tasks.map((task) => task.taskId)).toEqual(["good"]);
  });

  it("returns null and never throws when the payload is garbage", () => {
    for (const data of [undefined, null, "", 1, [], { tasks: "nope" }]) {
      expect(parseTaskUpdated(data)).toBeNull();
    }
  });

  it("accepts live_progress.started_at as an epoch number from a real snapshot", () => {
    const parsed = parseTaskUpdated(REAL_LIVE_PROGRESS_TASK_UPDATED);
    expect(parsed?.tasks).toHaveLength(1);
    const task = parsed?.tasks[0];
    expect(task?.taskId).toBe("st_01a051b8");
    expect(task?.status).toBe("running");
    expect(task?.liveProgress).toEqual({
      activity:
        "Reply with the word OK only · category:quick(kimi-coding/kimi-for-coding-highspeed) · turn 1 · running · $0.0051 · 6600 tok/s",
      startedAt: 1788077455758,
      lastAssistantLine: "OK",
      turns: 1,
      toolCalls: 0,
      totalTokens: 2973,
      tokensPerSecond: 6600,
    });
  });

  it("accepts live_progress.started_at as a string", () => {
    const parsed = parseTaskUpdated({
      tasks: [
        {
          task_id: "t-str",
          name: "String start",
          status: "running",
          live_progress: { started_at: "2026-08-19T10:00:30.000Z", activity: "thinking" },
        },
      ],
    });
    expect(parsed?.tasks).toHaveLength(1);
    expect(parsed?.tasks[0]?.liveProgress).toEqual({
      activity: "thinking",
      startedAt: "2026-08-19T10:00:30.000Z",
    });
  });

  it("keeps a task when live_progress is malformed", () => {
    const objectStartedAt = parseTaskUpdated({
      tasks: [
        {
          task_id: "t1",
          name: "Keep",
          status: "running",
          live_progress: { started_at: { epoch: 1 }, activity: "thinking" },
        },
      ],
    });
    expect(objectStartedAt?.tasks).toEqual([{ taskId: "t1", name: "Keep", status: "running" }]);
    expect(objectStartedAt?.tasks[0] && "liveProgress" in objectStartedAt.tasks[0]).toBe(false);

    const notARecord = parseTaskUpdated({
      tasks: [
        {
          task_id: "t2",
          name: "Keep",
          status: "running",
          live_progress: "nope",
        },
      ],
    });
    expect(notARecord?.tasks).toEqual([{ taskId: "t2", name: "Keep", status: "running" }]);
    expect(notARecord?.tasks[0] && "liveProgress" in notARecord.tasks[0]).toBe(false);
  });

  it("returns both a plain task and a live_progress-carrying sibling", () => {
    const parsed = parseTaskUpdated({
      tasks: [
        { task_id: "pending", name: "Wait", status: "pending" },
        {
          task_id: "running",
          name: "Go",
          status: "running",
          live_progress: {
            activity: "thinking",
            started_at: 1788077455758,
          },
        },
      ],
    });
    expect(parsed?.tasks.map((task) => task.taskId)).toEqual(["pending", "running"]);
    expect(parsed?.tasks[1]?.liveProgress).toEqual({
      activity: "thinking",
      startedAt: 1788077455758,
    });
  });
});

/** Third omo.task.updated from /tmp/real-activity-events.json; started_at is an epoch number. */
const REAL_LIVE_PROGRESS_TASK_UPDATED = {
  parent_session_id: "01a051b7-8838-7c1c-b826-c9df40c2e9da",
  tasks: [
    {
      task_id: "st_01a051b8",
      status: "running",
      task_summary: "Reply with the word OK only",
      name: "st_01a051b8",
      category: "quick",
      execution_mode: "in-process",
      model: "kimi-coding/kimi-for-coding-highspeed",
      run_stats: {
        runtime_ms: 1735,
        turns: 1,
        tool_calls: 0,
        duration_status: "monotonic",
        token_status: "complete",
        cost_status: "reported",
        output_tokens: 33,
        input_tokens: 2428,
        cache_read_tokens: 512,
        total_tokens: 2973,
        generation_ms: 4,
        tokens_per_second: 8250,
        cost_usd: 0.00507176,
        cache_hit_rate_last: 0.17414965986394557,
        cache_hit_rate_run: 0.17414965986394557,
      },
      residency_state: "resident",
      depth: 1,
      created_at: "2026-08-30T08:10:55.758Z",
      updated_at: "2026-08-30T08:10:55.763Z",
      live_progress: {
        activity:
          "Reply with the word OK only · category:quick(kimi-coding/kimi-for-coding-highspeed) · turn 1 · running · $0.0051 · 6600 tok/s",
        started_at: 1788077455758,
        last_assistant_line: "OK",
        turns: 1,
        tool_calls: 0,
        total_tokens: 2973,
        output_tokens: 33,
        tokens_per_second: 6600,
      },
    },
  ],
};
