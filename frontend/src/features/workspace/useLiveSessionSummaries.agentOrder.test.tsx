import { describe, expect, it } from "vitest";
import { summarizeLiveSession } from "./useLiveSessionSummaries";
import type { LiveSessionInfo } from "./workspace";

const NOW = Date.parse("2026-09-10T12:00:00Z");

function infoWith(overrides: Partial<LiveSessionInfo>): LiveSessionInfo {
  return {
    id: "s1", title: "Session", task: null, dag: null, ...overrides,
  } as LiveSessionInfo;
}

describe("legacy fallback ordered agent aggregate authority (review r2 F3)", () => {
  it("uses lean scalars instead of conflicting legacy aggregate clocks", () => {
    // Given conflicting digests and an already elected legacy store aggregate.
    const info = { ...infoWith({
      taskDigest: { tasks: [], truncated: true, taskAgentRunningCount: 50 },
      dagDigest: { runs: [], truncated: true, agentRunningCount: 40 },
    }), lean: { running: { agents: 3, tasks: 2, dag: 2 }, done: 7, dag_done: 8, dag_total: 9 } };
    // When the summary is projected.
    const summary = summarizeLiveSession(info, NOW, { agentAggregate: { running: 99, total: 100 } });
    // Then no client recount or legacy store election degrades exact server deduplication.
    expect(summary).toMatchObject({ runningCount: 3, doneCount: 7, dagDone: 8, dagTotal: 9 });
  });

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

  it("a current task digest outranks a cached DAG snapshot scalar within one envelope", () => {
    const summary = summarizeLiveSession(infoWith({
      taskDigest: {
        tasks: [],
        truncated: true,
        receivedAt: "2026-09-10T11:30:00Z",
        taskAgentRunningCount: 2, taskAgentTotalCount: 2,
      },
      dag: {
        parent_session_id: "s1", truncated_runs: false, running_count: 1,
        agent_running_count: 1, agent_total_count: 1,
        runs: [{
          run_id: "r1", run_key: "r1", name: "Graph", status: "running",
          updated_at: "2026-09-10T10:01:00Z",
          counts: { total: 1, pending: 0, blocked: 0, scheduled: 0, running: 1, completed: 0, failed: 0, cancelled: 0, skipped: 0 },
          nodes: [{ id: "n1", task_id: "dag-work", prompt: "DAG only", depends_on: [], state: "running" }],
          edges: [], waves: [],
        }],
      },
    }), NOW);
    expect(summary.runningCount).toBe(2);
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
