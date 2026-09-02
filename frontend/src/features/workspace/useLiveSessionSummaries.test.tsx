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
      nodes: [],
      edges: [],
      waves: [],
    },
    {
      run_id: "r2",
      run_key: "verify",
      name: "Verify",
      status: "pending",
      counts: { total: 1, pending: 1, blocked: 0, scheduled: 0, running: 0, completed: 1, failed: 0, cancelled: 0, skipped: 0 },
      nodes: [],
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
      truncatedTasks: false,
      taskOversized: false,
      dagOversized: false,
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
      truncatedTasks: false,
      taskOversized: false,
      dagOversized: false,
    });

    const garbage = summarizeLiveSession({ id: "s3", title: "", task: { tasks: "nope" }, dag: { runs: 1 }, ...NOT_OVERSIZED });
    expect(garbage.runningCount).toBe(0);
    expect(garbage.doneCount).toBe(0);
    expect(garbage.dagTotal).toBe(0);
    expect(garbage.lastLine).toBeNull();
    expect(garbage.dagRunning).toBe(0);
    expect(garbage.truncatedTasks).toBe(false);
    expect(garbage.taskOversized).toBe(false);
    expect(garbage.dagOversized).toBe(false);
  });

  it("drops stale quiet agents from the running count", () => {
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

  it("counts dag running children when there are no task rows", () => {
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

    expect(summary.runningCount).toBe(3);
    expect(summary.dagRunning).toBe(3);
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

  it("surfaces truncated_tasks from the task payload", () => {
    const summary = summarizeLiveSession({
      id: "trunc",
      title: "",
      task: { truncated_tasks: true, tasks: [] },
      dag: null,
      ...NOT_OVERSIZED,
    });

    expect(summary.truncatedTasks).toBe(true);
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
      taskOversized: true,
      dagOversized: true,
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
      expect(summary.taskOversized).toBe(false);
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

    it("marks a truncated digest partial for the N+ path instead of unknown", () => {
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
      expect(summary.truncatedTasks).toBe(true);
      expect(summary.taskOversized).toBe(false);
      expect(summary.dagOversized).toBe(false);
    });

    it("keeps the unknown oversized path when no digest is present", () => {
      const summary = summarizeLiveSession({
        id: "over-no-digest",
        title: "",
        task: null,
        dag: null,
        taskOversized: true,
      });

      expect(summary.runningCount).toBe(0);
      expect(summary.taskOversized).toBe(true);
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

  function push(frame: ChatServerFrame): void {
    act(() => handlers?.onFrame(frame));
  }

  it("updates overview rows from pushed child-session snapshots", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse({ sessions: [] })));
    await act(async () => root.render(<Host enabled={true} />));
    openPush();

    push({
      type: "sessions.activity",
      sessionId: "child-1",
      snapshots: [
        { name: "omo.task.updated", oversized: false, data: TASK_PAYLOAD },
        { name: "omo.dag.updated", oversized: false, data: DAG_PAYLOAD },
      ],
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
        sessions: [{ id: "overflow-child", title: "Recovered", task: null, dag: null }],
      }));
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => root.render(<Host enabled={true} />));
    openPush();

    push({
      type: "sessions.activity",
      sessionId: "overflow-child",
      snapshots: [{ name: "omo.task.updated", oversized: false, data: TASK_PAYLOAD }],
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
        sessions: [{ id: "same-id", title: "REST", task: null, dag: null }],
      }));
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => root.render(<Host enabled={true} />));
    openPush();
    push({
      type: "sessions.activity",
      sessionId: "same-id",
      snapshots: [{ name: "omo.task.updated", oversized: false, data: TASK_PAYLOAD }],
      overflow: false,
    });
    expect(captured.summaries[0]?.runningCount).toBe(1);

    await act(async () => vi.advanceTimersByTimeAsync(4000));

    expect(captured.summaries[0]).toMatchObject({ id: "same-id", title: "REST", runningCount: 0 });
  });

  it("settles task and DAG independently when one side races a poll", async () => {
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
      snapshots: [{ name: "omo.task.updated", oversized: false, data: TASK_PAYLOAD }],
      overflow: false,
    });

    await act(async () => vi.advanceTimersByTimeAsync(4000));
    push({
      type: "sessions.activity",
      sessionId: "split-order",
      snapshots: [{ name: "omo.dag.updated", oversized: false, data: DAG_PAYLOAD }],
      overflow: false,
    });
    await act(async () => resolvePoll?.(okResponse({
      sessions: [{ id: "split-order", title: "REST", task: null, dag: null }],
    })));

    expect(captured.summaries[0]).toMatchObject({
      id: "split-order",
      title: "REST",
      lastLine: null,
      runningCount: 1,
      dagRunning: 1,
    });
  });

  it("remaps an unbound frame that races the attach poll onto the chat id", async () => {
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
      sessionId: "durable-child",
      snapshots: [{
        name: "omo.task.updated",
        oversized: false,
        data: { ...TASK_PAYLOAD, parent_session_id: "durable-child" },
      }],
      overflow: false,
    });
    await act(async () => resolveAttach?.(okResponse({
      sessions: [{
        id: "attached-chat",
        title: "Attached",
        task: { parent_session_id: "durable-child", tasks: [] },
        dag: null,
      }],
    })));

    expect(captured.summaries).toHaveLength(1);
    expect(captured.summaries[0]).toMatchObject({ id: "attached-chat", title: "Attached", runningCount: 1 });
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
          snapshots: [{ name: "omo.task.updated", oversized: false, data: null }],
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
          { id: "s1", title: "Refactor auth", task: TASK_PAYLOAD, dag: DAG_PAYLOAD },
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
      truncatedTasks: false,
      taskOversized: false,
      dagOversized: false,
    });
    expect(captured.summaries[1]).toMatchObject({ id: "s2", runningCount: 0, lastLine: null });
    expect(captured.summaries[2]).toMatchObject({ id: "legacy", title: "" });
    expect(captured.ids).toBeInstanceOf(Set);
    expect(Array.from(captured.ids)).toEqual(["s1", "s2", "legacy"]);
  });

  it("surfaces task_oversized and dag_oversized from the live payload", async () => {
    const fetchMock = vi.fn(async () =>
      okResponse({
        sessions: [{ id: "s1", title: "Huge", task: null, dag: null, task_oversized: true, dag_oversized: true }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      root.render(<Host enabled={true} />);
    });

    expect(captured.summaries[0]).toMatchObject({
      id: "s1",
      taskOversized: true,
      dagOversized: true,
    });
  });

  it("expires a quiet running task while identical polls retain session identity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T10:00:00.000Z"));
    const response = okResponse({
      sessions: [
        {
          id: "quiet",
          title: "Quiet agent",
          task: {
            tasks: [
              {
                task_id: "t1",
                name: "Quiet",
                status: "running",
                updated_at: "2026-08-19T09:59:59.000Z",
              },
            ],
          },
          dag: null,
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
    expect(captured.summaries[0]?.runningCount).toBe(0);
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
