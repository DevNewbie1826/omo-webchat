import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectChat } from "../../lib/chatWs";
import type { ChatClient, ChatHandlers, ChatServerFrame } from "../../lib/chatWs";
import { parseDagDigest, parseTaskDigest } from "./activityDigest";
import { summarizeLiveSession, useLiveSessionSummaries } from "./useLiveSessionSummaries";
import { useLiveSessions } from "./useLiveSessions";
import type { LiveSessionSummary } from "./useLiveSessionSummaries";

vi.mock("../../lib/chatWs", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/chatWs")>(),
  connectChat: vi.fn(),
}));

/** Payload shapes reused from features/split/activityParse.test.ts fixtures. */
const FRESH_TASK_UPDATED_AT = new Date(Date.now() - 1000).toISOString();

const TASK_PAYLOAD = {
  parent_session_id: "s1",
  truncated_tasks: false,
  tasks: [
    {
      task_id: "t1",
      name: "Greeter",
      status: "running",
      updated_at: FRESH_TASK_UPDATED_AT,
      live_progress: {
        activity: "thinking",
        started_at: 1788077455758,
        current_tool: "bash",
        last_assistant_line: "ls",
        turns: 2,
        tool_calls: 1,
        total_tokens: 40,
        tokens_per_second: 12.5,
      },
    },
    { task_id: "t2", name: "Done one", status: "completed", updated_at: "2026-08-19T10:00:30.000Z" },
    { task_id: "t3", name: "Waiting", status: "pending", updated_at: "2026-08-19T10:00:10.000Z" },
    { task_id: "t4", name: "Failed", status: "failed", updated_at: "2026-08-19T10:00:05.000Z" },
    { task_id: "t5", name: "Cancelled", status: "cancelled", updated_at: "2026-08-19T10:00:01.000Z" },
  ],
};

const DAG_PAYLOAD = {
  parent_session_id: "s1",
  truncated_runs: false,
  runs: [
    {
      run_id: "r1",
      run_key: "plan",
      name: "Ship",
      status: "running",
      counts: { total: 2, pending: 0, blocked: 0, scheduled: 0, running: 1, completed: 1, failed: 0, cancelled: 0, skipped: 0 },
      nodes: [
        { id: "n1", prompt: "Run", depends_on: [], state: "running", task_id: "dag-child" },
        { id: "n2", prompt: "Done", depends_on: [], state: "completed" },
      ],
      edges: [],
      waves: [],
    },
    {
      run_id: "r2",
      run_key: "verify",
      name: "Verify",
      status: "completed",
      counts: { total: 1, pending: 0, blocked: 0, scheduled: 0, running: 0, completed: 1, failed: 0, cancelled: 0, skipped: 0 },
      nodes: [{ id: "n3", prompt: "Verified", depends_on: [], state: "completed" }],
      edges: [],
      waves: [],
    },
  ],
};

const NOT_OVERSIZED = { taskOversized: false, dagOversized: false } as const;

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("summarizeLiveSession", () => {
  afterEach(() => vi.useRealTimers());

  it("counts running and done tasks and aggregates dag progress", () => {
    const summary = summarizeLiveSession({
      id: "s1",
      title: "Refactor auth",
      task: TASK_PAYLOAD,
      dag: DAG_PAYLOAD,
      ...NOT_OVERSIZED,
    });

    expect(summary).toEqual({
      id: "s1",
      title: "Refactor auth",
      task: TASK_PAYLOAD,
      dag: DAG_PAYLOAD,
      taskSideOversized: false,
      dagSideOversized: false,
      runningCount: 2,
      doneCount: 3,
      dagDone: 2,
      dagTotal: 3,
      lastLine: "ls",
      dagRunning: 1,
    });
  });

  it("tolerates null and malformed payloads", () => {
    expect(
      summarizeLiveSession({ id: "s2", title: "Bare", task: null, dag: null, ...NOT_OVERSIZED }),
    ).toEqual({
      id: "s2",
      title: "Bare",
      task: null,
      dag: null,
      taskSideOversized: false,
      dagSideOversized: false,
      runningCount: 0,
      doneCount: 0,
      dagDone: 0,
      dagTotal: 0,
      lastLine: null,
      dagRunning: 0,
    });

    const garbage = summarizeLiveSession({ id: "s3", title: "", task: { tasks: "nope" }, dag: { runs: 1 }, ...NOT_OVERSIZED });
    expect(garbage.runningCount).toBe(0);
    expect(garbage.doneCount).toBe(0);
    expect(garbage.dagTotal).toBe(0);
    expect(garbage.lastLine).toBeNull();
    expect(garbage.dagRunning).toBe(0);
  });

  it("drops a stale quiet running row when no freshness context establishes liveness", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T10:02:00.000Z"));
    const summary = summarizeLiveSession({
      id: "stale",
      title: "Quiet agent",
      task: {
        tasks: [{ task_id: "t1", name: "Quiet", status: "running", updated_at: "2026-08-19T10:00:00.000Z" }],
      },
      dag: null,
      ...NOT_OVERSIZED,
    });

    expect(summary.runningCount).toBe(0);
    expect(summary.doneCount).toBe(0);
  });

  it("keeps counting a running task quiet past 90s while the session is live in the poller", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T10:02:00.000Z"));
    const summary = summarizeLiveSession({
      id: "stale-live",
      title: "Quiet but alive",
      task: {
        tasks: [{ task_id: "t1", name: "Quiet", status: "running", updated_at: "2026-08-19T10:00:00.000Z" }],
      },
      dag: null,
      ...NOT_OVERSIZED,
    }, Date.now(), { sessionLive: true });

    expect(summary.runningCount).toBe(1);
    expect(summary.doneCount).toBe(0);
  });

  it("counts a quiet running row refreshed by an omo.dag.activity heartbeat stamp", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T10:02:00.000Z"));
    const info = {
      id: "heartbeat",
      title: "Heartbeat",
      task: {
        tasks: [{ task_id: "t1", name: "Quiet", status: "running", updated_at: "2026-08-19T10:00:00.000Z" }],
      },
      dag: null,
      ...NOT_OVERSIZED,
    };

    expect(summarizeLiveSession(info, Date.now()).runningCount).toBe(0);
    expect(summarizeLiveSession(info, Date.now(), {
      heartbeatStamps: new Map([["t1", "2026-08-19T10:01:59.000Z"]]),
    }).runningCount).toBe(1);
  });

  it("keeps counting fresh running agents", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T10:02:00.000Z"));
    const summary = summarizeLiveSession({
      id: "fresh",
      title: "Active agents",
      task: {
        tasks: [
          { task_id: "fresh", name: "Fresh", status: "running", updated_at: "2026-08-19T10:01:59.000Z" },
          { task_id: "unknown", name: "Unknown timestamp", status: "running" },
        ],
      },
      dag: null,
      ...NOT_OVERSIZED,
    });

    expect(summary.runningCount).toBe(2);
  });

  it("takes lastLine from the most recent task's live progress", () => {
    const summary = summarizeLiveSession({
      id: "s4",
      title: "",
      task: {
        tasks: [
          {
            task_id: "old",
            name: "Old",
            status: "running",
            updated_at: "2026-08-19T10:01:00.000Z",
            live_progress: { last_assistant_line: "older line" },
          },
          {
            task_id: "new",
            name: "New",
            status: "running",
            updated_at: "2026-08-19T10:02:00.000Z",
            live_progress: { activity: "latest activity" },
          },
        ],
      },
      dag: null,
      ...NOT_OVERSIZED,
    });

    expect(summary.lastLine).toBe("latest activity");
  });

  it("qualifies aggregate-only dag data instead of counting unidentified children", () => {
    const summary = summarizeLiveSession({
      id: "dag-only",
      title: "Workflow",
      task: null,
      dag: {
        runs: [
          {
            run_id: "r1",
            run_key: "plan",
            name: "Ship",
            status: "running",
            counts: {
              total: 3,
              pending: 0,
              blocked: 0,
              scheduled: 0,
              running: 3,
              completed: 0,
              failed: 0,
              cancelled: 0,
              skipped: 0,
            },
            nodes: [],
            edges: [],
            waves: [],
          },
        ],
      },
      ...NOT_OVERSIZED,
    });

    expect(summary.runningCount).toBe(0);
    expect(summary.dagRunning).toBe(0);
  });

  it("counts a taskId present in both a running task row and a running dag node once", () => {
    const summary = summarizeLiveSession({
      id: "dup",
      title: "",
      task: {
        tasks: [{ task_id: "t1", name: "Greeter", status: "running", updated_at: FRESH_TASK_UPDATED_AT }],
      },
      dag: {
        runs: [
          {
            run_id: "r1",
            run_key: "plan",
            name: "Ship",
            status: "running",
            counts: {
              total: 1,
              pending: 0,
              blocked: 0,
              scheduled: 0,
              running: 1,
              completed: 0,
              failed: 0,
              cancelled: 0,
              skipped: 0,
            },
            nodes: [{ id: "n1", prompt: "do", depends_on: [], state: "running", task_id: "t1" }],
            edges: [],
            waves: [],
          },
        ],
      },
      ...NOT_OVERSIZED,
    });

    expect(summary.runningCount).toBe(1);
    expect(summary.dagRunning).toBe(0);
  });

  it("does not count cached rows from oversized sides but still parses task lastLine", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T10:00:00.000Z"));
    const summary = summarizeLiveSession({
      id: "over",
      title: "",
      task: {
        tasks: [
          { task_id: "t1", name: "Cached one", status: "running", updated_at: "2026-08-19T10:00:00.000Z", live_progress: { last_assistant_line: "cached detail" } },
          { task_id: "t2", name: "Cached two", status: "running", updated_at: "2026-08-19T10:00:00.000Z" },
        ],
      },
      dag: DAG_PAYLOAD,
      taskOversized: true,
      dagOversized: true,
    });

    expect(summary).toMatchObject({
      runningCount: 0,
      dagRunning: 0,
      lastLine: "cached detail",
      taskSideOversized: true,
      dagSideOversized: true,
    });
  });

  describe("running-dag-node authority over the staleness gate", () => {
    const NOW = new Date("2026-08-19T10:14:26.000Z");
    const STALE_AT = "2026-08-19T10:00:00.000Z";
    const FRESH_AT = "2026-08-19T10:14:00.000Z";
    const TASK_ID = "st_01a058e3";

    function pinTask(updatedAt: string) {
      return { task_id: TASK_ID, name: "pin", status: "running", updated_at: updatedAt };
    }

    function dagPayload(runStatus: string, nodeState: string) {
      return {
        runs: [{
          run_id: "r1",
          run_key: "plan",
          name: "Ship",
          status: runStatus,
          counts: {
            total: 1,
            pending: 0,
            blocked: 0,
            scheduled: 0,
            running: nodeState === "running" ? 1 : 0,
            completed: nodeState === "completed" ? 1 : 0,
            failed: 0,
            cancelled: 0,
            skipped: 0,
          },
          nodes: [{ id: "n1", prompt: "do", depends_on: [], state: nodeState, task_id: TASK_ID }],
          edges: [],
          waves: [],
        }],
      };
    }

    it("counts a stale running row when a non-terminal dag run has a running node with the same task id", () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const summary = summarizeLiveSession({
        id: "chat-3fd32e00",
        title: "pin",
        task: { tasks: [pinTask(STALE_AT)] },
        dag: dagPayload("running", "running"),
        ...NOT_OVERSIZED,
      });

      expect(summary.runningCount).toBe(1);
      expect(summary.dagRunning).toBe(0);
    });

    it("does not trust cached dag authority when the dag side is oversized", () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const summary = summarizeLiveSession({
        id: "chat-3fd32e00",
        title: "pin",
        task: { tasks: [pinTask(STALE_AT)] },
        dag: dagPayload("running", "running"),
        taskOversized: false,
        dagOversized: true,
      });

      expect(summary.runningCount).toBe(0);
      expect(summary.dagRunning).toBe(0);
    });

    it("counts a stale task row once when an oversized dag digest vouches for the same task id", () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const summary = summarizeLiveSession({
        id: "chat-3fd32e00",
        title: "pin",
        task: { tasks: [pinTask(STALE_AT)] },
        dag: null,
        taskOversized: false,
        dagOversized: true,
        dagDigest: {
          runs: [{ runId: "r1", status: "running", runningTaskIds: [TASK_ID] }],
          truncated: false,
        },
      });

      expect(summary.runningCount).toBe(1);
      expect(summary.dagRunning).toBe(0);
    });

    it("drops a stale running row when its dag node is completed", () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const summary = summarizeLiveSession({
        id: "chat-3fd32e00",
        title: "pin",
        task: { tasks: [pinTask(STALE_AT)] },
        dag: dagPayload("running", "completed"),
        ...NOT_OVERSIZED,
      });

      expect(summary.runningCount).toBe(0);
    });

    it("drops a stale running row when its dag run is completed", () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const summary = summarizeLiveSession({
        id: "chat-3fd32e00",
        title: "pin",
        task: { tasks: [pinTask(STALE_AT)] },
        dag: dagPayload("completed", "running"),
        ...NOT_OVERSIZED,
      });

      expect(summary.runningCount).toBe(0);
    });

    it("drops a stale running row when there is no dag payload", () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const summary = summarizeLiveSession({
        id: "chat-3fd32e00",
        title: "pin",
        task: { tasks: [pinTask(STALE_AT)] },
        dag: null,
        ...NOT_OVERSIZED,
      });

      expect(summary.runningCount).toBe(0);
    });

    it("counts a fresh running row and its running dag node once", () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const summary = summarizeLiveSession({
        id: "chat-3fd32e00",
        title: "pin",
        task: { tasks: [pinTask(FRESH_AT)] },
        dag: dagPayload("running", "running"),
        ...NOT_OVERSIZED,
      });

      expect(summary.runningCount).toBe(1);
      expect(summary.dagRunning).toBe(0);
    });
  });

  describe("oversized sides count from activity digests", () => {
    const NOW = new Date("2026-08-19T10:14:26.000Z");
    const STALE_AT = "2026-08-19T10:00:00.000Z";
    const FRESH_AT = "2026-08-19T10:14:00.000Z";
    const TASK_ID = "st_digest_1";

    it("counts a fresh running digest entry when the task payload is null and oversized", () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const summary = summarizeLiveSession({
        id: "digest-fresh",
        title: "",
        task: null,
        dag: null,
        taskOversized: true,
        taskDigest: {
          tasks: [{ taskId: TASK_ID, status: "running", updatedAt: FRESH_AT }],
          truncated: false,
        },
      });

      expect(summary.runningCount).toBe(1);
    });

    it("drops a digest running entry whose updated_at is 866s old when there is no dag digest", () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const summary = summarizeLiveSession({
        id: "digest-stale",
        title: "",
        task: null,
        dag: null,
        taskOversized: true,
        taskDigest: {
          tasks: [{ taskId: TASK_ID, status: "running", updatedAt: STALE_AT }],
          truncated: false,
        },
      });

      expect(summary.runningCount).toBe(0);
    });

    it("keeps a quiet digest-only running entry while the oversized session is live", () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const summary = summarizeLiveSession({
        id: "digest-stale-live",
        title: "",
        task: null,
        dag: null,
        taskOversized: true,
        taskDigest: {
          tasks: [{ taskId: TASK_ID, status: "running", updatedAt: STALE_AT }],
          truncated: false,
        },
      }, Date.now(), { sessionLive: true });

      expect(summary.runningCount).toBe(1);
    });

    it("keeps a stale digest running entry when a non-terminal dag digest run lists that task id", () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const summary = summarizeLiveSession({
        id: "digest-authority",
        title: "",
        task: null,
        dag: null,
        taskOversized: true,
        dagOversized: true,
        taskDigest: {
          tasks: [{ taskId: TASK_ID, status: "running", updatedAt: STALE_AT }],
          truncated: false,
        },
        dagDigest: {
          runs: [{ runId: "r1", status: "running", runningTaskIds: [TASK_ID] }],
          truncated: false,
        },
      });

      expect(summary.runningCount).toBe(1);
      expect(summary.dagRunning).toBe(0);
    });

    it("counts truncated digest rows legacy-style without inventing markers", () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const summary = summarizeLiveSession({
        id: "digest-trunc",
        title: "",
        task: null,
        dag: null,
        taskOversized: true,
        taskDigest: {
          tasks: [{ taskId: TASK_ID, status: "running", updatedAt: FRESH_AT }],
          truncated: true,
        },
      });

      expect(summary.runningCount).toBe(1);
    });

    it("stays at zero without inventing work when no digest is present", () => {
      const summary = summarizeLiveSession({
        id: "over-no-digest",
        title: "",
        task: null,
        dag: null,
        taskOversized: true,
      });

      expect(summary.runningCount).toBe(0);
      expect(summary.taskSideOversized).toBe(true);
    });
  });

  describe("server running-count scalars are the sole authority", () => {
    const NOW = new Date("2026-08-19T10:14:26.000Z");
    const FRESH_AT = "2026-08-19T10:14:00.000Z";

    function digestWith(value: Record<string, unknown>) {
      const digest = parseTaskDigest(value);
      if (digest === null) throw new Error("Invalid digest fixture");
      return digest;
    }

    it("ignores truncated digest rows when the server running scalar says zero", () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const summary = summarizeLiveSession({
        id: "scalar-zero",
        title: "",
        task: null,
        dag: null,
        taskOversized: true,
        taskDigest: digestWith({
          tasks: [{ task_id: "t1", status: "running", updated_at: FRESH_AT }],
          truncated: true,
          running_count: 0,
        }),
      });

      expect(summary.runningCount).toBe(0);
    });

    it("takes running_count 50 as the exact badge number and parses the total", () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const taskDigest = digestWith({
        tasks: [{ task_id: "t1", status: "running", updated_at: FRESH_AT }],
        truncated: true,
        running_count: 50,
        total_count: 80,
      });
      const summary = summarizeLiveSession({
        id: "scalar-50",
        title: "",
        task: null,
        dag: null,
        taskOversized: true,
        taskDigest,
      });

      expect(summary.runningCount).toBe(50);
      expect(taskDigest.taskTotalCount).toBe(80);
      expect(taskDigest.taskRunningCount).toBe(50);
    });

    it("takes the agent aggregate as the sole running authority under truncation", () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      // The same 50 running identities exist on both sides; retained rows are a
      // truncated prefix. Summing the per-side scalars would double count.
      const taskDigest = digestWith({
        tasks: [{ task_id: "t1", status: "running", updated_at: FRESH_AT }],
        truncated: true,
        running_count: 50,
        total_count: 600,
        agent_running_count: 50,
        agent_total_count: 600,
      });
      const dagDigest = parseDagDigest({
        runs: [{ run_id: "r1", status: "running", running_task_ids: ["t1", "t2"] }],
        truncated: true,
        running_count: 50,
        agent_running_count: 50,
        agent_total_count: 600,
      });
      if (dagDigest === null) throw new Error("Invalid dag digest fixture");
      expect(dagDigest.dagRunningCount).toBe(50);
      const summary = summarizeLiveSession({
        id: "agent-authority",
        title: "",
        task: null,
        dag: null,
        taskOversized: true,
        dagOversized: true,
        taskDigest,
        dagDigest,
      });

      expect(summary.runningCount).toBe(50);
      expect(summary.runningCount).not.toBe(
        (taskDigest.taskRunningCount ?? 0) + (dagDigest.dagRunningCount ?? 0));
    });

    it("keeps the exact agent aggregate when retained rows double-count an overlap", () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      // t1 appears on both retained sides, so row inference would say 2 while
      // the accepted full membership contains exactly one running agent work.
      const taskDigest = digestWith({
        tasks: [
          { task_id: "t1", status: "running", updated_at: FRESH_AT },
          { task_id: "t2", status: "running", updated_at: FRESH_AT },
        ],
        truncated: true,
        running_count: 1,
        total_count: 2,
        agent_running_count: 1,
        agent_total_count: 2,
      });
      const dagDigest = parseDagDigest({
        runs: [{ run_id: "r1", status: "running", running_task_ids: ["t1"] }],
        truncated: true,
        running_count: 1,
        agent_running_count: 1,
        agent_total_count: 2,
      });
      if (dagDigest === null) throw new Error("Invalid dag digest fixture");
      const summary = summarizeLiveSession({
        id: "agent-overlap",
        title: "",
        task: null,
        dag: null,
        taskOversized: true,
        dagOversized: true,
        taskDigest,
        dagDigest,
      });

      expect(summary.runningCount).toBe(1);
    });

    it("consumes the disjoint full-source aggregate from both snapshot payloads", () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      // Two direct task lanes and two DAG-running nodes, one of which backs a
      // task lane: the aggregate counts DAG-only work once and the overlap
      // once, so the naive scalar sum (4) would double count.
      const summary = summarizeLiveSession({
        id: "agent-disjoint",
        title: "",
        task: { tasks: [], running_count: 2, total_count: 4, agent_running_count: 3, agent_total_count: 8 },
        dag: { runs: [], truncated_runs: false, running_count: 2, agent_running_count: 3, agent_total_count: 8 },
        ...NOT_OVERSIZED,
      });

      expect(summary.runningCount).toBe(3);
      expect(summary.runningCount).not.toBe(2 + 2);
    });

    it("parses payload-level running_count and total_count", () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const summary = summarizeLiveSession({
        id: "scalar-rich",
        title: "",
        task: { tasks: [], running_count: 3, total_count: 9 },
        dag: null,
        ...NOT_OVERSIZED,
      });

      expect(summary.runningCount).toBe(3);
    });
  });

  describe("digest receivedAt vouches for quiet running rows", () => {
    const NOW = new Date("2026-08-19T10:14:26.000Z");
    const ROW_300S_AT = "2026-08-19T10:09:26.000Z";
    const ROW_FRESH_AT = "2026-08-19T10:14:00.000Z";
    const RECEIVED_NOW = "2026-08-19T10:14:26.000Z";
    const RECEIVED_100S = "2026-08-19T10:12:46.000Z";
    const TASK_ID = "st_quiet_child";

    it("counts a quiet running digest row when receivedAt is now and updatedAt is 300s old", () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const taskDigest = {
        tasks: [{ taskId: TASK_ID, status: "running", updatedAt: ROW_300S_AT }],
        truncated: false,
        receivedAt: RECEIVED_NOW,
      };
      const summary = summarizeLiveSession({
        id: "quiet-child",
        title: "",
        task: null,
        dag: null,
        taskOversized: true,
        taskDigest,
      });

      expect(summary.runningCount).toBe(1);
    });

    it("drops a quiet running digest row when receivedAt is 100s old and updatedAt is 300s old", () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const taskDigest = {
        tasks: [{ taskId: TASK_ID, status: "running", updatedAt: ROW_300S_AT }],
        truncated: false,
        receivedAt: RECEIVED_100S,
      };
      const summary = summarizeLiveSession({
        id: "stale-digest",
        title: "",
        task: null,
        dag: null,
        taskOversized: true,
        taskDigest,
      });

      expect(summary.runningCount).toBe(0);
    });

    it("drops a quiet running digest row when receivedAt is absent and updatedAt is 300s old", () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const summary = summarizeLiveSession({
        id: "legacy-stale",
        title: "",
        task: null,
        dag: null,
        taskOversized: true,
        taskDigest: {
          tasks: [{ taskId: TASK_ID, status: "running", updatedAt: ROW_300S_AT }],
          truncated: false,
        },
      });

      expect(summary.runningCount).toBe(0);
    });

    it("counts a digest row when receivedAt is absent and updatedAt is fresh", () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const summary = summarizeLiveSession({
        id: "legacy-fresh",
        title: "",
        task: null,
        dag: null,
        taskOversized: true,
        taskDigest: {
          tasks: [{ taskId: TASK_ID, status: "running", updatedAt: ROW_FRESH_AT }],
          truncated: false,
        },
      });

      expect(summary.runningCount).toBe(1);
    });

    it("counts a stale digest row refreshed by its task heartbeat", () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const summary = summarizeLiveSession({
        id: "heartbeat-digest",
        title: "",
        task: null,
        dag: null,
        taskOversized: true,
        taskDigest: {
          tasks: [{ taskId: TASK_ID, status: "running", updatedAt: ROW_300S_AT }],
          truncated: false,
        },
      }, Date.now(), {
        heartbeatStamps: new Map([[TASK_ID, ROW_FRESH_AT]]),
      });

      expect(summary.runningCount).toBe(1);
    });

    it("counts a stale digest row when a dag digest run lists that task id", () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const taskDigest = {
        tasks: [{ taskId: TASK_ID, status: "running", updatedAt: ROW_300S_AT }],
        truncated: false,
        receivedAt: RECEIVED_100S,
      };
      const dagDigest = {
        runs: [{ runId: "r1", status: "running", runningTaskIds: [TASK_ID] }],
        truncated: false,
        receivedAt: RECEIVED_100S,
      };
      const summary = summarizeLiveSession({
        id: "dag-authority",
        title: "",
        task: null,
        dag: null,
        taskOversized: true,
        dagOversized: true,
        taskDigest,
        dagDigest,
      });

      expect(summary.runningCount).toBe(1);
      expect(summary.dagRunning).toBe(0);
    });
  });
});

describe("activityDigest received_at", () => {
  const RECEIVED_AT = "2026-08-19T10:14:26.000Z";

  it("parses received_at onto a task digest", () => {
    expect(parseTaskDigest({
      tasks: [{ task_id: "t1", status: "running" }],
      truncated: false,
      received_at: RECEIVED_AT,
    })).toEqual({
      tasks: [{ taskId: "t1", status: "running" }],
      truncated: false,
      receivedAt: RECEIVED_AT,
    });
  });

  it("parses received_at onto a dag digest", () => {
    expect(parseDagDigest({
      runs: [{ run_id: "r1", status: "running", running_task_ids: ["t1"] }],
      truncated: false,
      received_at: RECEIVED_AT,
    })).toEqual({
      runs: [{ runId: "r1", status: "running", runningTaskIds: ["t1"] }],
      truncated: false,
      receivedAt: RECEIVED_AT,
    });
  });

  it("omits receivedAt when received_at is absent", () => {
    expect(parseTaskDigest({
      tasks: [{ task_id: "t1", status: "running" }],
      truncated: false,
    })).toEqual({
      tasks: [{ taskId: "t1", status: "running" }],
      truncated: false,
    });
  });

  it("keeps a task digest valid when received_at is a non-string", () => {
    expect(parseTaskDigest({
      tasks: [{ task_id: "t1", status: "running" }],
      truncated: false,
      received_at: 1,
    })).toEqual({
      tasks: [{ taskId: "t1", status: "running" }],
      truncated: false,
    });
  });

  it("keeps a dag digest valid when received_at is a non-string", () => {
    expect(parseDagDigest({
      runs: [{ run_id: "r1", status: "running", running_task_ids: [] }],
      truncated: false,
      received_at: null,
    })).toEqual({
      runs: [{ runId: "r1", status: "running", runningTaskIds: [] }],
      truncated: false,
    });
  });

  it("parses the agent aggregate onto both digests", () => {
    expect(parseTaskDigest({
      tasks: [{ task_id: "t1", status: "running" }],
      truncated: true,
      running_count: 50,
      total_count: 600,
      agent_running_count: 50,
      agent_total_count: 600,
    })).toEqual({
      tasks: [{ taskId: "t1", status: "running" }],
      truncated: true,
      taskRunningCount: 50,
      taskTotalCount: 600,
      taskAgentRunningCount: 50,
      taskAgentTotalCount: 600,
    });
    expect(parseDagDigest({
      runs: [{ run_id: "r1", status: "running", running_task_ids: ["t1"] }],
      truncated: true,
      running_count: 50,
      agent_running_count: 50,
      agent_total_count: 600,
    })).toEqual({
      runs: [{ runId: "r1", status: "running", runningTaskIds: ["t1"] }],
      truncated: true,
      dagRunningCount: 50,
      agentRunningCount: 50,
      agentTotalCount: 600,
    });
  });

  it("omits absent agent scalars and keeps digests valid on non-integer ones", () => {
    expect(parseTaskDigest({
      tasks: [],
      truncated: false,
      agent_running_count: "many",
    })).toEqual({ tasks: [], truncated: false });
    expect(parseDagDigest({
      runs: [],
      truncated: false,
      agent_total_count: null,
    })).toEqual({ runs: [], truncated: false });
  });

  it("still rejects a malformed tasks array when received_at is present", () => {
    expect(parseTaskDigest({
      tasks: "nope",
      truncated: false,
      received_at: RECEIVED_AT,
    })).toBeNull();
  });
});

describe("live polling hooks", () => {
  let container: HTMLDivElement;
  let root: Root;
  let handlers: ChatHandlers | undefined;
  let client: ChatClient;
  let captured: {
    summaries: readonly LiveSessionSummary[];
    ids: ReadonlySet<string>;
  };

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    client = { send: vi.fn(() => true), close: vi.fn() };
    vi.mocked(connectChat).mockImplementation((nextHandlers) => {
      handlers = nextHandlers;
      return client;
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    captured = { summaries: [], ids: new Set() };
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function Host({ enabled }: { readonly enabled: boolean }): null {
    captured.summaries = useLiveSessionSummaries(enabled);
    captured.ids = useLiveSessions(enabled);
    return null;
  }

  function openPush(): void {
    act(() => handlers?.onOpen?.());
  }

  type ActivityFrameInput = Omit<
    Extract<ChatServerFrame, { readonly type: "sessions.activity" }>,
    "durableSessionId"
  > & {
    readonly durableSessionId?: string;
    readonly replacesSessionId?: string;
    readonly tombstone?: boolean;
  };

  function push(frame: ChatServerFrame | ActivityFrameInput): void {
    act(() => handlers?.onFrame(frame.type === "sessions.activity"
      ? { ...frame, durableSessionId: frame.durableSessionId ?? frame.sessionId } : frame));
  }

  it("updates overview rows from pushed lean session scalars", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse({ sessions: [] })));
    await act(async () => root.render(<Host enabled={true} />));
    openPush();

    push({
      type: "sessions.activity",
      sessionId: "child-1",
      running: { agents: 2, tasks: 1, dag: 1 }, done: 3, dag_done: 2, dag_total: 3, last_line: "ls",
      overflow: false,
    });

    expect(captured.summaries[0]).toMatchObject({
      id: "child-1",
      runningCount: 2,
      doneCount: 3,
      dagDone: 2,
      dagTotal: 3,
      lastLine: "ls",
    });
    expect(Array.from(captured.ids)).toEqual(["child-1"]);
    expect(client.send).toHaveBeenCalledWith({ type: "sessions.subscribe", mode: "all_live" });
  });

  it("falls back to the existing REST poll when no push arrives", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => okResponse({ sessions: [{ id: "rest-1", title: "REST", task: null, dag: null }] }));
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => root.render(<Host enabled={true} />));

    expect(captured.summaries.map((summary) => summary.id)).toEqual(["rest-1"]);
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("unsubscribes and closes the overview socket on unmount", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse({ sessions: [] })));
    await act(async () => root.render(<Host enabled={true} />));
    openPush();

    act(() => root.unmount());

    expect(client.send).toHaveBeenLastCalledWith({ type: "sessions.subscribe", mode: "none" });
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("repairs a stale same-id snapshot with the REST refresh after overflow", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okResponse({ sessions: [] }))
      .mockResolvedValueOnce(okResponse({
        sessions: [{ id: "overflow-child", title: "Recovered", last_activity_ms: 2, running: { agents: 0 } }],
      }));
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => root.render(<Host enabled={true} />));
    openPush();

    push({
      type: "sessions.activity",
      sessionId: "overflow-child",
      last_activity_ms: 1, running: { agents: 1 },
      overflow: true,
    });
    expect(captured.summaries[0]).toMatchObject({ id: "overflow-child", runningCount: 1 });

    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(captured.summaries[0]).toMatchObject({ id: "overflow-child", title: "Recovered", runningCount: 0 });
  });

  it("lets a successful poll started after a push replace the same-id activity", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okResponse({ sessions: [] }))
      .mockResolvedValueOnce(okResponse({
        sessions: [{ id: "same-id", title: "REST", last_activity_ms: 2, running: { agents: 0 } }],
      }));
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => root.render(<Host enabled={true} />));
    openPush();
    push({
      type: "sessions.activity",
      sessionId: "same-id",
      last_activity_ms: 1, running: { agents: 1 },
      overflow: false,
    });
    expect(captured.summaries[0]?.runningCount).toBe(1);

    await act(async () => vi.advanceTimersByTimeAsync(4000));

    expect(captured.summaries[0]).toMatchObject({ id: "same-id", title: "REST", runningCount: 0 });
  });

  it("retains the newer complete lean revision when a stale poll races a push", async () => {
    vi.useFakeTimers();
    let resolvePoll: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okResponse({ sessions: [] }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolvePoll = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => root.render(<Host enabled={true} />));
    openPush();
    push({
      type: "sessions.activity",
      sessionId: "split-order",
      last_activity_ms: 1, running: { agents: 1 },
      overflow: false,
    });

    await act(async () => vi.advanceTimersByTimeAsync(4000));
    push({
      type: "sessions.activity",
      sessionId: "split-order", title: "Newest",
      last_activity_ms: 3, running: { agents: 1, dag: 1 },
      overflow: false,
    });
    await act(async () => resolvePoll?.(okResponse({
      sessions: [{ id: "split-order", title: "REST", last_activity_ms: 2, running: { agents: 0, dag: 0 } }],
    })));

    expect(captured.summaries[0]).toMatchObject({
      id: "split-order",
      title: "Newest",
      lastLine: null,
      runningCount: 1,
      dagRunning: 1,
    });
  });

  it("remaps an unbound lean frame through explicit identity while an attach poll is pending", async () => {
    vi.useFakeTimers();
    let resolveAttach: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okResponse({ sessions: [] }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveAttach = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => root.render(<Host enabled={true} />));
    openPush();
    await act(async () => vi.advanceTimersByTimeAsync(4000));

    push({
      type: "sessions.activity",
      sessionId: "durable-child", last_activity_ms: 2, running: { agents: 1 },
      overflow: false,
    });
    push({ type: "sessions.activity", sessionId: "attached-chat", durableSessionId: "durable-child",
      title: "Attached", last_activity_ms: 3, running: { agents: 1 }, overflow: false });
    await act(async () => resolveAttach?.(okResponse({
      sessions: [{
        id: "attached-chat",
        title: "Attached",
        last_activity_ms: 1, running: { agents: 0 },
      }],
    })));

    expect(captured.summaries).toHaveLength(1);
    expect(captured.summaries[0]).toMatchObject({ id: "attached-chat", title: "Attached", runningCount: 1 });
  });

  it("atomically remaps a provisional durable row without REST", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    await act(async () => root.render(<Host enabled={true} />));
    openPush();

    push({
      type: "sessions.activity",
      sessionId: "durable-child",
      running: { agents: 1 }, last_line: "ls",
      overflow: false,
    });
    push({
      type: "sessions.activity",
      sessionId: "attached-chat",
      durableSessionId: "durable-child",
      replacesSessionId: "durable-child",
      running: { agents: 2, dag: 1 }, last_line: "ls",
      overflow: false,
    });

    expect(captured.summaries).toHaveLength(1);
    expect(captured.summaries[0]).toMatchObject({
      id: "attached-chat",
      runningCount: 2,
      lastLine: "ls",
      dagRunning: 1,
    });
    expect(Array.from(captured.ids)).toEqual(["attached-chat"]);
  });

  it("removes a provisional row when the backend uses a tombstone remap", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    await act(async () => root.render(<Host enabled={true} />));
    openPush();

    push({
      type: "sessions.activity",
      sessionId: "durable-child",
      running: { agents: 1 },
      overflow: false,
    });
    push({
      type: "sessions.activity",
      sessionId: "durable-child",
      tombstone: true,
      overflow: false,
    });

    expect(captured.summaries).toEqual([]);
    expect(Array.from(captured.ids)).toEqual([]);
  });

  it("bounds push-only rows while REST is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    await act(async () => root.render(<Host enabled={true} />));
    openPush();

    act(() => {
      for (let index = 0; index < 257; index += 1) {
        handlers?.onFrame({
          type: "sessions.activity",
          sessionId: `push-${index}`,
          durableSessionId: `push-${index}`,
          running: { agents: 0 },
          overflow: false,
        });
      }
    });

    expect(captured.summaries).toHaveLength(256);
    expect(captured.ids.has("push-0")).toBe(false);
    expect(captured.ids.has("push-256")).toBe(true);
  });

  it("exposes per-session summaries and keeps the ReadonlySet id contract", async () => {
    const fetchMock = vi.fn(async () =>
      okResponse({
        sessions: [
          { id: "s1", title: "Refactor auth", running: { agents: 2, dag: 1 }, done: 3, dag_done: 2, dag_total: 3, last_line: "ls" },
          { id: "s2", title: "Bare", task: null, dag: null },
          "legacy",
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      root.render(<Host enabled={true} />);
    });

    expect(captured.summaries.map((summary) => summary.id)).toEqual(["s1", "s2", "legacy"]);
    expect(captured.summaries[0]).toMatchObject({
      id: "s1",
      title: "Refactor auth",
      runningCount: 2,
      doneCount: 3,
      dagDone: 2,
      dagTotal: 3,
      lastLine: "ls",
      dagRunning: 1,
    });
    expect(captured.summaries[1]).toMatchObject({ id: "s2", runningCount: 0, lastLine: null });
    expect(captured.summaries[2]).toMatchObject({ id: "legacy", title: "" });
    expect(captured.ids).toBeInstanceOf(Set);
    expect(Array.from(captured.ids)).toEqual(["s1", "s2", "legacy"]);
  });

  it("surfaces independent task and DAG truncation from the lean payload", async () => {
    const fetchMock = vi.fn(async () =>
      okResponse({
        sessions: [{ id: "s1", title: "Huge", truncated: { task: true, dag: true } }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      root.render(<Host enabled={true} />);
    });

    expect(captured.summaries[0]).toMatchObject({
      id: "s1",
      runningCount: 0,
      taskSideOversized: true,
      dagSideOversized: true,
    });
  });

  it("keeps counting a quiet running task while identical polls retain session identity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T10:00:00.000Z"));
    const response = okResponse({
      sessions: [
        {
          id: "quiet",
          title: "Quiet agent",
          last_activity_ms: 1, running: { agents: 1 },
        },
      ],
    });
    const fetchMock = vi.fn(async () => response);
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => root.render(<Host enabled={true} />));
    expect(captured.summaries[0]?.runningCount).toBe(1);
    const initialSummary = captured.summaries[0];

    await act(async () => vi.advanceTimersByTimeAsync(105_000));

    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(captured.summaries[0]).not.toBe(initialSummary);
    expect(captured.summaries[0]?.runningCount).toBe(1);
  });

  it("prunes a session's running counts when it disappears from the live list", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T10:00:00.000Z"));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okResponse({
        sessions: [
          {
            id: "zombie",
            title: "Died mid-run",
            last_activity_ms: 1, running: { agents: 1 },
          },
        ],
      }))
      .mockResolvedValue(okResponse({ sessions: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => root.render(<Host enabled={true} />));
    expect(captured.summaries[0]?.runningCount).toBe(1);

    await act(async () => vi.advanceTimersByTimeAsync(4000));

    expect(captured.summaries).toEqual([]);
    expect(captured.ids.size).toBe(0);
  });

  it("does not let a stopped request apply or start a duplicate chain after resubscribe", async () => {
    vi.useFakeTimers();
    const requests: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => requests.push(resolve)));
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => root.render(<Host enabled={true} />));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => root.render(<Host enabled={false} />));
    await act(async () => root.render(<Host enabled={true} />));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => requests[0]?.(okResponse({ sessions: [{ id: "stale", title: "Stale" }] })));
    expect(captured.summaries).toEqual([]);
    await act(async () => requests[1]?.(okResponse({ sessions: [{ id: "fresh", title: "Fresh" }] })));
    expect(captured.summaries.map((summary) => summary.id)).toEqual(["fresh"]);

    await act(async () => vi.advanceTimersByTime(4000));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await act(async () => requests[2]?.(okResponse({ sessions: [] })));
  });

  it("returns empty state and never fetches while disabled", async () => {
    const fetchMock = vi.fn(async () => okResponse({ sessions: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      root.render(<Host enabled={false} />);
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(captured.summaries).toEqual([]);
    expect(captured.ids.size).toBe(0);
  });
});
