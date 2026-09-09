import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiJson } from "../../lib/api";
import { useCompleteDagBadgeSummaries } from "./useCompleteDagBadgeSummaries";
import { summarizeLiveSession } from "./useLiveSessionSummaries";
import type { LiveSessionSummary } from "./useLiveSessionSummaries";
import type { LiveSessionInfo, Workspace } from "./workspace";

vi.mock("../../lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/api")>(),
  apiJson: vi.fn(),
}));

const NOW = Date.parse("2026-09-08T10:00:00Z");

const nodeA = { id: "a", prompt: "First full description", depends_on: [], state: "running", task_id: "t1" };
const nodeB = { id: "b", prompt: "Second full description", depends_on: ["a"], state: "running", task_id: "t2" };
const counts = { total: 2, pending: 0, blocked: 0, scheduled: 0, running: 2, completed: 0, failed: 0, cancelled: 0, skipped: 0 };
const fullRun = {
  run_id: "r1", run_key: "plan", name: "Plan", status: "running", counts,
  nodes: [nodeA, nodeB], edges: [{ from: "a", to: "b" }], waves: [],
};
// Structurally partial: the counts advertise 2 running while only 1 node is retained.
const partial = { runs: [{ ...fullRun, nodes: [nodeA], edges: [] }], partial: true };
const full = { runs: [fullRun], truncated_runs: false };

// GET .../dag-runs/{runId} contract: a complete run document.
const completeDoc = {
  complete: true,
  content_token: "tok-r1",
  run: { ...fullRun, created_at: "2026-09-08T09:58:00Z", updated_at: "2026-09-08T10:00:00Z" },
};
// GET .../dag-runs contract: the run catalog page.
const catalog = {
  runs: [{
    run_id: "r1", run_key: "plan", name: "Plan", status: "running",
    created_at: "2026-09-08T09:58:00Z", updated_at: "2026-09-08T10:00:00Z", total: 2, content_token: "tok-r1",
  }],
  next_cursor: null,
};

const workspace: Workspace = { id: "ws", name: "Workspace", path: "/fixture", chats: [{ id: "s1", name: "Session", provider: "omo" }] };
const DAG_RUNS = "/api/workspaces/ws/chats/s1/dag-runs";

function summaryOf(dag: unknown, overrides: Partial<LiveSessionInfo> = {}): LiveSessionSummary {
  // sessionLive mirrors the sidebar's merged poll summaries.
  return summarizeLiveSession({ id: "s1", title: "Session", task: null, dag, ...overrides }, NOW, { sessionLive: true });
}

interface PendingRequest {
  readonly path: string;
  readonly promise: Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

let pendingRequests: PendingRequest[] = [];

function controlDagRuns(): void {
  vi.mocked(apiJson).mockImplementation((path: string) => {
    let resolve!: (value: unknown) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<unknown>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    pendingRequests.push({ path, promise, resolve, reject });
    return promise;
  });
}

function takeRequest(path: string): PendingRequest {
  const index = pendingRequests.findIndex((request) => request.path === path);
  expect(index, `pending request ${path}`).toBeGreaterThanOrEqual(0);
  return pendingRequests.splice(index, 1)[0]!;
}

async function resolveRequest(path: string, value: unknown): Promise<void> {
  const request = takeRequest(path);
  await act(async () => {
    request.resolve(value);
    await request.promise;
  });
}

async function rejectRequest(path: string, status = 404): Promise<void> {
  const request = takeRequest(path);
  await act(async () => {
    request.reject(new ApiError(status, `status ${status}`));
    await request.promise.catch(() => undefined);
  });
}

async function recoverOne(doc: unknown = completeDoc): Promise<void> {
  await resolveRequest(DAG_RUNS, catalog);
  const recovered = waitForSummary((summaries) => summaries[0]?.truncatedTasks === false);
  await resolveRequest(`${DAG_RUNS}/r1`, doc);
  await recovered;
}

const dagRunsCalls = (): readonly string[] =>
  vi.mocked(apiJson).mock.calls.map(([path]) => path).filter((path) => path.includes("/dag-runs"));

let latest: readonly LiveSessionSummary[] = [];
let summaryWaiters: Array<{
  readonly predicate: (summaries: readonly LiveSessionSummary[]) => boolean;
  readonly resolve: () => void;
}> = [];

function publishSummaries(summaries: readonly LiveSessionSummary[]): void {
  latest = summaries;
  const ready = summaryWaiters.filter((waiter) => waiter.predicate(summaries));
  summaryWaiters = summaryWaiters.filter((waiter) => !ready.includes(waiter));
  ready.forEach((waiter) => waiter.resolve());
}

function waitForSummary(predicate: (summaries: readonly LiveSessionSummary[]) => boolean): Promise<void> {
  if (predicate(latest)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error("Timed out waiting for summary state")), 1_000);
    summaryWaiters.push({
      predicate,
      resolve: () => {
        window.clearTimeout(timeout);
        resolve();
      },
    });
  });
}

function Probe(props: {
  readonly summaries: readonly LiveSessionSummary[];
  readonly workspaces: readonly Workspace[];
}) {
  publishSummaries(useCompleteDagBadgeSummaries(props.summaries, props.workspaces));
  return null;
}

describe("useCompleteDagBadgeSummaries", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    pendingRequests = [];
    summaryWaiters = [];
    latest = [];
    vi.mocked(apiJson).mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderWith(summaries: readonly LiveSessionSummary[]): void {
    act(() => root.render(<Probe summaries={summaries} workspaces={[workspace]} />));
  }

  it("C001: recovers the exact running count when complete documents cover every active run", async () => {
    controlDagRuns();
    renderWith([summaryOf(partial)]);
    expect(latest[0]).toMatchObject({ runningCount: 1, truncatedTasks: true });
    await recoverOne();
    expect(latest).toHaveLength(1);
    expect(latest[0]).toMatchObject({ runningCount: 2, truncatedTasks: false, dagOversized: false });
  });

  it.each([404, 422])("C002: keeps the payload summary when dag-runs responds %i", async (status) => {
    controlDagRuns();
    renderWith([summaryOf(partial)]);
    await rejectRequest(DAG_RUNS, status);
    expect(latest[0]).toMatchObject({ runningCount: 1, truncatedTasks: true });
  });

  it("C003: records zero dag-runs fetches for an unqualified complete snapshot", () => {
    controlDagRuns();
    renderWith([summaryOf(full)]);
    for (let poll = 0; poll < 3; poll++) renderWith([summaryOf(full)]);
    expect(dagRunsCalls()).toEqual([]);
  });

  it("C003: fetches a bounded number of dag-runs per payload revision", async () => {
    controlDagRuns();
    renderWith([summaryOf(partial)]);
    await recoverOne();
    const afterFirstCycle = dagRunsCalls().length;
    expect(afterFirstCycle).toBeGreaterThanOrEqual(1);
    for (let poll = 0; poll < 3; poll++) renderWith([summaryOf(partial)]);
    expect(dagRunsCalls().length).toBe(afterFirstCycle);
    // A newer payload revision triggers exactly one more bounded cycle, and a
    // stale document cannot downgrade the count the payload already confirmed.
    const newer = { runs: [{ ...fullRun, nodes: [nodeA], edges: [], updated_at: "2026-09-08T10:00:30Z" }], partial: true };
    renderWith([summaryOf(newer)]);
    await resolveRequest(DAG_RUNS, catalog);
    await rejectRequest(`${DAG_RUNS}/r1`, 409);
    expect(dagRunsCalls().length).toBe(afterFirstCycle + 2);
    expect(latest[0]).toMatchObject({ runningCount: 1, truncatedTasks: true });
  });

  it("does not apply an old exact entry while a newer partial payload replacement is pending or after it fails", async () => {
    controlDagRuns();
    renderWith([summaryOf(partial)]);
    await recoverOne();
    const newer = {
      runs: [{ ...fullRun, nodes: [nodeA], edges: [], updated_at: "2026-09-08T10:01:00Z" }],
      partial: true,
    };
    renderWith([summaryOf(newer)]);
    expect(latest[0]).toMatchObject({ runningCount: 1, truncatedTasks: true });
    await rejectRequest(DAG_RUNS, 404);
    expect(latest[0]).toMatchObject({ runningCount: 1, truncatedTasks: true });
  });

  it("does not reuse a stale entry or loop fetches after same-revision retained content changes", async () => {
    controlDagRuns();
    renderWith([summaryOf(partial)]);
    await recoverOne();
    const threeCounts = { ...counts, total: 3, running: 3 };
    const changed = {
      runs: [{ ...fullRun, counts: threeCounts, nodes: [nodeA, nodeB], updated_at: undefined }],
      partial: true,
    };
    renderWith([summaryOf(changed)]);
    expect(latest[0]).toMatchObject({ runningCount: 2, truncatedTasks: true });
    expect(dagRunsCalls()).toHaveLength(3);
    for (let poll = 0; poll < 3; poll++) renderWith([summaryOf(changed)]);
    expect(dagRunsCalls()).toHaveLength(3);
  });

  it.each([undefined, "not-a-date"])("rejects a contradictory document when payload updated_at is %s", async (updatedAt) => {
    controlDagRuns();
    const unversioned = {
      runs: [{ ...fullRun, updated_at: updatedAt }],
      partial: true,
    };
    const oneCounts = { ...counts, total: 1, running: 1 };
    const contradictory = {
      ...completeDoc,
      run: { ...completeDoc.run, counts: oneCounts, nodes: [nodeA], edges: [] },
    };
    renderWith([summaryOf(unversioned)]);
    await resolveRequest(DAG_RUNS, catalog);
    await resolveRequest(`${DAG_RUNS}/r1`, contradictory);
    expect(latest[0]).toMatchObject({ runningCount: 2, truncatedTasks: true });
  });

  it("keeps the qualified count when only one of two active run documents succeeds", async () => {
    controlDagRuns();
    const run2 = {
      ...fullRun,
      run_id: "r2",
      run_key: "review",
      nodes: [{ ...nodeA, id: "c", task_id: "t3" }],
      counts: { ...counts, total: 1, running: 1 },
      edges: [],
    };
    const twoRunPartial = { runs: [{ ...fullRun, nodes: [nodeA], edges: [] }, run2], partial: true };
    const twoRunCatalog = {
      runs: [catalog.runs[0], { ...catalog.runs[0], run_id: "r2", run_key: "review", content_token: "tok-r2" }],
      next_cursor: null,
    };
    renderWith([summaryOf(twoRunPartial)]);
    await resolveRequest(DAG_RUNS, twoRunCatalog);
    await resolveRequest(`${DAG_RUNS}/r1`, completeDoc);
    await rejectRequest(`${DAG_RUNS}/r2`, 404);
    expect(latest[0]).toMatchObject({ runningCount: 2, truncatedTasks: true });
  });

  it("keeps task-side truncation after successful DAG recovery", async () => {
    controlDagRuns();
    renderWith([summaryOf(partial, { task: { tasks: [], truncated_tasks: true } })]);
    await resolveRequest(DAG_RUNS, catalog);
    const recovered = waitForSummary((summaries) => summaries[0]?.runningCount === 2);
    await resolveRequest(`${DAG_RUNS}/r1`, completeDoc);
    await recovered;
    expect(latest[0]).toMatchObject({ runningCount: 2, truncatedTasks: true });
  });

  it("keeps an unknown DAG summary after retrieval failure", async () => {
    controlDagRuns();
    renderWith([summaryOf(null, { dagOversized: true })]);
    await rejectRequest(DAG_RUNS, 404);
    expect(latest[0]).toMatchObject({ runningCount: 0, dagOversized: true, truncatedTasks: false });
  });

  it("makes zero DAG requests for task-only truncation across changing complete DAG revisions", () => {
    controlDagRuns();
    const task = { tasks: [], truncated_tasks: true };
    renderWith([summaryOf(full, { task })]);
    const revised = { runs: [{ ...fullRun, updated_at: "2026-09-08T10:01:00Z" }], truncated_runs: false };
    renderWith([summaryOf(revised, { task })]);
    expect(dagRunsCalls()).toEqual([]);
  });

  it("fetches when both task and DAG sides are qualified", () => {
    controlDagRuns();
    renderWith([summaryOf(partial, { task: { tasks: [], truncated_tasks: true } })]);
    expect(dagRunsCalls()).toEqual([DAG_RUNS]);
  });
});
