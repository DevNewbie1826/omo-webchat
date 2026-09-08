import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "../../components/Sidebar";
import { useLiveSessionInfos } from "./useLiveSessions";
import { __resetLiveBadgeStoreForTests } from "./liveBadgeStore";
import { summarizeLiveSession } from "./useLiveSessionSummaries";
import type { LiveSessionInfo, Workspace } from "./workspace";

vi.mock("./useLiveSessions", async (importOriginal) => ({
  ...await importOriginal<typeof import("./useLiveSessions")>(),
  useLiveSessionInfos: vi.fn(),
}));
vi.mock("../../lib/useMediaQuery", () => ({ useMediaQuery: () => false }));

const NOW = Date.parse("2026-09-08T10:00:00Z");
const nodeA = { id: "a", prompt: "First full description", depends_on: [], state: "running", task_id: "t1" };
const nodeB = { id: "b", prompt: "Second full description", depends_on: ["a"], state: "running", task_id: "t2" };
const counts = { total: 2, pending: 0, blocked: 0, scheduled: 0, running: 2, completed: 0, failed: 0, cancelled: 0, skipped: 0 };
const fullRun = {
  run_id: "r1", run_key: "plan", name: "Plan", status: "running", counts,
  nodes: [nodeA, nodeB], edges: [{ from: "a", to: "b" }], waves: [],
};
const full = { runs: [fullRun], truncated_runs: false };
const partial = { runs: [{ ...fullRun, nodes: [nodeA], edges: [] }], partial: true };
const incompleteZero = { runs: [{ ...fullRun, nodes: [], counts: { ...counts, total: 0, running: 0 }, edges: [] }], partial: true };
const malformedNode = { runs: [{ ...fullRun, nodes: [nodeA, { id: "b", prompt: "Lost", state: "running" }] }] };
const workspace: Workspace = { id: "ws", name: "Workspace", path: "/fixture", chats: [{ id: "s1", name: "Session", provider: "omo" }] };

function info(dag: unknown, task: unknown = null): LiveSessionInfo {
  return { id: "s1", title: "Session", task, dag };
}

const incompleteCases = [
  { name: "advertised running2 with one retained node", dag: partial, count: 1 },
  { name: "parser drops a malformed node", dag: malformedNode, count: 1 },
  { name: "zero retained incomplete topology", dag: incompleteZero, count: 0 },
  { name: "missing nodes and counts", dag: { runs: [{ run_id: "r1", run_key: "plan", name: "Plan", status: "running" }] }, count: 0 },
  { name: "malformed DAG envelope", dag: { runs: "invalid" }, count: 0 },
  { name: "missing DAG run collection", dag: {}, count: 0 },
  { name: "all malformed runs", dag: { runs: [{}] }, count: 0 },
  { name: "empty truncated run collection", dag: { runs: [], truncated_runs: true }, count: 0 },
  { name: "run-local partial flag", dag: { runs: [{ ...fullRun, partial: true }] }, count: 2 },
  { name: "total mismatch without a partial flag", dag: { runs: [{ ...fullRun, nodes: [nodeA], edges: [] }] }, count: 1 },
  { name: "duplicate node identity", dag: { runs: [{ ...fullRun, nodes: [nodeA, nodeA], edges: [] }] }, count: 1 },
  { name: "duplicate run identity", dag: { runs: [fullRun, fullRun] }, count: 2 },
  { name: "dangling dependency", dag: { runs: [{ ...fullRun, nodes: [nodeA, { ...nodeB, depends_on: ["missing"] }] }] }, count: 2 },
  { name: "malformed edge dropped by parser", dag: { runs: [{ ...fullRun, edges: [{}] }] }, count: 2 },
  { name: "malformed wave dropped by parser", dag: { runs: [{ ...fullRun, waves: [{}] }] }, count: 2 },
  { name: "invalid state cannot prove no running work", dag: { runs: [{ ...fullRun, nodes: [{ ...nodeA, state: "invalid" }], counts: { ...counts, total: 1, running: 0 }, edges: [] }] }, count: 0 },
  { name: "negative counts", dag: { runs: [{ ...fullRun, counts: { ...counts, running: -1 } }] }, count: 2 },
  { name: "empty topology does not count unidentified tasks", dag: { runs: [{ ...fullRun, nodes: [] }] }, count: 0 },
];

describe("DAG summary completeness", () => {
  it.each(incompleteCases)("qualifies $name without inventing missing task counts", ({ dag, count }) => {
    const summary = summarizeLiveSession(info(dag), NOW);
    expect(summary.runningCount).toBe(count);
    expect(summary.truncatedTasks).toBe(true);
    expect(summary.dagSideOversized).toBe(false);
  });

  it("returns exact2 for full authoritative topology", () => {
    expect(summarizeLiveSession(info(full), NOW)).toMatchObject({ runningCount: 2, truncatedTasks: false, dagOversized: false });
  });

  it("keeps a genuinely absent DAG and an authoritative empty run collection idle", () => {
    for (const dag of [null, { runs: [], truncated_runs: false }]) {
      expect(summarizeLiveSession(info(dag), NOW)).toMatchObject({ runningCount: 0, truncatedTasks: false });
    }
  });

  it("lets terminal task authority override a retained running node without counting the missing node", () => {
    const task = { tasks: [{ task_id: "t1", name: "Finished", status: "completed" }] };
    expect(summarizeLiveSession(info(partial, task), NOW)).toMatchObject({ runningCount: 0, dagRunning: 0, truncatedTasks: true });
  });

  it("does not revive terminal runs with retained running nodes", () => {
    const dag = { runs: [{ ...fullRun, status: "completed" }] };
    expect(summarizeLiveSession(info(dag), NOW).runningCount).toBe(0);
  });

  it("deduplicates the same running task across DAG runs", () => {
    const dag = { runs: [fullRun, { ...fullRun, run_id: "r2" }] };
    expect(summarizeLiveSession(info(dag), NOW).runningCount).toBe(2);
  });

  it("a heartbeat refreshes task liveness but never certifies partial topology", () => {
    const task = { tasks: [{ task_id: "t1", name: "Quiet", status: "running", updated_at: "2026-09-08T09:00:00Z" }] };
    const summary = summarizeLiveSession(info(incompleteZero, task), NOW, { heartbeatStamps: new Map([["t1", "2026-09-08T10:00:00Z"]]) });
    expect(summary).toMatchObject({ runningCount: 1, truncatedTasks: true });
  });

  it("uses authoritative compact DAG data instead of stale partial cached topology", () => {
    const summary = summarizeLiveSession({ ...info(partial), dagOversized: true, dagDigest: { runs: [{ runId: "r1", status: "running", runningTaskIds: ["t1", "t2"] }], truncated: false } }, NOW);
    expect(summary).toMatchObject({ runningCount: 2, truncatedTasks: false, dagOversized: false });
  });
});

describe("Sidebar and overview consume real DAG summary qualification", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    __resetLiveBadgeStoreForTests();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    __resetLiveBadgeStoreForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function render(dag: unknown): void {
    vi.mocked(useLiveSessionInfos).mockReturnValue([info(dag)]);
    act(() => root.render(
      <Sidebar collapsed={false} onToggleCollapse={() => undefined} workspaces={[workspace]}
        activeTerminalId={null} placedSessions={new Set()} liveSessions={new Set(["s1"])} expanded={new Set(["ws"])}
        sessionLists={new Map([["ws", [{ id: "s1", name: "Session", source: "stored", recencyMs: 1 }]]])}
        sessionPages={new Map()} onToggleExpanded={() => undefined} onLoadMoreSessions={() => undefined}
        onSelectTerminal={() => undefined} onOpenSession={async () => undefined} onAddWorkspace={() => undefined}
        onAddTerminal={() => undefined} onDeleteWorkspace={() => undefined} onDeleteTerminal={() => undefined}
        onRenameWorkspace={async () => undefined} onRenameTerminal={async () => undefined} onLogout={() => undefined} notify={() => undefined}
      />,
    ));
  }

  it.each([
    { name: "retained1", dag: partial, expected: "1+", key: "Partial" },
    { name: "malformed retained1", dag: malformedNode, expected: "1+", key: "Partial" },
    { name: "incomplete0", dag: incompleteZero, expected: "?", key: "Unknown" },
    { name: "malformed0", dag: { runs: [{}] }, expected: "?", key: "Unknown" },
  ])("shows qualified $name on session, workspace and overview then exact2 after full data", ({ dag, expected, key }) => {
    render(dag);
    act(() => container.querySelector<HTMLButtonElement>('button[title="sidebar.overview"]')?.click());
    const row = () => container.querySelector(".th-tree-children .th-tree-running");
    const aggregate = () => container.querySelector(".th-tree-running--workspace");
    const overview = () => document.body.querySelector(".th-overview-card-running");
    expect.soft(row()?.textContent).toBe(expected);
    expect.soft(aggregate()?.textContent).toBe(expected);
    expect.soft(overview()?.textContent).toBe(expected);
    expect.soft(row()?.getAttribute("aria-label")).toBe(`sidebar.tm.runningAgents${key}`);
    expect.soft(aggregate()?.getAttribute("aria-label")).toBe(`sidebar.ws.runningAgents${key}`);
    expect.soft(overview()?.getAttribute("aria-label")).toBe(`overview.runningAria${key}`);

    render(full);
    expect(row()?.textContent).toBe("2");
    expect(aggregate()?.textContent).toBe("2");
    expect(overview()?.textContent).toBe("2");
    expect(overview()?.getAttribute("aria-label")).toBe("overview.runningAria");
  });
});
