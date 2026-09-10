import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectChat, parseChatServerFrame, type ChatHandlers } from "../../lib/chatWs";
import { useLiveSessionSummaries, type LiveSessionSummary } from "./useLiveSessionSummaries";
import { __resetLiveBadgeStoreForTests, useMergedLiveSummaries } from "./liveBadgeStore";
import { parseDagDigest, parseTaskDigest } from "./activityDigest";

vi.mock("../../lib/chatWs", async importOriginal => ({ ...await importOriginal<object>(), connectChat: vi.fn() }));

// Producer-to-parser-to-mounted-consumer regressions for one combined
// envelope (GET /api/sessions/live entry or sessions.activity frame): the
// server's current computed digests are the aggregate authority, while a
// snapshot payload's per-side scalar can be a cached older snapshot that
// must never be promoted to the new delivery's admission sequence. The
// producer fixtures rebuild the real captured delivery contract: a named
// DAG run with one running node task (cached DAG snapshot at aggregate
// 1/1) beside task-side rows and digests computed after further agent work.

const SESSION_ID = "chat-counts";
const DURABLE_ID = "durable-00000001-4f2a-9c31";
const DAG_AT = "2026-09-10T10:01:00Z";
const TASK_AT = "2026-09-10T10:02:00Z";
const RECEIVED_AT = "2026-09-10T10:02:59Z";
const TASK_DONE_AT = "2026-09-10T10:04:00Z";
const RECEIVED_DONE_AT = "2026-09-10T10:04:59Z";

/** The cached DAG snapshot from the captured delivery: one named running
 * node task at aggregate 1/1, row-stamped before the task-side rows. */
function cachedDagSnapshot(): Record<string, unknown> {
  return {
    parent_session_id: DURABLE_ID,
    truncated_runs: false,
    running_count: 1,
    agent_running_count: 1,
    agent_total_count: 1,
    runs: [{
      run_id: "r",
      run_key: "r",
      name: "Graph",
      status: "running",
      updated_at: DAG_AT,
      counts: { total: 1, pending: 0, blocked: 0, scheduled: 0, running: 1, completed: 0, failed: 0, cancelled: 0, skipped: 0 },
      nodes: [{ id: "n", task_id: "dag-work", prompt: "DAG-only", depends_on: [], state: "running" }],
      edges: [],
      waves: [],
    }],
  };
}

function taskSnapshot(status: "running" | "completed", agentRunning: number, agentTotal: number): Record<string, unknown> {
  const at = status === "completed" ? TASK_DONE_AT : TASK_AT;
  return {
    parent_session_id: DURABLE_ID,
    truncated_tasks: false,
    running_count: status === "running" ? 1 : 0,
    total_count: 1,
    agent_running_count: agentRunning,
    agent_total_count: agentTotal,
    tasks: [{ task_id: "t", name: "Task", status, updated_at: at }],
  };
}

function taskDigestField(status: "running" | "completed", agentRunning: number, agentTotal: number): Record<string, unknown> {
  const at = status === "completed" ? TASK_DONE_AT : TASK_AT;
  return {
    tasks: [{ task_id: "t", status, updated_at: at }],
    running_count: status === "running" ? 1 : 0,
    total_count: 1,
    agent_running_count: agentRunning,
    agent_total_count: agentTotal,
    truncated: false,
    received_at: status === "completed" ? RECEIVED_DONE_AT : RECEIVED_AT,
  };
}

function dagDigestField(agentRunning: number, agentTotal: number, runningTaskIds: readonly string[], completed: boolean): Record<string, unknown> {
  return {
    runs: [{ run_id: "r", status: "running", running_task_ids: runningTaskIds }],
    running_count: runningTaskIds.length,
    agent_running_count: agentRunning,
    agent_total_count: agentTotal,
    truncated: false,
    received_at: completed ? RECEIVED_DONE_AT : RECEIVED_AT,
  };
}

/** The captured addition envelope: both current digests aggregate the newer
 * agent work while the cached DAG snapshot still carries its older 1/1 scalar. */
function additionEnvelope(agentRunning = 2): {
  readonly task: Record<string, unknown>;
  readonly dag: Record<string, unknown>;
  readonly taskDigest: Record<string, unknown>;
  readonly dagDigest: Record<string, unknown>;
} {
  return {
    task: taskSnapshot("running", agentRunning, agentRunning),
    dag: cachedDagSnapshot(),
    taskDigest: taskDigestField("running", agentRunning, agentRunning),
    dagDigest: dagDigestField(agentRunning, agentRunning, ["dag-work"], false),
  };
}

/** The mirrored completion envelope: both current digests complete all agent
 * work while the cached DAG snapshot still shows its running 1/1 scalar. */
function completionEnvelope(): {
  readonly task: Record<string, unknown>;
  readonly dag: Record<string, unknown>;
  readonly taskDigest: Record<string, unknown>;
  readonly dagDigest: Record<string, unknown>;
} {
  return {
    task: taskSnapshot("completed", 0, 2),
    dag: cachedDagSnapshot(),
    taskDigest: taskDigestField("completed", 0, 2),
    dagDigest: dagDigestField(0, 2, [], true),
  };
}

function restBody(envelope: ReturnType<typeof additionEnvelope>): Record<string, unknown> {
  return { sessions: [{
    id: SESSION_ID,
    title: "Exact counts",
    task: envelope.task,
    dag: envelope.dag,
    task_digest: envelope.taskDigest,
    dag_digest: envelope.dagDigest,
    task_oversized: false,
    dag_oversized: false,
  }] };
}

function activityFrame(envelope: ReturnType<typeof additionEnvelope>): Record<string, unknown> {
  return {
    type: "sessions.activity",
    sessionId: SESSION_ID,
    durableSessionId: DURABLE_ID,
    overflow: false,
    snapshots: [
      { name: "omo.task.updated", data: envelope.task, oversized: false },
      { name: "omo.dag.updated", data: envelope.dag, oversized: false },
    ],
    taskDigest: envelope.taskDigest,
    dagDigest: envelope.dagDigest,
  };
}

describe("current digest aggregate authority within one combined envelope (review r4 H1)", () => {
  let root: Root;
  let container: HTMLDivElement;
  let handlers: ChatHandlers;
  let requests: ((response: Response) => void)[];
  let overview: readonly LiveSessionSummary[];
  let merged: readonly LiveSessionSummary[];

  function Host(): null {
    overview = useLiveSessionSummaries(true);
    merged = useMergedLiveSummaries(overview);
    return null;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-10T10:03:00Z"));
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    __resetLiveBadgeStoreForTests();
    requests = [];
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => requests.push(resolve))));
    vi.mocked(connectChat).mockImplementation(h => {
      handlers = h;
      return { send: () => true, close: () => undefined };
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(<Host />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    __resetLiveBadgeStoreForTests();
  });

  async function restSettle(body: unknown): Promise<void> {
    const resolve = requests.shift();
    expect(resolve).toBeTypeOf("function");
    await act(async () => resolve!(new Response(JSON.stringify(body))));
  }

  function pushActivity(envelope: ReturnType<typeof additionEnvelope>): void {
    const parsed = parseChatServerFrame(activityFrame(envelope));
    expect(parsed).not.toBeNull();
    act(() => handlers.onFrame(parsed!));
  }

  function counts(running: number, done: number): void {
    expect(overview[0]).toMatchObject({ runningCount: running, doneCount: done });
    expect(merged[0]).toMatchObject({ runningCount: running, doneCount: done });
  }

  it("the producer fixtures parse through the real frame and digest parsers", () => {
    expect(parseChatServerFrame(activityFrame(additionEnvelope()))).not.toBeNull();
    expect(parseChatServerFrame(activityFrame(completionEnvelope()))).not.toBeNull();
    expect(parseTaskDigest(additionEnvelope().taskDigest)).toMatchObject({ taskAgentRunningCount: 2, taskAgentTotalCount: 2 });
    expect(parseDagDigest(additionEnvelope().dagDigest)).toMatchObject({ agentRunningCount: 2, agentTotalCount: 2 });
    expect(parseTaskDigest(completionEnvelope().taskDigest)).toMatchObject({ taskAgentRunningCount: 0, taskAgentTotalCount: 2 });
    expect(parseDagDigest(completionEnvelope().dagDigest)).toMatchObject({ agentRunningCount: 0, agentTotalCount: 2 });
  });

  it.each(["REST", "WS"] as const)(
    "elects the current digest aggregate over the cached DAG snapshot in a combined %s envelope (addition)",
    async path => {
      if (path === "REST") await restSettle(restBody(additionEnvelope()));
      else pushActivity(additionEnvelope());
      counts(2, 0);
    },
  );

  it.each(["REST", "WS"] as const)(
    "elects the current digest completion over the cached DAG snapshot in a combined %s envelope",
    async path => {
      if (path === "REST") await restSettle(restBody(completionEnvelope()));
      else pushActivity(completionEnvelope());
      counts(0, 1);
    },
  );

  it("keeps accepted request/live sequencing across digest-bearing deliveries in both directions", async () => {
    // The mounted request predates every live admission: its digest settles.
    await restSettle(restBody(additionEnvelope()));
    counts(2, 0);
    // A live frame arriving after that request still advances the aggregate.
    pushActivity(additionEnvelope(3));
    counts(3, 0);
    // A request started after the live arrival settles the digest completion.
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    await restSettle(restBody(completionEnvelope()));
    counts(0, 1);
  });
});
