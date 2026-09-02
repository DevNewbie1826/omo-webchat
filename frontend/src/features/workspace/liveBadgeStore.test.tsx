import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "../../components/Sidebar";
import { useMediaQuery } from "../../lib/useMediaQuery";
import {
  __resetLiveBadgeStoreForTests,
  ingestExtensionEvent,
  useLiveBadgeOverrides,
  useMergedLiveSummaries,
} from "./liveBadgeStore";
import type { LiveSessionSummary } from "./useLiveSessionSummaries";

vi.mock("../../lib/useMediaQuery", () => ({ useMediaQuery: vi.fn() }));

const TASK_RUNNING_1 = {
  parent_session_id: "s1",
  truncated_tasks: false,
  tasks: [{ task_id: "t1", name: "Live", status: "running", updated_at: "2026-08-19T10:00:00.000Z" }],
};

const DAG_RUNNING_2 = {
  parent_session_id: "s1",
  truncated_runs: false,
  runs: [
    {
      run_id: "r2",
      run_key: "poll",
      name: "Poll DAG",
      status: "running",
      counts: { total: 2, pending: 0, blocked: 0, scheduled: 0, running: 2, completed: 0, failed: 0, cancelled: 0, skipped: 0 },
      nodes: [],
      edges: [],
      waves: [],
    },
  ],
};

/** Payload shape reused from features/split/activityParse fixtures: one running run, counts.running=3, no node rows. */
const DAG_RUNNING_3 = {
  parent_session_id: "s1",
  truncated_runs: false,
  runs: [
    {
      run_id: "r1",
      run_key: "plan",
      name: "Ship",
      status: "running",
      counts: { total: 3, pending: 0, blocked: 0, scheduled: 0, running: 3, completed: 0, failed: 0, cancelled: 0, skipped: 0 },
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

const IDLE_POLL_SUMMARY: LiveSessionSummary = {
  id: "s1",
  title: "Attached",
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
};

interface Captured {
  overrides: ReadonlyMap<string, { readonly summary: LiveSessionSummary; readonly receivedAt: number }>;
  merged: readonly LiveSessionSummary[];
}

describe("liveBadgeStore", () => {
  let container: HTMLDivElement;
  let root: Root;
  let captured: Captured;

  beforeEach(() => {
    __resetLiveBadgeStoreForTests();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    captured = { overrides: new Map(), merged: [] };
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function Host({ pollSummaries }: { readonly pollSummaries: readonly LiveSessionSummary[] }): null {
    captured.overrides = useLiveBadgeOverrides();
    captured.merged = useMergedLiveSummaries(pollSummaries);
    return null;
  }

  it("exposes an ingested dag frame as the session summary without any HTTP poll", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T10:00:00.000Z"));
    act(() => {
      root.render(<Host pollSummaries={[]} />);
    });
    act(() => {
      ingestExtensionEvent("s1", "omo.dag.updated", DAG_RUNNING_3);
    });

    const override = captured.overrides.get("s1");
    expect(override?.summary.runningCount).toBe(3);
    expect(override?.summary.dagRunning).toBe(3);
    expect(override?.receivedAt).toBeTypeOf("number");
    expect(override?.receivedAt).toBeGreaterThan(0);
  });

  it("ignores an unknown frame name and keeps the map unchanged", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T10:00:00.000Z"));
    act(() => {
      root.render(<Host pollSummaries={[]} />);
    });
    act(() => {
      ingestExtensionEvent("s1", "omo.something.else", { tasks: [] });
    });

    expect(captured.overrides.has("s1")).toBe(false);
  });

  it("ignores an override that arrived before the current poll snapshot when merging", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T10:00:00.000Z"));
    act(() => {
      ingestExtensionEvent("s1", "omo.dag.updated", DAG_RUNNING_3);
    });
    // The poll snapshot arrives one second after the frame, so the frame is stale.
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    act(() => {
      root.render(<Host pollSummaries={[IDLE_POLL_SUMMARY]} />);
    });

    expect(captured.merged.map((summary) => summary.runningCount)).toEqual([0]);
  });

  it("prefers an override that arrived after the current poll snapshot when merging", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T10:00:00.000Z"));
    act(() => {
      root.render(<Host pollSummaries={[{ ...IDLE_POLL_SUMMARY, title: "Second snapshot" }]} />);
    });
    vi.setSystemTime(new Date("2026-08-19T10:00:01.000Z"));
    act(() => {
      ingestExtensionEvent("s1", "omo.dag.updated", DAG_RUNNING_3);
    });

    expect(captured.merged.map((summary) => summary.runningCount)).toEqual([3]);
    // Title and oversized flags are carried over from the poll summary the
    // override replaces: WS payloads carry neither. (dagOversized and others
    // come from the override; only the title is from the replaced poll row.)
    expect(captured.merged[0]?.title).toBe("Second snapshot");
  });

  it("merges task and dag independently so a task frame preserves the poll dag side", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T10:00:00.000Z"));
    const poll = {
      ...IDLE_POLL_SUMMARY,
      dag: DAG_RUNNING_2,
      runningCount: 2,
      dagRunning: 2,
      dagTotal: 2,
    };
    act(() => {
      root.render(<Host pollSummaries={[poll]} />);
    });
    act(() => {
      ingestExtensionEvent("s1", "omo.task.updated", TASK_RUNNING_1);
    });

    expect(captured.merged[0]).toMatchObject({ runningCount: 3, dagRunning: 2 });
  });

  it("preserves a poll task digest when a fresh dag-only frame replaces the other side", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T10:00:00.000Z"));
    const poll = {
      ...IDLE_POLL_SUMMARY,
      taskSideOversized: true,
      dagSideOversized: false,
      taskDigest: {
        tasks: [{ taskId: "t-digest", status: "running", updatedAt: "2026-08-19T10:00:00.000Z" }],
        truncated: false,
      },
      runningCount: 1,
    } as LiveSessionSummary;
    act(() => {
      root.render(<Host pollSummaries={[poll]} />);
    });
    act(() => {
      ingestExtensionEvent("s1", "omo.dag.updated", { runs: [] });
    });

    expect(captured.merged[0]?.runningCount).toBe(1);
  });

  it("keeps a quiet poll digest runningCount through a one-sided dag merge when receivedAt is fresh", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T10:14:26.000Z"));
    const poll = {
      ...IDLE_POLL_SUMMARY,
      taskSideOversized: true,
      dagSideOversized: false,
      taskDigest: {
        tasks: [{ taskId: "t-quiet", status: "running", updatedAt: "2026-08-19T10:09:26.000Z" }],
        truncated: false,
        receivedAt: "2026-08-19T10:14:26.000Z",
      },
      runningCount: 1,
    } as LiveSessionSummary;
    act(() => {
      root.render(<Host pollSummaries={[poll]} />);
    });
    act(() => {
      ingestExtensionEvent("s1", "omo.dag.updated", { runs: [] });
    });

    expect(captured.merged[0]?.runningCount).toBe(1);
  });

  it("preserves a poll dag digest when a fresh task-only frame replaces the other side", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T10:00:00.000Z"));
    const poll = {
      ...IDLE_POLL_SUMMARY,
      taskSideOversized: false,
      dagSideOversized: true,
      dagDigest: {
        runs: [{ runId: "r-digest", status: "running", runningTaskIds: ["t-dag"] }],
        truncated: false,
      },
      runningCount: 1,
      dagRunning: 1,
    } as LiveSessionSummary;
    act(() => {
      root.render(<Host pollSummaries={[poll]} />);
    });
    act(() => {
      ingestExtensionEvent("s1", "omo.task.updated", { tasks: [] });
    });

    expect(captured.merged[0]).toMatchObject({ runningCount: 1, dagRunning: 1 });
  });

  it("lets a later poll content change win after same-millisecond WS receipts advance the sequencer", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T10:00:00.000Z"));
    act(() => {
      root.render(<Host pollSummaries={[IDLE_POLL_SUMMARY]} />);
    });
    act(() => {
      ingestExtensionEvent("s1", "omo.task.updated", TASK_RUNNING_1);
      ingestExtensionEvent("s1", "omo.task.updated", TASK_RUNNING_1);
    });
    expect(captured.merged[0]?.runningCount).toBe(1);

    act(() => {
      root.render(<Host pollSummaries={[{ ...IDLE_POLL_SUMMARY, title: "New poll content" }]} />);
    });

    expect(captured.merged[0]?.runningCount).toBe(0);
  });

  it("clears a recognized side on null data and falls back to that poll side", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T10:00:00.000Z"));
    const poll = { ...IDLE_POLL_SUMMARY, task: TASK_RUNNING_1, runningCount: 1 };
    act(() => {
      root.render(<Host pollSummaries={[poll]} />);
    });
    act(() => {
      ingestExtensionEvent("s1", "omo.task.updated", {
        tasks: [
          ...TASK_RUNNING_1.tasks,
          { task_id: "t2", name: "Second", status: "running", updated_at: "2026-08-19T10:00:00.000Z" },
        ],
      });
    });
    expect(captured.merged[0]?.runningCount).toBe(2);

    act(() => {
      ingestExtensionEvent("s1", "omo.task.updated", null);
    });

    expect(captured.merged[0]?.runningCount).toBe(1);
  });

  it("expires an override once it is older than the 90s window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T10:00:00.000Z"));
    act(() => {
      root.render(<Host pollSummaries={[]} />);
    });
    act(() => {
      ingestExtensionEvent("s-expire", "omo.task.updated", {
        tasks: [{ task_id: "t1", name: "Live", status: "running", updated_at: "2026-08-19T09:59:59.000Z" }],
      });
    });
    expect(captured.overrides.has("s-expire")).toBe(true);

    await act(async () => vi.advanceTimersByTimeAsync(106_000));

    expect(captured.overrides.has("s-expire")).toBe(false);
  });

  it("merges a stale running task frame with a running dag node as runningCount 1", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T10:14:26.000Z"));
    act(() => {
      root.render(<Host pollSummaries={[IDLE_POLL_SUMMARY]} />);
    });
    act(() => {
      ingestExtensionEvent("s1", "omo.task.updated", {
        tasks: [{
          task_id: "st_01a058e3",
          name: "pin",
          status: "running",
          updated_at: "2026-08-19T10:00:00.000Z",
        }],
      });
      ingestExtensionEvent("s1", "omo.dag.updated", {
        runs: [{
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
          nodes: [{ id: "n1", prompt: "do", depends_on: [], state: "running", task_id: "st_01a058e3" }],
          edges: [],
          waves: [],
        }],
      });
    });

    expect(captured.merged[0]?.runningCount).toBe(1);
  });
});

describe("Sidebar badge over WS overrides", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    __resetLiveBadgeStoreForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T10:00:00.000Z"));
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.mocked(useMediaQuery).mockReturnValue(false);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function renderSidebar(): void {
    act(() => {
      root.render(
        <Sidebar
          collapsed={false}
          onToggleCollapse={() => undefined}
          workspaces={[
            {
              id: "ws-1",
              name: "Workspace",
              path: "/work",
              chats: [{ id: "tm-1", name: "Attached session", provider: "omo" }],
            },
          ]}
          activeTerminalId={null}
          placedSessions={new Set()}
          liveSessions={new Set(["tm-1"])}
          expanded={new Set(["ws-1"])}
          sessionLists={new Map([["ws-1", [{ id: "tm-1", name: "Attached session", source: "stored", recencyMs: 1 }]]])}
          sessionPages={new Map()}
          onToggleExpanded={() => undefined}
          onLoadMoreSessions={() => undefined}
          onSelectTerminal={() => undefined}
          onAdoptSession={async () => undefined}
          onAddWorkspace={() => undefined}
          onAddTerminal={() => undefined}
          onDeleteWorkspace={() => undefined}
          onDeleteTerminal={() => undefined}
          onRenameWorkspace={async () => undefined}
          onRenameTerminal={async () => undefined}
          onLogout={() => undefined}
          notify={() => undefined}
        />,
      );
    });
  }

  it("shows the running badge from an ingested frame without advancing the poller", async () => {
    // One idle poll snapshot lands; the next poll is scheduled 4s out and the
    // test never advances that far.
    const fetchMock = vi.fn(async () =>
      okResponse({ sessions: [{ id: "tm-1", title: "Attached session", task: null, dag: null }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderSidebar();
    await act(async () => {});
    expect(container.querySelector(".th-tree-running")).toBeNull();
    const pollsBeforeIngest = fetchMock.mock.calls.length;
    expect(pollsBeforeIngest).toBeGreaterThan(0);

    act(() => {
      ingestExtensionEvent("tm-1", "omo.dag.updated", DAG_RUNNING_3);
    });

    const badge = container.querySelector(".th-tree-running");
    expect(badge?.textContent).toContain("3");
    expect(fetchMock.mock.calls.length).toBe(pollsBeforeIngest);
  });
});
