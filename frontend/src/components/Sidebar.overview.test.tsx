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

/** A live (process-attached) session whose only task is done: zero running agents. */
const IDLE_LIVE_RESPONSE = {
  sessions: [
    {
      id: "disk-1",
      title: "Idle attached session",
      active: false,
      running: { agents: 0 }, done: 1,
    },
  ],
};

const catalogRow: WorkspaceSession = {
  id: "disk-1",
  name: "Disk session",
  source: "stored",
  recencyMs: 1,
};

const secondCatalogRow: WorkspaceSession = {
  id: "disk-2",
  name: "Second disk session",
  source: "stored",
  recencyMs: 2,
};

const thirdCatalogRow: WorkspaceSession = {
  id: "disk-3",
  name: "Third disk session",
  source: "stored",
  recencyMs: 3,
};

/** One working session plus two idle live sessions in the same poll. The
 * idle rows mirror the harness fixture: attached (active: false) with no
 * task and no DAG at all. */
const MIXED_LIVE_RESPONSE = {
  sessions: [
    liveEntry("disk-1", "Working session", "running"),
    liveEntry("disk-2", "Idle older", null, 1000, false),
    liveEntry("disk-3", "Idle recent", null, 500, false),
  ],
};

/** An unattached auto-enrolled daemon session arrives on the live feed keyed
 * by its stored chat id with the main agent working and two child agents. */
const DAEMON_LIVE_RESPONSE = {
  sessions: [
    { id: "chat-daemon", title: "Daemon-enrolled chat", active: true, running: { agents: 2 }, done: 0 },
  ],
};

function liveEntry(id: string, title: string, status: "running" | "completed" | null, updatedAgoMs = 1000, active?: boolean): unknown {
  return {
    id,
    title,
    // The server flags attached sessions with an explicit active boolean;
    // rows without it are finished history, not live sessions.
    ...(active === undefined ? {} : { active }),
    running: { agents: status === "running" ? 1 : 0 },
    done: status === "completed" ? 1 : 0,
    last_activity_ms: 2000 - updatedAgoMs,
  };
}

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
    readonly onOpenSession?: (ws: Workspace, session: WorkspaceSession) => Promise<"opened" | "session-active" | void>;
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
    expect(pinned?.querySelector(".th-sidebar-live-count")?.getAttribute("aria-label")).toBe("overview.runningAria");
    const cards = pinned?.querySelectorAll<HTMLElement>(".th-overview-card");
    expect(cards).toHaveLength(1);
    expect(cards?.[0]?.textContent).toContain("Refactor auth");
    // The same session still has its tree row: section card and tree row
    // coexist for one session.
    const treeLabels = [...container.querySelectorAll(".th-tree-children .th-tree-label")]
      .map((node) => node.textContent);
    expect(treeLabels).toContain("Stored session");

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
      sessions: [catalogRow, secondCatalogRow, thirdCatalogRow],
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
    // No card renders a meta line anymore: the done/dag counts were removed
    // from the card render so every card keeps a uniform height.
    expect(cards[0]?.querySelector(".th-overview-card-meta")).toBeNull();
    expect(cards[1]?.querySelector(".th-overview-card-meta")).toBeNull();
    expect(cards[2]?.querySelector(".th-overview-card-meta")).toBeNull();
    expect(cards[0]?.textContent).not.toContain("overview.done");
    expect(cards[1]?.textContent).not.toContain("overview.done");
    expect(cards[2]?.textContent).not.toContain("overview.done");
  });

  it("hides the pinned section when every live session has no open target", async () => {
    // A poll row keyed by an engine UUID no stored chat or loaded session row
    // owns: clicking it could never open anything, so no section renders.
    const fetchMock = vi.fn(async () => okResponse({
      sessions: [{ id: "durable-uuid-9", title: "Ghost elsewhere", running: { agents: 2 }, done: 0 }],
    }));
    vi.stubGlobal("fetch", fetchMock);

    renderSidebar(() => undefined, { chats: [], sessions: [catalogRow] });

    await act(async () => {});
    expect(container.querySelector(".th-sidebar-live")).toBeNull();
  });

  it("renders only openable cards, counts only their running work, and opens a catalog-only card through onOpenSession", async () => {
    // disk-1 resolves through the loaded session row; durable-uuid-9 does not
    // resolve at all. The unopenable row must not render a card, and its two
    // running agents must not leak into the section's working-count badge.
    const fetchMock = vi.fn(async () => okResponse({
      sessions: [
        liveEntry("disk-1", "Openable", "running"),
        { id: "durable-uuid-9", title: "Ghost elsewhere", running: { agents: 2 }, done: 0, last_activity_ms: 9000 },
      ],
    }));
    vi.stubGlobal("fetch", fetchMock);
    const onOpenSession = vi.fn(async () => "opened" as const);

    renderSidebar(() => undefined, { chats: [], sessions: [catalogRow], onOpenSession });

    await act(async () => {});
    const pinned = container.querySelector(".th-sidebar-live");
    expect(pinned).not.toBeNull();
    const cards = Array.from(pinned?.querySelectorAll<HTMLElement>(".th-overview-card") ?? []);
    expect(cards.map((card) => card.querySelector(".th-overview-card-name")?.textContent)).toEqual(["Openable"]);
    expect(pinned?.querySelector(".th-sidebar-live-count")?.textContent).toBe("1");

    // A catalog-only stored row has no chat to select, so the card routes to
    // the sidebar's open-attempt path.
    act(() => {
      cards[0]?.querySelector<HTMLButtonElement>(".th-overview-card-open")?.click();
    });
    expect(onOpenSession).toHaveBeenCalledTimes(1);
    expect(onOpenSession).toHaveBeenCalledWith(expect.objectContaining({ id: "ws-1", chats: [] }), catalogRow);
  });

  it("lists an idle live session without a running badge and hides the working count", async () => {
    const fetchMock = vi.fn(async () => okResponse(IDLE_LIVE_RESPONSE));
    vi.stubGlobal("fetch", fetchMock);

    renderSidebar(() => undefined, {
      chats: [],
      sessions: [catalogRow],
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
  });

  it("shows an unattached daemon session's running work on the tree chip and the section card together", async () => {
    // The live feed carries the auto-enrolled chat's id with the main agent
    // working and two child agents: the tree row's running chip and the
    // pinned section card must both surface that count.
    const fetchMock = vi.fn(async () => okResponse(DAEMON_LIVE_RESPONSE));
    vi.stubGlobal("fetch", fetchMock);

    renderSidebar(() => undefined, {
      chats: [{ id: "chat-daemon", name: "Daemon-enrolled chat", provider: "omo" }],
      sessions: [{ id: "chat-daemon", name: "Daemon-enrolled chat", source: "stored", recencyMs: 5 }],
    });

    await act(async () => {});
    const rowChip = container.querySelector(".th-tree-children .th-tree-running");
    expect(rowChip?.textContent).toBe("2");
    expect(container.querySelector(".th-tree-running--workspace")?.textContent).toBe("2");
    const pinned = container.querySelector(".th-sidebar-live");
    expect(pinned).not.toBeNull();
    expect(pinned?.querySelector(".th-sidebar-live-count")?.textContent).toBe("2");
    const daemonCard = [...(pinned?.querySelectorAll<HTMLElement>(".th-overview-card") ?? [])]
      .find((card) => card.querySelector(".th-overview-card-name")?.textContent === "Daemon-enrolled chat");
    expect(daemonCard?.querySelector(".th-overview-card-running")?.textContent).toBe("2");
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
