import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "../../components/Sidebar";
import { useLiveSessionInfos } from "./useLiveSessions";
import { __resetLiveBadgeStoreForTests } from "./liveBadgeStore";
import { summarizeLiveSession } from "./useLiveSessionSummaries";
import { parseDagDigest, parseTaskDigest } from "./activityDigest";
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
const emptyTaskIdRun = { ...fullRun, nodes: [nodeA, nodeB].map((node) => ({ ...node, task_id: "" })) };
const emptyTaskIds = { runs: [emptyTaskIdRun], truncated_runs: false };
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
  // Quarantined duplicate raw identities contribute no confirmed running node; truncation keeps the count qualified.
  { name: "duplicate node identity", dag: { runs: [{ ...fullRun, nodes: [nodeA, nodeA], edges: [] }] }, count: 0 },
  { name: "duplicate run identity", dag: { runs: [fullRun, fullRun] }, count: 0 },
  { name: "dangling dependency", dag: { runs: [{ ...fullRun, nodes: [nodeA, { ...nodeB, depends_on: ["missing"] }] }] }, count: 2 },
  { name: "malformed edge dropped by parser", dag: { runs: [{ ...fullRun, edges: [{}] }] }, count: 2 },
  { name: "malformed wave dropped by parser", dag: { runs: [{ ...fullRun, waves: [{}] }] }, count: 2 },
  { name: "invalid state cannot prove no running work", dag: { runs: [{ ...fullRun, nodes: [{ ...nodeA, state: "invalid" }], counts: { ...counts, total: 1, running: 0 }, edges: [] }] }, count: 0 },
  { name: "negative counts", dag: { runs: [{ ...fullRun, counts: { ...counts, running: -1 } }] }, count: 2 },
  { name: "empty topology does not count unidentified tasks", dag: { runs: [{ ...fullRun, nodes: [] }] }, count: 0 },
];

describe("DAG summary completeness", () => {
  it.each(incompleteCases)("counts $name without inventing missing task counts", ({ dag, count }) => {
    const summary = summarizeLiveSession(info(dag), NOW);
    expect(summary.runningCount).toBe(count);
    expect(summary.dagSideOversized).toBe(false);
  });

  it("returns exact2 for full authoritative topology", () => {
    expect(summarizeLiveSession(info(full), NOW)).toMatchObject({ runningCount: 2 });
  });

  it.each([
    { name: "within one run", dag: emptyTaskIds },
    { name: "across runs with the same node ID", dag: { runs: ["r1", "r2"].map((runId) => ({
      ...emptyTaskIdRun, run_id: runId, nodes: [emptyTaskIdRun.nodes[0]],
      counts: { ...counts, total: 1, running: 1 }, edges: [],
    })) } },
  ])("counts distinct valid nodes with empty optional task IDs $name", ({ dag }) => {
    expect(summarizeLiveSession(info(dag), NOW)).toMatchObject({
      runningCount: 2, dagRunning: 2,
    });
  });

  it.each([
    { name: "run", run: { ...fullRun, run_id: "" }, count: 0 },
    { name: "node", run: { ...fullRun,
      nodes: [{ ...nodeA, id: "" }, { ...nodeB, depends_on: [""] }],
      edges: [{ from: "", to: "b" }],
    }, count: 1 },
  ])("excludes unidentified work for an empty required $name ID", ({ run, count }) => {
    const summary = summarizeLiveSession(info({ runs: [run] }), NOW);
    expect.soft(summary.runningCount).toBe(count);
    const withValidRun = summarizeLiveSession(info({ runs: [run, {
      ...fullRun, run_id: "valid", nodes: [{ ...nodeA, task_id: "valid-task" }],
      counts: { ...counts, total: 1, running: 1 }, edges: [],
    }] }), NOW);
    expect(withValidRun).toMatchObject({ runningCount: count + 1 });
  });

  it("preserves nonempty opaque run, node and task IDs without trimming", () => {
    const nodes = [" ", "  "].map((id) => ({ ...nodeA, id, task_id: "" }));
    const runs = [" ", "  "].map((run_id) => ({ ...fullRun, run_id, nodes, edges: [] }));
    expect(summarizeLiveSession(info({ runs }), NOW)).toMatchObject({ runningCount: 4 });
    const dag = { runs: [{ ...fullRun, nodes: nodes.map((node) => ({ ...node, task_id: node.id })), edges: [] }] };
    expect(summarizeLiveSession(info(dag), NOW)).toMatchObject({ runningCount: 2 });
  });

  it.each(["completed", "failed", "cancelled", "canceled"])("excludes %s runs with empty optional task IDs", (status) => {
    expect(summarizeLiveSession(info({ runs: [{ ...emptyTaskIdRun, status }] }), NOW)).toMatchObject({
      runningCount: 0, dagRunning: 0,
    });
  });

  it("keeps a genuinely absent DAG and an authoritative empty run collection idle", () => {
    for (const dag of [null, { runs: [], truncated_runs: false }]) {
      expect(summarizeLiveSession(info(dag), NOW)).toMatchObject({ runningCount: 0 });
    }
  });

  it("lets terminal task authority override a retained running node without counting the missing node", () => {
    const task = { tasks: [{ task_id: "t1", name: "Finished", status: "completed" }] };
    expect(summarizeLiveSession(info(partial, task), NOW)).toMatchObject({ runningCount: 0, dagRunning: 0 });
  });

  it("does not revive terminal runs with retained running nodes", () => {
    const dag = { runs: [{ ...fullRun, status: "completed" }] };
    expect(summarizeLiveSession(info(dag), NOW).runningCount).toBe(0);
  });

  it("deduplicates the same running task across DAG runs", () => {
    const dag = { runs: [fullRun, { ...fullRun, run_id: "r2" }] };
    expect(summarizeLiveSession(info(dag), NOW).runningCount).toBe(2);
  });

  it("a heartbeat refreshes task liveness but never invents partial-topology work", () => {
    const task = { tasks: [{ task_id: "t1", name: "Quiet", status: "running", updated_at: "2026-09-08T09:00:00Z" }] };
    const summary = summarizeLiveSession(info(incompleteZero, task), NOW, { heartbeatStamps: new Map([["t1", "2026-09-08T10:00:00Z"]]) });
    expect(summary).toMatchObject({ runningCount: 1 });
  });

  it("uses authoritative compact DAG data instead of stale partial cached topology", () => {
    const summary = summarizeLiveSession({ ...info(partial), dagOversized: true, dagDigest: { runs: [{ runId: "r1", status: "running", runningTaskIds: ["t1", "t2"] }], truncated: false } }, NOW);
    expect(summary).toMatchObject({ runningCount: 2 });
  });
});

describe.each(["rich", "compact"] as const)("%s DAG running task identity", (representation) => {
  function session(taskIdsByRun: readonly (readonly string[])[], status = "running"): LiveSessionInfo {
    const runs = taskIdsByRun.map((taskIds, index) => ({
      ...fullRun,
      run_id: `run-${index}`,
      status,
      counts: { ...counts, total: taskIds.length, running: taskIds.length },
      nodes: taskIds.map((taskId, nodeIndex) => ({ ...nodeA, id: `node-${nodeIndex}`, task_id: taskId })),
      edges: [],
    }));
    if (representation === "rich") return info({ runs, truncated_runs: false });
    const dagDigest = parseDagDigest({
      runs: runs.map((run) => ({
        run_id: run.run_id, status: run.status, running_task_ids: run.nodes.map((node) => node.task_id),
      })),
      truncated: false,
    });
    if (dagDigest === null) throw new Error("Invalid compact DAG fixture");
    return { ...info(partial), dagOversized: true, dagDigest };
  }

  it.each([
    { name: "full2 positive control", runs: [["task-a", "task-b"]] },
    { name: "duplicate IDs within a run", runs: [["task-a", "task-b", "task-a", "task-b"]] },
    { name: "duplicate IDs across two active runs (exact4 regression)", runs: [["task-a", "task-b"], ["task-a", "task-b"]] },
  ])("returns exact2 for $name", ({ runs }) => {
    expect(summarizeLiveSession(session(runs), NOW)).toMatchObject({
      runningCount: 2, dagRunning: 2,
    });
  });

  describe.each(["rich", "compact"] as const)("%s task authority", (taskRepresentation) => {
    it.each(["running", "pending", "completed", "failed", "cancelled", "lost", "interrupted", "error", "skipped"])(
      "excludes repeated DAG IDs for authoritative %s task rows",
      (status) => {
        const source = session([["task-a", "task-b", "task-a"], ["task-a", "task-b"]]);
        const tasks = [
          { task_id: "task-a", name: "Authoritative", status, updated_at: "2026-09-08T10:00:00Z" },
          { task_id: "task-b", name: "Running", status: "running", updated_at: "2026-09-08T10:00:00Z" },
        ];
        const taskDigest = parseTaskDigest({ tasks, truncated: false });
        if (taskDigest === null) throw new Error("Invalid compact task fixture");
        const input = taskRepresentation === "rich"
          ? { ...source, task: { tasks } }
          : { ...source, taskOversized: true, taskDigest };
        expect(summarizeLiveSession(input, NOW)).toMatchObject({
          runningCount: status === "running" ? 2 : 1, dagRunning: 0,
        });
      },
    );
  });

  it.each(["completed", "failed", "cancelled", "canceled"])("excludes %s DAG runs with retained running IDs", (status) => {
    expect(summarizeLiveSession(session([["task-a", "task-b"], ["task-a", "task-b"]], status), NOW)).toMatchObject({
      runningCount: 0, dagRunning: 0,
    });
  });

  it.each(["cancelled", "canceled"])("does not use %s nodes as task liveness authority or override live task rows", (status) => {
    const source = {
      ...session([["task-a", "task-b"]], status),
      task: { tasks: [{ task_id: "task-a", name: "Quiet", status: "running", updated_at: "2026-09-08T09:00:00Z" }] },
    };
    expect(summarizeLiveSession(source, NOW)).toMatchObject({
      runningCount: 0, dagRunning: 0,
    });
    expect(summarizeLiveSession(source, NOW, { sessionLive: true })).toMatchObject({
      runningCount: 1, dagRunning: 0,
    });
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

  function render(dag: unknown, overrides: Partial<LiveSessionInfo> = {}): void {
    vi.mocked(useLiveSessionInfos).mockReturnValue([{ ...info(dag), ...overrides }]);
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

  it.each(["cancelled", "canceled"])("clears %s retained-running badges and recovers a newer active snapshot", (status) => {
    render({ runs: [{ ...fullRun, status, updated_at: "2026-09-08T09:59:00Z" }], truncated_runs: false });
    act(() => container.querySelector<HTMLButtonElement>('button[title="sidebar.overview"]')?.click());
    const badges = () => [
      container.querySelector(".th-tree-children .th-tree-running"),
      container.querySelector(".th-tree-running--workspace"),
      document.body.querySelector(".th-overview-card-running"),
    ];
    expect(badges()).toEqual([null, null, null]);

    render({ runs: [{ ...fullRun, updated_at: "2026-09-08T10:00:00Z" }], truncated_runs: false });
    expect(badges().map((badge) => badge?.textContent)).toEqual(["2", "2", "2"]);
    expect(badges().map((badge) => badge?.getAttribute("aria-label"))).toEqual([
      "sidebar.tm.runningAgents", "sidebar.ws.runningAgents", "overview.runningAria",
    ]);
  });

  it("recovers compact zero to rich full empty-ID exact2 on session, workspace and overview", () => {
    const dagDigest = parseDagDigest({ runs: [{ run_id: "r1", status: "running", running_task_ids: [] }], truncated: true });
    if (dagDigest === null) throw new Error("Invalid compact DAG fixture");
    render(emptyTaskIds, { dagOversized: true, dagDigest });
    act(() => container.querySelector<HTMLButtonElement>('button[title="sidebar.overview"]')?.click());
    const badges = () => [
      container.querySelector(".th-tree-children .th-tree-running"),
      container.querySelector(".th-tree-running--workspace"),
      document.body.querySelector(".th-overview-card-running"),
    ];
    expect(badges()).toEqual([null, null, null]);
    render(emptyTaskIds, { dagOversized: false, dagDigest });
    expect(badges().map((badge) => badge?.textContent)).toEqual(["2", "2", "2"]);
    expect(badges().map((badge) => badge?.getAttribute("aria-label"))).toEqual([
      "sidebar.tm.runningAgents", "sidebar.ws.runningAgents", "overview.runningAria",
    ]);
  });

  it("shows no badge when a truncated digest carries server running_count zero", () => {
    const digest = parseTaskDigest({
      tasks: [{ task_id: "t9", status: "completed", updated_at: "2026-09-08T09:00:00Z" }],
      truncated: true,
      running_count: 0,
    });
    if (digest === null) throw new Error("Invalid compact task fixture");
    render(null, { taskOversized: true, taskDigest: digest });
    act(() => container.querySelector<HTMLButtonElement>('button[title="sidebar.overview"]')?.click());
    const badges = () => [
      container.querySelector(".th-tree-children .th-tree-running"),
      container.querySelector(".th-tree-running--workspace"),
      document.body.querySelector(".th-overview-card-running"),
    ];
    expect(badges()).toEqual([null, null, null]);
  });

  it("renders server running_count 50 exactly, without a plus suffix", () => {
    const digest = parseTaskDigest({
      tasks: [{ task_id: "t9", status: "running", updated_at: "2026-09-08T10:00:00Z" }],
      truncated: true,
      running_count: 50,
    });
    if (digest === null) throw new Error("Invalid compact task fixture");
    render(null, { taskOversized: true, taskDigest: digest });
    act(() => container.querySelector<HTMLButtonElement>('button[title="sidebar.overview"]')?.click());
    const badges = () => [
      container.querySelector(".th-tree-children .th-tree-running"),
      container.querySelector(".th-tree-running--workspace"),
      document.body.querySelector(".th-overview-card-running"),
    ];
    expect(badges().map((badge) => badge?.textContent)).toEqual(["50", "50", "50"]);
    expect(badges().map((badge) => badge?.getAttribute("aria-label"))).toEqual([
      "sidebar.tm.runningAgents", "sidebar.ws.runningAgents", "overview.runningAria",
    ]);
  });

  it.each([
    { name: "retained1", dag: partial, expected: "1" },
    { name: "malformed retained1", dag: malformedNode, expected: "1" },
    { name: "incomplete0", dag: incompleteZero, expected: null },
    { name: "malformed0", dag: { runs: [{}] }, expected: null },
  ])("shows exact retained $name on session, workspace and overview then exact2 after full data", ({ dag, expected }) => {
    render(dag);
    act(() => container.querySelector<HTMLButtonElement>('button[title="sidebar.overview"]')?.click());
    const row = () => container.querySelector(".th-tree-children .th-tree-running");
    const aggregate = () => container.querySelector(".th-tree-running--workspace");
    const overview = () => document.body.querySelector(".th-overview-card-running");
    expect.soft(row()?.textContent ?? null).toBe(expected);
    expect.soft(aggregate()?.textContent ?? null).toBe(expected);
    expect.soft(overview()?.textContent ?? null).toBe(expected);
    expect.soft(row()?.getAttribute("aria-label") ?? null).toBe(expected === null ? null : "sidebar.tm.runningAgents");

    render(full);
    expect(row()?.textContent).toBe("2");
    expect(aggregate()?.textContent).toBe("2");
    expect(overview()?.textContent).toBe("2");
    expect(overview()?.getAttribute("aria-label")).toBe("overview.runningAria");
  });
});
