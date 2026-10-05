import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";
import { useMediaQuery } from "../lib/useMediaQuery";
import type { Terminal, Workspace, WorkspaceSession } from "../features/workspace/workspace";

vi.mock("../lib/useMediaQuery", () => ({ useMediaQuery: vi.fn() }));

const workspace: Workspace = {
  id: "ws-1",
  name: "Workspace",
  path: "/work",
  chats: [{ id: "tm-1", name: "Stored session", provider: "omo" }],
};

const LIVE_RESPONSE = {
  sessions: [
    {
      id: "tm-1",
      title: "Refactor auth",
      running: { agents: 1 }, done: 0, last_line: "ls",
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

describe("Sidebar live-feeds tree badges without a pinned sessions region", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
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
  });

  function renderSidebar(
    onSelect: (ws: Workspace, tm: Terminal) => void,
    options: { readonly chats?: readonly Terminal[] } = {},
  ): void {
    const ws: Workspace = { ...workspace, chats: options.chats ?? workspace.chats };
    const sessions: readonly WorkspaceSession[] = [
      { id: "tm-1", name: "Stored session", source: "stored", recencyMs: 1 },
    ];
    act(() => {
      root.render(
        <Sidebar
          collapsed={false}
          onToggleCollapse={() => undefined}
          workspaces={[ws]}
          activeTerminalId={null}
          placedSessions={new Set()}
          liveSessions={new Set(["tm-1"])}
          expanded={new Set(["ws-1"])}
          sessionLists={new Map([["ws-1", sessions]])}
          sessionPages={new Map()}
          onToggleExpanded={() => undefined}
          onLoadMoreSessions={() => undefined}
          onSelectTerminal={onSelect}
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

  it("never renders a pinned sessions region, even while a chat runs agents", async () => {
    const fetchMock = vi.fn(async () => okResponse(LIVE_RESPONSE));
    vi.stubGlobal("fetch", fetchMock);
    const onSelect = vi.fn((_ws: Workspace, _tm: Terminal) => undefined);

    renderSidebar(onSelect);

    // Structural header-action set: exactly the add-workspace and collapse
    // controls, in that order. Any restored overview trigger adds a third
    // action and fails here.
    const headerActions = [...container.querySelectorAll<HTMLButtonElement>(".th-sidebar-nav-actions button")];
    expect(headerActions.map((button) => button.title)).toEqual(["sidebar.addWorkspace", "sidebar.collapse"]);
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    // Data lands on the shared poller: the chat row badge and the workspace
    // chip light up, and no separate "Sessions" section renders anywhere.
    await act(async () => {});
    expect(container.querySelector(".th-sidebar-live")).toBeNull();
    expect(container.querySelector(".th-overview-card")).toBeNull();
    const rowBadge = container.querySelector(".th-tree-children .th-tree-running");
    expect(rowBadge?.textContent).toBe("1");
    expect(rowBadge?.getAttribute("aria-label")).toBe("sidebar.tm.runningAgents");
    expect(container.querySelector(".th-tree-running--workspace")?.textContent).toBe("1");

    // Row activation still routes straight to the chat select flow.
    act(() => {
      container.querySelector<HTMLButtonElement>(".th-tree-children .th-tree-activation")?.click();
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(workspace, workspace.chats[0]);
  });

  it("shows the tree live dot from the shared poller's live-session membership", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse(LIVE_RESPONSE)));
    renderSidebar(() => undefined);

    await act(async () => {});
    const row = Array.from(container.querySelectorAll<HTMLElement>(".th-tree-children > .th-tree-node"))
      .find((node) => node.textContent?.includes("Stored session"));
    expect(row?.querySelector(".th-tree-live")).not.toBeNull();
  });

  it("keeps the tree badge-less when the live poll reports nothing openable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse({
      sessions: [{ id: "durable-uuid-9", title: "Ghost elsewhere", running: { agents: 2 }, done: 0 }],
    })));
    renderSidebar(() => undefined, { chats: [] });

    await act(async () => {});
    expect(container.querySelector(".th-sidebar-live")).toBeNull();
    expect(container.querySelector(".th-tree-children .th-tree-running")).toBeNull();
    expect(container.querySelector(".th-tree-running--workspace")).toBeNull();
  });
});
