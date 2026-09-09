import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiJson } from "../../lib/api";
import { Sidebar } from "../../components/Sidebar";
import { useLiveSessionInfos } from "./useLiveSessions";
import { __resetLiveBadgeStoreForTests } from "./liveBadgeStore";
import type { LiveSessionInfo, Workspace } from "./workspace";

vi.mock("./useLiveSessions", async (importOriginal) => ({
  ...await importOriginal<typeof import("./useLiveSessions")>(),
  useLiveSessionInfos: vi.fn(),
}));
vi.mock("../../lib/useMediaQuery", () => ({ useMediaQuery: () => false }));
vi.mock("../../lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/api")>(),
  apiJson: vi.fn(),
}));

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

const completeDoc = {
  complete: true,
  content_token: "tok-r1",
  run: { ...fullRun, created_at: "2026-09-08T09:58:00Z", updated_at: "2026-09-08T10:00:00Z" },
};
const catalog = {
  runs: [{
    run_id: "r1", run_key: "plan", name: "Plan", status: "running",
    created_at: "2026-09-08T09:58:00Z", updated_at: "2026-09-08T10:00:00Z", total: 2, content_token: "tok-r1",
  }],
  next_cursor: null,
};

const workspace: Workspace = { id: "ws", name: "Workspace", path: "/fixture", chats: [{ id: "s1", name: "Session", provider: "omo" }] };
const DAG_RUNS = "/api/workspaces/ws/chats/s1/dag-runs";

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

async function rejectRequest(path: string, status: number): Promise<void> {
  const request = takeRequest(path);
  await act(async () => {
    request.reject(new ApiError(status, `status ${status}`));
    await request.promise.catch(() => undefined);
  });
}

const dagRunsCalls = (): readonly string[] =>
  vi.mocked(apiJson).mock.calls.map(([path]) => path).filter((path) => path.includes("/dag-runs"));

describe("Sidebar complete-DAG badge recovery", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-09-08T10:00:00Z"));
    __resetLiveBadgeStoreForTests();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    pendingRequests = [];
    vi.mocked(apiJson).mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    __resetLiveBadgeStoreForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function render(dag: unknown, overrides: Partial<LiveSessionInfo> = {}): void {
    const info: LiveSessionInfo = { id: "s1", title: "Session", task: null, dag, ...overrides };
    vi.mocked(useLiveSessionInfos).mockReturnValue([info]);
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

  const sessionBadge = (): HTMLElement | null => container.querySelector<HTMLElement>(".th-tree-children .th-tree-running");
  const workspaceBadge = (): HTMLElement | null => container.querySelector<HTMLElement>(".th-tree-running--workspace");

  function waitForSessionBadge(text: string): Promise<void> {
    if (sessionBadge()?.textContent === text) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const observer = new MutationObserver(() => {
        if (sessionBadge()?.textContent !== text) return;
        observer.disconnect();
        window.clearTimeout(timeout);
        resolve();
      });
      const timeout = window.setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Timed out waiting for session badge ${text}`));
      }, 1_000);
      observer.observe(container, { childList: true, characterData: true, subtree: true });
    });
  }

  async function recoverOne(): Promise<void> {
    await resolveRequest(DAG_RUNS, catalog);
    const badgeChanged = waitForSessionBadge("2");
    await resolveRequest(`${DAG_RUNS}/r1`, completeDoc);
    await badgeChanged;
  }

  it("C001: shows the exact recovered running count on session and workspace badges", async () => {
    controlDagRuns();
    render(partial);
    expect(sessionBadge()?.textContent).toBe("1+");
    expect(workspaceBadge()?.textContent).toBe("1+");
    await recoverOne();
    expect(sessionBadge()?.textContent).toBe("2");
    expect(sessionBadge()?.getAttribute("title")).toBe(null);
    expect(sessionBadge()?.getAttribute("aria-label")).toBe("sidebar.tm.runningAgents");
    expect(workspaceBadge()?.textContent).toBe("2");
    expect(workspaceBadge()?.getAttribute("title")).toBe(null);
    expect(workspaceBadge()?.getAttribute("aria-label")).toBe("sidebar.ws.runningAgents");
  });

  it.each([404, 422, 409])("C002: keeps the partial badge plus an explanatory title when dag-runs responds %i", async (status) => {
    controlDagRuns();
    render(partial);
    await rejectRequest(DAG_RUNS, status);
    expect.soft(sessionBadge()?.textContent).toBe("1+");
    expect.soft(sessionBadge()?.getAttribute("title")).toBe("sidebar.tm.runningAgentsPartial");
    expect.soft(workspaceBadge()?.textContent).toBe("1+");
    expect.soft(workspaceBadge()?.getAttribute("title")).toBe("sidebar.ws.runningAgentsPartial");
  });

  it("C003: skips dag-runs entirely for unqualified sessions and bounds fetches per revision", async () => {
    controlDagRuns();
    render(full);
    for (let poll = 0; poll < 2; poll++) render(full);
    expect(dagRunsCalls()).toEqual([]);

    render(partial);
    await recoverOne();
    const afterFirstCycle = dagRunsCalls().length;
    expect(afterFirstCycle).toBeGreaterThanOrEqual(1);
    for (let poll = 0; poll < 2; poll++) render(partial);
    expect(dagRunsCalls().length).toBe(afterFirstCycle);
  });

  it("keeps task-oversized badges unknown after successful DAG recovery", async () => {
    controlDagRuns();
    render(partial, { taskOversized: true });
    expect(sessionBadge()?.textContent).toBe("?");
    expect(workspaceBadge()?.textContent).toBe("?");
    await resolveRequest(DAG_RUNS, catalog);
    await resolveRequest(`${DAG_RUNS}/r1`, completeDoc);
    expect(sessionBadge()?.textContent).toBe("?");
    expect(sessionBadge()?.getAttribute("title")).toBe("sidebar.tm.runningAgentsUnknown");
    expect(workspaceBadge()?.textContent).toBe("?");
    expect(workspaceBadge()?.getAttribute("title")).toBe("sidebar.ws.runningAgentsUnknown");
  });

  it("keeps an unknown question-mark badge after DAG retrieval fails", async () => {
    controlDagRuns();
    render(null, { dagOversized: true });
    expect(sessionBadge()?.textContent).toBe("?");
    expect(workspaceBadge()?.textContent).toBe("?");
    await rejectRequest(DAG_RUNS, 404);
    expect(sessionBadge()?.textContent).toBe("?");
    expect(workspaceBadge()?.textContent).toBe("?");
  });
});
