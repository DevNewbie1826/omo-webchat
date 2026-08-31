import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { summarizeLiveSession, useLiveSessionSummaries } from "./useLiveSessionSummaries";
import { useLiveSessions } from "./useLiveSessions";
import type { LiveSessionSummary } from "./useLiveSessionSummaries";

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
    });

    expect(summary).toEqual({
      id: "s1",
      title: "Refactor auth",
      runningCount: 1,
      doneCount: 3,
      dagDone: 2,
      dagTotal: 3,
      lastLine: "ls",
    });
  });

  it("tolerates null and malformed payloads", () => {
    expect(
      summarizeLiveSession({ id: "s2", title: "Bare", task: null, dag: null }),
    ).toEqual({
      id: "s2",
      title: "Bare",
      runningCount: 0,
      doneCount: 0,
      dagDone: 0,
      dagTotal: 0,
      lastLine: null,
    });

    const garbage = summarizeLiveSession({ id: "s3", title: "", task: { tasks: "nope" }, dag: { runs: 1 } });
    expect(garbage.runningCount).toBe(0);
    expect(garbage.doneCount).toBe(0);
    expect(garbage.dagTotal).toBe(0);
    expect(garbage.lastLine).toBeNull();
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
    });

    expect(summary.lastLine).toBe("latest activity");
  });
});

describe("live polling hooks", () => {
  let container: HTMLDivElement;
  let root: Root;
  let captured: {
    summaries: readonly LiveSessionSummary[];
    ids: ReadonlySet<string>;
  };

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
      runningCount: 1,
      doneCount: 3,
      dagDone: 2,
      dagTotal: 3,
      lastLine: "ls",
    });
    expect(captured.summaries[1]).toMatchObject({ id: "s2", runningCount: 0, lastLine: null });
    expect(captured.summaries[2]).toMatchObject({ id: "legacy", title: "" });
    expect(captured.ids).toBeInstanceOf(Set);
    expect(Array.from(captured.ids)).toEqual(["s1", "s2", "legacy"]);
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
