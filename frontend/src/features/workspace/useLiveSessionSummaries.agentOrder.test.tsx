import { describe, expect, it } from "vitest";
import { summarizeLiveSession } from "./useLiveSessionSummaries";
import type { LiveSessionInfo } from "./workspace";

const NOW = Date.parse("2026-09-10T12:00:00Z");

function infoWith(overrides: Partial<LiveSessionInfo>): LiveSessionInfo {
  return {
    id: "s1", title: "Session", task: null, dag: null, ...overrides,
  } as LiveSessionInfo;
}

describe("ordered agent aggregate authority (review r2 F3)", () => {
  it("a newer DAG aggregate supersedes an older task aggregate", () => {
    const summary = summarizeLiveSession(infoWith({
      taskDigest: {
        tasks: [{ taskId: "t1", status: "running" }],
        truncated: true,
        receivedAt: "2026-09-10T11:00:00Z",
        taskAgentRunningCount: 50, taskAgentTotalCount: 50,
      },
      dagDigest: {
        runs: [{ runId: "r1", status: "completed", runningTaskIds: [] }],
        truncated: true,
        receivedAt: "2026-09-10T11:05:00Z",
        agentRunningCount: 0, agentTotalCount: 50,
      },
    }), NOW);
    expect(summary.runningCount).toBe(0);
  });

  it("a DAG-only addition after an aggregate-bearing task frame wins on recency", () => {
    const summary = summarizeLiveSession(infoWith({
      taskDigest: {
        tasks: [],
        truncated: true,
        receivedAt: "2026-09-10T11:00:00Z",
        taskAgentRunningCount: 2, taskAgentTotalCount: 2,
      },
      dagDigest: {
        runs: [{ runId: "r1", status: "running", runningTaskIds: [] }],
        truncated: true,
        receivedAt: "2026-09-10T11:02:00Z",
        agentRunningCount: 3, agentTotalCount: 3,
      },
    }), NOW);
    expect(summary.runningCount).toBe(3);
  });

  it("an older task aggregate does not shadow a newer one", () => {
    const summary = summarizeLiveSession(infoWith({
      taskDigest: {
        tasks: [],
        truncated: true,
        receivedAt: "2026-09-10T11:04:00Z",
        taskAgentRunningCount: 7, taskAgentTotalCount: 7,
      },
      dagDigest: {
        runs: [],
        truncated: true,
        receivedAt: "2026-09-10T11:05:00Z",
        agentRunningCount: 5, agentTotalCount: 5,
      },
    }), NOW);
    expect(summary.runningCount).toBe(5);
  });

  it("ties prefer the DAG side as the later completion source", () => {
    const summary = summarizeLiveSession(infoWith({
      taskDigest: {
        tasks: [],
        truncated: true,
        receivedAt: "2026-09-10T11:00:00Z",
        taskAgentRunningCount: 9, taskAgentTotalCount: 9,
      },
      dagDigest: {
        runs: [],
        truncated: true,
        receivedAt: "2026-09-10T11:00:00Z",
        agentRunningCount: 4, agentTotalCount: 4,
      },
    }), NOW);
    expect(summary.runningCount).toBe(4);
  });

  it("timestamp-less parsed frames rank below timestamped digests", () => {
    const summary = summarizeLiveSession(infoWith({
      task: { parent_session_id: "s1", truncated_tasks: false, tasks: [{ task_id: "t1", status: "running", updated_at: "2026-09-10T10:00:00Z" }], running_count: 1, total_count: 1, agent_running_count: 1, agent_total_count: 1 },
      taskDigest: {
        tasks: [],
        truncated: true,
        receivedAt: "2026-09-10T11:30:00Z",
        taskAgentRunningCount: 6, taskAgentTotalCount: 6,
      },
    }), NOW);
    expect(summary.runningCount).toBe(6);
  });
});
