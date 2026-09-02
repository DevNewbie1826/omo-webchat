import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveSessionSummary } from "../features/workspace/useLiveSessionSummaries";
import { useLiveSessionSummaries } from "../features/workspace/useLiveSessionSummaries";
import type { Terminal, Workspace, WorkspaceSession } from "../features/workspace/workspace";
import { useMediaQuery } from "../lib/useMediaQuery";
import { MEMBERSHIP_RETRY_DELAY_MS, Sidebar } from "./Sidebar";

vi.mock("../lib/useMediaQuery", () => ({ useMediaQuery: vi.fn() }));
vi.mock("../features/workspace/useLiveSessionSummaries", () => ({ useLiveSessionSummaries: vi.fn() }));
vi.mock("../features/workspace/liveBadgeStore", () => ({
  useMergedLiveSummaries: (summaries: readonly LiveSessionSummary[]) => summaries,
}));

function summary(id: string, runningCount: number): LiveSessionSummary {
  return {
    id, title: id, task: null, dag: null,
    taskSideOversized: false, dagSideOversized: false,
    runningCount, doneCount: 0, dagDone: 0, dagTotal: 0,
    lastLine: null, dagRunning: 0, truncatedTasks: false,
    taskOversized: false, dagOversized: false,
  };
}

function page(items: readonly WorkspaceSession[]): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ items, nextCursor: "" }),
  } as Response;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

const workspace: Workspace = { id: "ws-1", name: "Workspace One", path: "/one", chats: [] };

describe("Sidebar running membership crawl", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.mocked(useMediaQuery).mockReturnValue(false);
    vi.mocked(useLiveSessionSummaries).mockReturnValue([]);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function renderSidebar(options: {
    workspaces?: readonly Workspace[];
    lists?: ReadonlyMap<string, readonly WorkspaceSession[]>;
    onDelete?: (ws: Workspace, tm: Terminal) => void;
  } = {}): void {
    const workspaces = options.workspaces ?? [workspace];
    root.render(
      <Sidebar
        collapsed={false}
        onToggleCollapse={() => undefined}
        workspaces={workspaces}
        activeTerminalId={null}
        placedSessions={new Set()}
        liveSessions={new Set()}
        expanded={new Set(workspaces.map((item) => item.id))}
        sessionLists={options.lists ?? new Map([["ws-1", []]])}
        sessionPages={new Map()}
        onToggleExpanded={() => undefined}
        onLoadMoreSessions={() => undefined}
        onSelectTerminal={() => undefined}
        onAdoptSession={async () => undefined}
        onAddWorkspace={() => undefined}
        onAddTerminal={() => undefined}
        onDeleteWorkspace={() => undefined}
        onDeleteTerminal={options.onDelete ?? (() => undefined)}
        onRenameWorkspace={async () => undefined}
        onRenameTerminal={async () => undefined}
        onLogout={() => undefined}
        notify={() => undefined}
      />,
    );
  }

  it("does not restart an in-flight union fetch for a count-only rerender", async () => {
    const pending = deferred<Response>();
    const fetchMock = vi.fn(() => pending.promise);
    vi.stubGlobal("fetch", fetchMock);
    const lists = new Map<string, readonly WorkspaceSession[]>([["ws-1", []]]);
    vi.mocked(useLiveSessionSummaries).mockReturnValue([summary("cursor-only", 1)]);

    act(() => renderSidebar({ lists }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.mocked(useLiveSessionSummaries).mockReturnValue([summary("cursor-only", 2)]);
    act(() => renderSidebar({ lists }));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(page([]));
      await pending.promise;
    });
  });

  it("invalidates cursor-only membership after its session list deletion", async () => {
    const cursorChat: WorkspaceSession = {
      id: "cursor-only", name: "Cursor only", source: "stored", recencyMs: 1,
    };
    let lists: ReadonlyMap<string, readonly WorkspaceSession[]> = new Map([["ws-1", []]]);
    let deleted = false;
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (deleted) throw new Error("post-delete lookup failed");
      return page([cursorChat]);
    }));
    vi.mocked(useLiveSessionSummaries).mockReturnValue([summary("cursor-only", 2)]);
    const onDelete = (): void => {
      deleted = true;
      lists = new Map([["ws-1", []]]);
      renderSidebar({ lists, onDelete });
    };

    await act(async () => renderSidebar({ lists, onDelete }));
    expect(container.querySelector(".th-tree-running--workspace")?.textContent).toContain("2");

    lists = new Map([["ws-1", [cursorChat]]]);
    await act(async () => renderSidebar({ lists, onDelete }));
    const deleteButton = container.querySelector<HTMLButtonElement>('button[title="sidebar.tm.delete"]');
    expect(deleteButton).not.toBeNull();
    await act(async () => deleteButton?.click());

    expect(container.querySelector(".th-tree-running--workspace")).toBeNull();
    expect(container.querySelector(".th-tree-count")?.textContent).toBe("0");
  });

  it("renders partial membership successes and retries failed workspaces", async () => {
    const workspaces: readonly Workspace[] = [
      workspace,
      { id: "ws-2", name: "Workspace Two", path: "/two", chats: [] },
    ];
    const calls = new Map<string, number>();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const wsId = String(input).includes("ws-1") ? "ws-1" : "ws-2";
      calls.set(wsId, (calls.get(wsId) ?? 0) + 1);
      if (wsId === "ws-2") throw new Error("workspace two unavailable");
      return page([{ id: "session-a", name: "Session A", source: "stored", recencyMs: 1 }]);
    }));
    vi.mocked(useLiveSessionSummaries).mockReturnValue([
      summary("session-a", 3),
      summary("session-b", 1),
    ]);

    await act(async () => renderSidebar({
      workspaces,
      lists: new Map([["ws-1", []], ["ws-2", []]]),
    }));

    const nodes = container.querySelectorAll(".th-tree-workspace");
    expect(nodes[0]?.querySelector(".th-tree-running--workspace")?.textContent).toContain("3");
    expect(nodes[1]?.querySelector(".th-tree-running--workspace")).toBeNull();
    expect(calls.get("ws-2")).toBe(2);
  });

  it("retries a failed workspace after a delay even when the fingerprint is unchanged", async () => {
    const workspaces: readonly Workspace[] = [
      workspace,
      { id: "ws-2", name: "Workspace Two", path: "/two", chats: [] },
    ];
    let ws2Failing = true;
    const calls = new Map<string, number>();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const wsId = String(input).includes("ws-1") ? "ws-1" : "ws-2";
      calls.set(wsId, (calls.get(wsId) ?? 0) + 1);
      if (wsId === "ws-2" && ws2Failing) throw new Error("workspace two unavailable");
      return page(wsId === "ws-1"
        ? [{ id: "session-a", name: "Session A", source: "stored", recencyMs: 1 }]
        : [{ id: "session-b", name: "Session B", source: "stored", recencyMs: 1 }]);
    }));
    vi.mocked(useLiveSessionSummaries).mockReturnValue([
      summary("session-a", 3),
      summary("session-b", 1),
    ]);
    vi.useFakeTimers();
    try {
      await act(async () => renderSidebar({
        workspaces,
        lists: new Map([["ws-1", []], ["ws-2", []]]),
      }));
      // ws-2 failed; nothing retried yet.
      const before = calls.get("ws-2") ?? 0;
      expect(before).toBeGreaterThan(0);
      const nodes = container.querySelectorAll(".th-tree-workspace");
      expect(nodes[1]?.querySelector(".th-tree-running--workspace")).toBeNull();

      ws2Failing = false;
      await act(async () => { await vi.advanceTimersByTimeAsync(2100); });

      const after = calls.get("ws-2") ?? 0;
      expect(after).toBeGreaterThan(before);
      expect(container.querySelectorAll(".th-tree-workspace")[1]?.querySelector(".th-tree-running--workspace")?.textContent).toContain("1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds membership retries for a persistently failing workspace", async () => {
    const workspaces: readonly Workspace[] = [
      { id: "ws-2", name: "Workspace Two", path: "/two", chats: [] },
    ];
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      throw new Error("persistently unavailable");
    }));
    vi.mocked(useLiveSessionSummaries).mockReturnValue([
      summary("session-b", 1),
    ]);
    vi.useFakeTimers();
    try {
      await act(async () => renderSidebar({
        workspaces,
        lists: new Map([["ws-2", []]]),
      }));
      // Initial crawl + one retry per tick, stepping so each retry settles
      // before the next is scheduled.
      for (let i = 0; i < 12; i += 1) {
        await act(async () => { await vi.advanceTimersByTimeAsync(MEMBERSHIP_RETRY_DELAY_MS + 100); });
      }
      // 1 initial crawl + at most MEMBERSHIP_MAX_RETRIES retries.
      expect(calls).toBe(1 + 5);
      expect(vi.getTimerCount()).toBe(0);
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(calls).toBe(1 + 5);
    } finally {
      vi.useRealTimers();
    }
  });
});
