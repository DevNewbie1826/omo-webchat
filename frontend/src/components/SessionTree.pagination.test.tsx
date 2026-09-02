import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionTree } from "./SessionTree";
import { useWorkspaces } from "../features/workspace/useWorkspaces";
import type { UseWorkspacesResult } from "../features/workspace/useWorkspaces";
import { listWorkspaceSessions, listWorkspaces } from "../features/workspace/workspace";
import type { Workspace, WorkspaceSession, WorkspaceSessionPage } from "../features/workspace/workspace";
import type { LayoutApi } from "../features/split/useLayout";

vi.mock("../features/workspace/workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../features/workspace/workspace")>();
  return { ...actual, listWorkspaces: vi.fn(), listWorkspaceSessions: vi.fn() };
});

const layout: LayoutApi = {
  root: { kind: "leaf", id: "pane-1", sessionId: null },
  focusedPaneId: "pane-1",
  placed: new Set(),
  focusPane: vi.fn(),
  hasPane: vi.fn(() => true),
  assignSession: vi.fn(),
  split: vi.fn(),
  closePane: vi.fn(),
  changeRatio: vi.fn(),
  unplaceSession: vi.fn(),
  focusSession: vi.fn(() => false),
};

const EMPTY_SET: ReadonlySet<string> = new Set();

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function session(id: string, name: string, recencyMs: number): WorkspaceSession {
  return { id, name, source: "stored", recencyMs };
}

const workspace: Workspace = {
  id: "ws-1",
  name: "Workspace",
  path: "/work",
  chats: [
    { id: "r1", name: "Recent 1", provider: "omo" },
    { id: "r2", name: "Recent 2", provider: "omo" },
    { id: "r3", name: "Recent 3", provider: "omo" },
    { id: "r4", name: "Recent 4", provider: "omo" },
    { id: "r5", name: "Recent 5", provider: "omo" },
    { id: "o1", name: "Older 1", provider: "omo" },
    { id: "o2", name: "Older 2", provider: "omo" },
  ],
};

interface HarnessProps {
  readonly activeTerminalId?: string | null;
  readonly liveSessions?: ReadonlySet<string>;
}

let hook: UseWorkspacesResult | undefined;

/** Wires useWorkspaces into SessionTree the same way App wires it into Sidebar. */
function Harness({ activeTerminalId = null, liveSessions = EMPTY_SET }: HarnessProps) {
  const state = useWorkspaces({
    notify: () => undefined,
    t: (key) => key,
    layout,
    confirm: async () => true,
  });
  hook = state;
  return (
    <SessionTree
      workspaces={state.workspaces}
      activeTerminalId={activeTerminalId}
      placedSessions={new Set()}
      liveSessions={liveSessions}
      expanded={state.expanded}
      sessionLists={state.sessionLists}
      sessionPages={state.sessionPages}
      onToggle={state.toggleExpanded}
      onLoadMoreSessions={state.loadMoreSessions}
      onSelect={() => undefined}
      onAdopt={async () => undefined}
      onAddTerminal={() => undefined}
      onDeleteWorkspace={() => undefined}
      onDeleteTerminal={() => undefined}
      onRenameWorkspace={async () => undefined}
      onRenameTerminal={async () => undefined}
      notify={() => undefined}
    />
  );
}

describe("SessionTree session pagination", () => {
  let container: HTMLDivElement;
  let root: Root;

  const chatRows = (): HTMLElement[] =>
    Array.from(container.querySelectorAll<HTMLElement>(".th-tree-children > .th-tree-node"));

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    hook = undefined;
    vi.mocked(listWorkspaces).mockResolvedValue([workspace]);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows the five-entry first page, appends the next page on load-more without losing selection, and hides the control when the cursor empties", async () => {
    const page1 = deferred<WorkspaceSessionPage>();
    const page2 = deferred<WorkspaceSessionPage>();
    vi.mocked(listWorkspaceSessions)
      .mockReturnValueOnce(page1.promise)
      .mockReturnValueOnce(page2.promise);

    act(() => {
      root.render(<Harness activeTerminalId="r2" liveSessions={new Set(["r3"])} />);
    });
    await act(async () => {
      await hook?.load();
    });

    // Expanding the workspace fetches the first page.
    act(() => {
      hook?.toggleExpanded("ws-1");
    });
    expect(listWorkspaceSessions).toHaveBeenNthCalledWith(1, "ws-1", "");

    await act(async () => {
      page1.resolve({
        items: [
          session("r1", "Recent 1", 5000),
          session("r2", "Recent 2", 4000),
          session("r3", "Recent 3", 3000),
          session("r4", "Recent 4", 2000),
          session("r5", "Recent 5", 1000),
        ],
        nextCursor: "cursor-2",
      });
      await page1.promise;
    });

    // The sidebar view is capped at five while the canonical chat list stays complete.
    expect(chatRows().map((row) => row.textContent)).toEqual([
      "Recent 1",
      "Recent 2",
      "Recent 3",
      "Recent 4",
      "Recent 5",
    ]);

    const more = container.querySelector<HTMLButtonElement>(".th-tree-more");
    expect(more).not.toBeNull();
    expect(more?.textContent).toBe("sidebar.ws.more");
    expect(more?.disabled).toBe(false);

    // Clicking load-more fetches the continuation and shows a busy state.
    act(() => {
      more?.click();
    });
    expect(listWorkspaceSessions).toHaveBeenNthCalledWith(2, "ws-1", "cursor-2");
    const busy = container.querySelector<HTMLButtonElement>(".th-tree-more");
    expect(busy?.disabled).toBe(true);
    expect(busy?.textContent).toBe("sidebar.ws.moreLoading");
    expect(chatRows()).toHaveLength(5);

    await act(async () => {
      page2.resolve({
        items: [
          session("r5", "Recent 5", 1000), // overlap with page 1 must not duplicate
          session("o1", "Older 1", 900),
          session("o2", "Older 2", 800),
        ],
        nextCursor: "",
      });
      await page2.promise;
    });

    expect(chatRows().map((row) => row.textContent)).toEqual([
      "Recent 1",
      "Recent 2",
      "Recent 3",
      "Recent 4",
      "Recent 5",
      "Older 1",
      "Older 2",
    ]);

    // Empty next cursor: the control disappears for good.
    expect(container.querySelector(".th-tree-more")).toBeNull();

    // The tree stays expanded and the selection survives the append.
    const wsNode = container.querySelector(".th-tree-workspace > .th-tree-node");
    const expand = wsNode?.querySelector(".th-tree-chevron");
    expect(wsNode?.getAttribute("role")).toBeNull();
    expect(wsNode?.getAttribute("aria-expanded")).toBeNull();
    expect(expand?.getAttribute("aria-expanded")).toBe("true");
    const active = chatRows().find((row) => row.textContent === "Recent 2");
    const activeActivation = active?.querySelector(".th-tree-activation");
    expect(active?.getAttribute("role")).toBeNull();
    expect(active?.getAttribute("aria-current")).toBeNull();
    expect(activeActivation?.getAttribute("aria-current")).toBe("true");
    expect(activeActivation?.getAttribute("aria-selected")).toBeNull();
    expect(activeActivation?.getAttribute("aria-expanded")).toBeNull();
    expect(active?.classList.contains("th-tree-node--active")).toBe(true);

    // Live indicator and row affordances keep working on paginated entries.
    const liveRow = chatRows().find((row) => row.textContent === "Recent 3");
    expect(liveRow?.querySelector(".th-tree-live")).not.toBeNull();
    expect(liveRow?.querySelector('button[title="sidebar.tm.rename"]')).not.toBeNull();
    expect(liveRow?.querySelector('button[title="sidebar.tm.delete"]')).not.toBeNull();
  });

  it("never renders the load-more control when the first page is the last", async () => {
    vi.mocked(listWorkspaceSessions).mockResolvedValue({
      items: [session("r1", "Recent 1", 2000), session("r2", "Recent 2", 1000)],
      nextCursor: "",
    });

    act(() => {
      root.render(<Harness />);
    });
    await act(async () => {
      await hook?.load();
    });
    act(() => {
      hook?.toggleExpanded("ws-1");
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(chatRows().map((row) => row.textContent)).toEqual(["Recent 1", "Recent 2"]);
    expect(container.querySelector(".th-tree-more")).toBeNull();

    // Collapsing and re-expanding reuses the loaded page instead of refetching.
    act(() => {
      hook?.toggleExpanded("ws-1");
    });
    act(() => {
      hook?.toggleExpanded("ws-1");
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(listWorkspaceSessions).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".th-tree-more")).toBeNull();
  });
});
