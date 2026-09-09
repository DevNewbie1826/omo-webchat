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

function summaryOf(dag: unknown): LiveSessionSummary {
  // sessionLive mirrors the sidebar's merged poll summaries.
  return summarizeLiveSession({ id: "s1", title: "Session", task: null, dag }, NOW, { sessionLive: true });
}

function mockCompleteDagRuns(): void {
  vi.mocked(apiJson).mockImplementation(async (path: string) => {
    if (path === DAG_RUNS) return catalog;
    if (path === `${DAG_RUNS}/r1`) return completeDoc;
    throw new Error(`Unexpected API path: ${path}`);
  });
}

function mockDagRunsError(status: number): void {
  vi.mocked(apiJson).mockImplementation(async () => {
    throw new ApiError(status, `status ${status}`);
  });
}

const dagRunsCalls = (): readonly string[] =>
  vi.mocked(apiJson).mock.calls.map(([path]) => path).filter((path) => path.includes("/dag-runs"));

let latest: readonly LiveSessionSummary[] = [];

function Probe(props: {
  readonly summaries: readonly LiveSessionSummary[];
  readonly workspaces: readonly Workspace[];
}) {
  latest = useCompleteDagBadgeSummaries(props.summaries, props.workspaces);
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
    vi.mocked(apiJson).mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderWith(summaries: readonly LiveSessionSummary[]): void {
    act(() => root.render(<Probe summaries={summaries} workspaces={[workspace]} />));
  }

  async function flush(): Promise<void> {
    await act(async () => {
      for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    });
  }

  it("C001: recovers the exact running count when complete documents cover every active run", async () => {
    mockCompleteDagRuns();
    renderWith([summaryOf(partial)]);
    expect(latest[0]).toMatchObject({ runningCount: 1, truncatedTasks: true });
    await flush();
    expect(latest).toHaveLength(1);
    expect(latest[0]).toMatchObject({ runningCount: 2, truncatedTasks: false, dagOversized: false });
  });

  it.each([404, 422])("C002: keeps the payload summary when dag-runs responds %i", async (status) => {
    mockDagRunsError(status);
    renderWith([summaryOf(partial)]);
    await flush();
    expect(latest[0]).toMatchObject({ runningCount: 1, truncatedTasks: true });
  });

  it("C003: records zero dag-runs fetches for an unqualified complete snapshot", async () => {
    mockCompleteDagRuns();
    renderWith([summaryOf(full)]);
    await flush();
    for (let poll = 0; poll < 3; poll++) {
      renderWith([summaryOf(full)]);
      await flush();
    }
    expect(dagRunsCalls()).toEqual([]);
  });

  it("C003: fetches a bounded number of dag-runs per payload revision", async () => {
    mockCompleteDagRuns();
    renderWith([summaryOf(partial)]);
    await flush();
    const afterFirstCycle = dagRunsCalls().length;
    expect(afterFirstCycle).toBeGreaterThanOrEqual(1);
    for (let poll = 0; poll < 3; poll++) {
      renderWith([summaryOf(partial)]);
      await flush();
    }
    expect(dagRunsCalls().length).toBe(afterFirstCycle);
    // A newer payload revision triggers exactly one more bounded cycle, and a
    // stale document cannot downgrade the count the payload already confirmed.
    const newer = { runs: [{ ...fullRun, nodes: [nodeA], edges: [], updated_at: "2026-09-08T10:00:30Z" }], partial: true };
    renderWith([summaryOf(newer)]);
    await flush();
    expect(dagRunsCalls().length).toBe(afterFirstCycle + 2);
    expect(latest[0]).toMatchObject({ runningCount: 1, truncatedTasks: true });
  });
});
