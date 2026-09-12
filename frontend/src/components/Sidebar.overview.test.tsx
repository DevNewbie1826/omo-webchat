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
      task: {
        parent_session_id: "tm-1",
        tasks: [
          {
            task_id: "t1",
            name: "Greeter",
            status: "running",
            updated_at: new Date(Date.now() - 1000).toISOString(),
            live_progress: { activity: "thinking", last_assistant_line: "ls" },
          },
        ],
      },
      dag: null,
    },
  ],
};

/** A live (process-attached) session whose only task is done: zero running agents. */
const IDLE_LIVE_RESPONSE = {
  sessions: [
    {
      id: "disk-1",
      title: "Idle attached session",
      task: {
        parent_session_id: "disk-1",
        tasks: [
          {
            task_id: "t1",
            name: "Finished",
            status: "completed",
            updated_at: new Date(Date.now() - 1000).toISOString(),
          },
        ],
      },
      dag: null,
    },
  ],
};

const discoveredRow: WorkspaceSession = {
  id: "disk-1",
  name: "Disk session",
  source: "discovered",
  recencyMs: 1,
  resumeIdentity: "/s/disk-1.jsonl",
};

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("Sidebar pinned running sessions", () => {
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

  interface RenderOptions {
    readonly chats?: readonly Terminal[];
    readonly sessions?: readonly WorkspaceSession[];
    readonly onOpenSession?: (ws: Workspace, session: WorkspaceSession, force?: boolean) => Promise<"opened" | "session-active" | void>;
  }

  function renderSidebar(
    onSelect: (ws: Workspace, tm: Terminal) => void,
    options: RenderOptions = {},
  ): void {
    const ws: Workspace = { ...workspace, chats: options.chats ?? workspace.chats };
    const sessions: readonly WorkspaceSession[] = options.sessions ?? [
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
          onOpenSession={options.onOpenSession ?? (async () => undefined)}
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

  it("pins the running session without a click, has no modal trigger, and routes card clicks to the chat", async () => {
    const fetchMock = vi.fn(async () => okResponse(LIVE_RESPONSE));
    vi.stubGlobal("fetch", fetchMock);
    const onSelect = vi.fn();

    renderSidebar(onSelect);

    // The modal trigger is gone: the pinned section is the only overview surface.
    expect(container.querySelector('button[title="sidebar.overview"]')).toBeNull();
    // Poll result has not landed yet; nothing is pinned while nothing runs.
    expect(container.querySelector(".th-sidebar-live")).toBeNull();

    // Data lands on the shared poller; the pinned section shows the live row
    // with no click at all.
    await act(async () => {});
    const pinned = container.querySelector(".th-sidebar-live");
    expect(pinned).not.toBeNull();
    expect(pinned?.querySelector(".th-sidebar-live-label")?.textContent).toContain("sidebar.overview");
    expect(pinned?.querySelector(".th-sidebar-live-count")?.textContent).toBe("1");
    const cards = pinned?.querySelectorAll<HTMLElement>(".th-overview-card");
    expect(cards).toHaveLength(1);
    expect(cards?.[0]?.textContent).toContain("Refactor auth");

    act(() => {
      cards?.[0]?.querySelector<HTMLButtonElement>(".th-overview-card-open")?.click();
    });

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(workspace, workspace.chats[0]);
    // Pinned, not modal: activation does not dismiss the section.
    expect(container.querySelector(".th-sidebar-live")).not.toBeNull();
  });

  it("pins a highlighted live session with zero running agents once the tree names it", async () => {
    const fetchMock = vi.fn(async () => okResponse(IDLE_LIVE_RESPONSE));
    vi.stubGlobal("fetch", fetchMock);

    renderSidebar(() => undefined, {
      chats: [],
      sessions: [discoveredRow],
      onOpenSession: async () => "session-active",
    });

    // Poll lands: the attached session is live but runs no agents, so nothing is pinned.
    await act(async () => {});
    expect(container.querySelector(".th-sidebar-live")).toBeNull();

    // The open attempt reports the session as active elsewhere: the tree offers View live.
    act(() => {
      container.querySelector<HTMLButtonElement>(".th-tree-children .th-tree-activation")?.click();
    });
    await act(async () => {});
    const viewLive = container.querySelector<HTMLButtonElement>(".th-tree-view-live");
    expect(viewLive).not.toBeNull();

    act(() => viewLive?.click());

    // The named session joins the pinned list despite zero running agents:
    // focused first, and no running badge on its card.
    const pinned = container.querySelector(".th-sidebar-live");
    expect(pinned).not.toBeNull();
    const cards = pinned?.querySelectorAll<HTMLElement>(".th-overview-card");
    expect(cards).toHaveLength(1);
    expect(cards?.[0]?.textContent).toContain("Idle attached session");
    expect(cards?.[0]?.className).toContain("th-overview-card--focused");
    expect(cards?.[0]?.querySelector(".th-overview-card-running")).toBeNull();
  });
});
