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
    vi.mocked(apiJson).mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    __resetLiveBadgeStoreForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function render(dag: unknown): void {
    const info: LiveSessionInfo = { id: "s1", title: "Session", task: null, dag };
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

  async function flush(): Promise<void> {
    await act(async () => {
      for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    });
  }

  const sessionBadge = (): HTMLElement | null => container.querySelector<HTMLElement>(".th-tree-children .th-tree-running");
  const workspaceBadge = (): HTMLElement | null => container.querySelector<HTMLElement>(".th-tree-running--workspace");

  it("C001: shows the exact recovered running count on session and workspace badges", async () => {
    mockCompleteDagRuns();
    render(partial);
    expect(sessionBadge()?.textContent).toBe("1+");
    expect(workspaceBadge()?.textContent).toBe("1+");
    await flush();
    expect(sessionBadge()?.textContent).toBe("2");
    expect(sessionBadge()?.getAttribute("title")).toBe(null);
    expect(sessionBadge()?.getAttribute("aria-label")).toBe("sidebar.tm.runningAgents");
    expect(workspaceBadge()?.textContent).toBe("2");
    expect(workspaceBadge()?.getAttribute("title")).toBe(null);
    expect(workspaceBadge()?.getAttribute("aria-label")).toBe("sidebar.ws.runningAgents");
  });

  it.each([404, 422, 409])("C002: keeps the partial badge plus an explanatory title when dag-runs responds %i", async (status) => {
    mockDagRunsError(status);
    render(partial);
    await flush();
    expect.soft(sessionBadge()?.textContent).toBe("1+");
    expect.soft(sessionBadge()?.getAttribute("title")).toBe("sidebar.tm.runningAgentsPartial");
    expect.soft(workspaceBadge()?.textContent).toBe("1+");
    expect.soft(workspaceBadge()?.getAttribute("title")).toBe("sidebar.ws.runningAgentsPartial");
  });

  it("C003: skips dag-runs entirely for unqualified sessions and bounds fetches per revision", async () => {
    mockCompleteDagRuns();
    render(full);
    await flush();
    for (let poll = 0; poll < 2; poll++) {
      render(full);
      await flush();
    }
    expect(dagRunsCalls()).toEqual([]);

    render(partial);
    await flush();
    const afterFirstCycle = dagRunsCalls().length;
    expect(afterFirstCycle).toBeGreaterThanOrEqual(1);
    for (let poll = 0; poll < 2; poll++) {
      render(partial);
      await flush();
    }
    expect(dagRunsCalls().length).toBe(afterFirstCycle);
  });
});
