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
      active: false,
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

const secondDiscoveredRow: WorkspaceSession = {
  id: "disk-2",
  name: "Second disk session",
  source: "discovered",
  recencyMs: 2,
  resumeIdentity: "/s/disk-2.jsonl",
};

const thirdDiscoveredRow: WorkspaceSession = {
  id: "disk-3",
  name: "Third disk session",
  source: "discovered",
  recencyMs: 3,
  resumeIdentity: "/s/disk-3.jsonl",
};

/** One working session plus two idle live sessions in the same poll. The
 * idle rows mirror the harness fixture: attached (active: false) with no
 * task and no DAG at all. */
const MIXED_LIVE_RESPONSE = {
  sessions: [
    liveEntry("disk-1", "Working session", "running"),
    liveEntry("disk-2", "Idle older", null, 1000, false),
    liveEntry("disk-3", "Idle recent", null, 1000, false),
  ],
};

function liveEntry(id: string, title: string, status: "running" | "completed" | null, updatedAgoMs = 1000, active?: boolean): unknown {
  return {
    id,
    title,
    // The server flags attached sessions with an explicit active boolean;
    // rows without it are finished history, not live sessions.
    ...(active === undefined ? {} : { active }),
    task: status === null ? null : {
      parent_session_id: id,
      tasks: [
        {
          task_id: "t1",
          name: "Worker",
          status,
          updated_at: new Date(Date.now() - updatedAgoMs).toISOString(),
        },
      ],
    },
    dag: null,
  };
}

/** Both discovered sessions attached, each with one running agent. */
const BUSY_LIVE_RESPONSE = {
  sessions: [
    liveEntry("disk-1", "First busy", "running"),
    liveEntry("disk-2", "Second busy", "running"),
  ],
};

/** Same attachments on the next poll, but disk-2's agent has finished. The
 * completed row carries a newer updated_at: a same-revision replay cannot
 * change a task's status. */
const SECOND_IDLE_LIVE_RESPONSE = {
  sessions: [
    liveEntry("disk-1", "First busy", "running"),
    liveEntry("disk-2", "Second busy", "completed", 0, false),
  ],
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

    // The modal trigger is gone: the pinned section is the only overview
    // surface, and no dialog exists anywhere in the tree.
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    // Structural header-action set: exactly the add-workspace and collapse
    // controls, in that order. Without an I18n provider the titles are the
    // keys themselves, so this pins no translated prose - but any restored
    // overview trigger adds a third action and fails here.
    const headerActions = [...container.querySelectorAll<HTMLButtonElement>(".th-sidebar-nav-actions button")];
    expect(headerActions.map((button) => button.title)).toEqual(["sidebar.addWorkspace", "sidebar.collapse"]);
    // Poll result has not landed yet; nothing is pinned while nothing runs.
    expect(container.querySelector(".th-sidebar-live")).toBeNull();

    // Data lands on the shared poller; the pinned section shows the live row
    // with no click at all.
    await act(async () => {});
    const pinned = container.querySelector(".th-sidebar-live");
    expect(pinned).not.toBeNull();
    expect(pinned?.querySelector(".th-sidebar-live-label")?.textContent).toContain("sidebar.sessions");
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

  it("lists every live session - working first, then most recent - including idle rows", async () => {
    const fetchMock = vi.fn(async () => okResponse(MIXED_LIVE_RESPONSE));
    vi.stubGlobal("fetch", fetchMock);

    renderSidebar(() => undefined, {
      chats: [],
      sessions: [
        { ...discoveredRow, recencyMs: 1 },
        { ...secondDiscoveredRow, recencyMs: 2 },
        { ...thirdDiscoveredRow, recencyMs: 3 },
      ],
    });

    await act(async () => {});
    const pinned = container.querySelector(".th-sidebar-live");
    expect(pinned).not.toBeNull();
    const cards = Array.from(pinned?.querySelectorAll<HTMLElement>(".th-overview-card") ?? []);
    expect(cards.map((card) => card.querySelector(".th-overview-card-name")?.textContent))
      .toEqual(["Working session", "Idle recent", "Idle older"]);
    // The count still means "how many are working": one running agent, and
    // its accessible name says so.
    const count = pinned?.querySelector(".th-sidebar-live-count");
    expect(count?.textContent).toBe("1");
    expect(count?.getAttribute("aria-label")).toBe("overview.runningAria");
    // Idle rows carry no running badge.
    expect(cards[1]?.querySelector(".th-overview-card-running")).toBeNull();
    expect(cards[2]?.querySelector(".th-overview-card-running")).toBeNull();
    expect(cards[0]?.querySelector(".th-overview-card-running")).not.toBeNull();
    // The working row keeps its meta line; idle rows with no task and no DAG
    // render no meta line at all (no meaningless "Done 0").
    expect(cards[0]?.querySelector(".th-overview-card-meta")?.textContent).toContain("overview.done");
    expect(cards[1]?.querySelector(".th-overview-card-meta")).toBeNull();
    expect(cards[2]?.querySelector(".th-overview-card-meta")).toBeNull();
    expect(cards[1]?.textContent).not.toContain("overview.done");
    expect(cards[2]?.textContent).not.toContain("overview.done");
  });

  it("lists an idle live session without a running badge, and the tree never offers View live for it", async () => {
    const fetchMock = vi.fn(async () => okResponse(IDLE_LIVE_RESPONSE));
    vi.stubGlobal("fetch", fetchMock);

    renderSidebar(() => undefined, {
      chats: [],
      sessions: [discoveredRow],
      onOpenSession: async () => "session-active",
    });

    // Poll lands: the attached session is live but runs no agents. It is
    // listed like every live session, with no running badge, and the
    // running-agent count hides entirely rather than showing a zero.
    await act(async () => {});
    const pinned = container.querySelector(".th-sidebar-live");
    expect(pinned).not.toBeNull();
    expect(pinned?.querySelector(".th-sidebar-live-count")).toBeNull();
    const cards = pinned?.querySelectorAll<HTMLElement>(".th-overview-card");
    expect(cards).toHaveLength(1);
    expect(cards?.[0]?.textContent).toContain("Idle attached session");
    expect(cards?.[0]?.querySelector(".th-overview-card-running")).toBeNull();

    // The open attempt reports the session as active elsewhere. View live
    // stays a running-only action, so an idle session never offers it; the
    // separate force-open control stays.
    act(() => {
      container.querySelector<HTMLButtonElement>(".th-tree-children .th-tree-activation")?.click();
    });
    await act(async () => {});
    expect(container.querySelector(".th-tree-view-live")).toBeNull();
    expect(container.querySelector(".th-tree-force-open")).not.toBeNull();

    // The old gesture cannot conjure a highlight either.
    act(() => container.querySelector<HTMLButtonElement>(".th-tree-view-live")?.click());
    expect(container.querySelector(".th-sidebar-live .th-overview-card--focused")).toBeNull();
  });

  it("highlights the running session the tree names, sorts it first, and clears the highlight when its count reaches zero", async () => {
    vi.useFakeTimers();
    try {
      let pollBody: unknown = BUSY_LIVE_RESPONSE;
      const fetchMock = vi.fn(async () => okResponse(pollBody));
      vi.stubGlobal("fetch", fetchMock);

      renderSidebar(() => undefined, {
        chats: [],
        sessions: [discoveredRow, secondDiscoveredRow],
        onOpenSession: async () => "session-active",
      });

      const treeActivation = (name: string): HTMLButtonElement => {
        const activation = Array.from(container.querySelectorAll<HTMLButtonElement>(".th-tree-children .th-tree-activation"))
          .find((button) => button.textContent?.includes(name));
        expect(activation).toBeDefined();
        return activation!;
      };

      // Poll lands: both sessions run one agent each and pin working-first,
      // most-recent-activity first (disk-2's catalog recency is newer).
      await act(async () => {});
      const pinned = container.querySelector(".th-sidebar-live");
      expect(pinned).not.toBeNull();
      expect(pinned?.querySelector(".th-sidebar-live-count")?.textContent).toBe("2");
      let cards = Array.from(pinned?.querySelectorAll<HTMLElement>(".th-overview-card") ?? []);
      expect(cards.map((card) => card.querySelector(".th-overview-card-name")?.textContent))
        .toEqual(["Second busy", "First busy"]);

      // The tree names disk-2 active elsewhere; its running count is positive,
      // so View live renders and highlights the matching pinned card.
      act(() => treeActivation("Second disk session").click());
      await act(async () => {});
      const row = treeActivation("Second disk session").closest(".th-tree-node");
      const viewLive = row?.querySelector<HTMLButtonElement>(".th-tree-view-live");
      expect(viewLive).not.toBeNull();
      act(() => viewLive?.click());

      cards = Array.from(container.querySelectorAll<HTMLElement>(".th-sidebar-live .th-overview-card"));
      expect(cards).toHaveLength(2);
      expect(cards[0]?.className).toContain("th-overview-card--focused");
      expect(cards[0]?.textContent).toContain("Second busy");
      expect(cards[1]?.className).not.toContain("th-overview-card--focused");

      // Next poll: disk-2's agent finished. The idle row stays listed (every
      // live session is listed) but loses its badge and highlight, and the
      // working session sorts ahead of it.
      pollBody = SECOND_IDLE_LIVE_RESPONSE;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4000);
      });
      await act(async () => {});
      cards = Array.from(container.querySelectorAll<HTMLElement>(".th-sidebar-live .th-overview-card"));
      expect(cards).toHaveLength(2);
      expect(cards[0]?.textContent).toContain("First busy");
      expect(cards[1]?.textContent).toContain("Second busy");
      expect(cards[1]?.querySelector(".th-overview-card-running")).toBeNull();
      expect(container.querySelector(".th-sidebar-live .th-overview-card--focused")).toBeNull();
      expect(container.querySelector(".th-sidebar-live-count")?.textContent).toBe("1");
    } finally {
      vi.useRealTimers();
    }
  });
});
