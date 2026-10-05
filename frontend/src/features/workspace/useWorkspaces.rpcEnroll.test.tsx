import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionTree } from "../../components/SessionTree";
import type { LayoutApi } from "../split/useLayout";
import { DISCOVERY_MERGE_INTERVAL_MS, useWorkspaces } from "./useWorkspaces";
import { listWorkspaceSessions, listWorkspaces } from "./workspace";
import type { Workspace } from "./workspace";

vi.mock("./workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./workspace")>();
  return {
    ...actual,
    listWorkspaceSessions: vi.fn(),
    listWorkspaces: vi.fn(),
  };
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

/** Wire contract after auto-enrollment: the enrolled daemon session reaches
 * the client as a stored chat row carrying the watcher's live flag and the
 * bound durable id. */
const enrolledWorkspace: Workspace = {
  id: "ws-enrolled",
  name: "owa1",
  path: "/work/owa1",
  chats: [{ id: "chat-enrolled", name: "Enrolled chat", provider: "omo" }],
};
const enrolledPage = {
  items: [{
    id: "chat-enrolled",
    name: "Enrolled chat",
    source: "stored" as const,
    recencyMs: 42,
    live: true,
    durableSessionID: "dur-1",
  }],
  nextCursor: "",
};

describe("useWorkspaces rpc auto-enrollment discovery", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: ReturnType<typeof useWorkspaces> | undefined;

  function DiscoveryProbe(): ReactElement {
    latest = useWorkspaces({
      notify: () => undefined,
      t: (key) => key,
      layout,
      confirm: async () => true,
      discoveryEnabled: true,
    });
    if (latest.workspaces.length === 0) return <div data-testid="empty" />;
    return (
      <SessionTree
        workspaces={latest.workspaces}
        activeTerminalId={null}
        placedSessions={new Set()}
        liveSessions={new Set()}
        expanded={latest.expanded}
        sessionLists={latest.sessionLists}
        sessionPages={latest.sessionPages}
        onToggle={() => undefined}
        onLoadMoreSessions={() => undefined}
        onSelect={() => undefined}
        onAddTerminal={() => undefined}
        onDeleteWorkspace={() => undefined}
        onDeleteTerminal={() => undefined}
        onRenameWorkspace={async () => undefined}
        onRenameTerminal={async () => undefined}
        notify={() => undefined}
      />
    );
  }

  const chatRows = (): HTMLElement[] =>
    Array.from(container.querySelectorAll<HTMLElement>(".th-tree-children > .th-tree-node"));

  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    vi.mocked(listWorkspaces).mockReset().mockResolvedValue([]);
    vi.mocked(listWorkspaceSessions).mockReset().mockResolvedValue(enrolledPage);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    latest = undefined;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("merges a newly enrolled workspace+chat from the empty initial state within one cycle", async () => {
    // Given: the zero-workspaces initial state - no live targets anywhere, so
    // the conditional 15s recency cadence is disarmed.
    act(() => {
      root.render(<DiscoveryProbe />);
    });
    await act(async () => {
      await latest?.load();
    });
    expect(container.querySelector('[data-testid="empty"]')).not.toBeNull();
    expect(listWorkspaces).toHaveBeenCalledTimes(1);

    // When: the daemon enrolls a new workspace + chat on the server and one
    // discovery cycle elapses.
    vi.mocked(listWorkspaces).mockResolvedValue([enrolledWorkspace]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DISCOVERY_MERGE_INTERVAL_MS);
    });

    // Then: workspace and chat row render without reload or click - the new
    // workspace auto-expanded, its first page loaded, and the row carries the
    // server-reported live flag and durable binding.
    expect(latest?.workspaces.map((workspace) => workspace.id)).toEqual(["ws-enrolled"]);
    expect(latest?.expanded.has("ws-enrolled")).toBe(true);
    expect(chatRows().map((row) => row.textContent)).toEqual(["Enrolled chat"]);
    const row = chatRows()[0]!;
    expect(row.querySelector(".th-tree-live")).not.toBeNull();
    expect(row.querySelector<HTMLButtonElement>(".th-tree-activation")?.disabled).toBe(false);
    expect(latest?.sessionLists.get("ws-enrolled")?.[0]).toMatchObject({
      live: true,
      durableSessionID: "dur-1",
    });
  });

  it("keeps rows and page fetches deduplicated across repeat cycles with the same catalog", async () => {
    // Given: an enrolled workspace merged on the first cycle.
    act(() => {
      root.render(<DiscoveryProbe />);
    });
    await act(async () => {
      await latest?.load();
    });
    vi.mocked(listWorkspaces).mockResolvedValue([enrolledWorkspace]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DISCOVERY_MERGE_INTERVAL_MS);
    });
    expect(chatRows()).toHaveLength(1);
    // The expand-effect's first-page fetch is the only sessions request so
    // far; discovery never refetches pages for brand-new workspaces.
    expect(listWorkspaceSessions).toHaveBeenCalledTimes(1);
    expect(listWorkspaceSessions).toHaveBeenCalledWith("ws-enrolled", "");

    // When: two further cycles report the same catalog with no recency
    // targets armed.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * DISCOVERY_MERGE_INTERVAL_MS);
    });

    // Then: no duplicate workspaces, chats, rows or page fetches.
    expect(latest?.workspaces).toHaveLength(1);
    expect(latest?.workspaces[0]?.chats).toHaveLength(1);
    expect(chatRows().map((row) => row.querySelector(".th-tree-label")?.textContent))
      .toEqual(["Enrolled chat"]);
    expect(listWorkspaceSessions).toHaveBeenCalledTimes(1);
  });

  it("merges a chat enrolled into an already-loaded workspace and refreshes its ready page", async () => {
    // Given: one loaded, expanded workspace whose first page is ready.
    const established: Workspace = {
      id: "ws-known",
      name: "Known",
      path: "/work/known",
      chats: [{ id: "chat-a", name: "Chat A", provider: "omo" }],
    };
    vi.mocked(listWorkspaces).mockResolvedValue([established]);
    vi.mocked(listWorkspaceSessions).mockResolvedValue({
      items: [{ id: "chat-a", name: "Chat A", source: "stored" as const, recencyMs: 10 }],
      nextCursor: "",
    });
    act(() => {
      root.render(<DiscoveryProbe />);
    });
    await act(async () => {
      await latest?.load();
    });
    await act(async () => {
      await latest?.setExpanded(new Set(["ws-known"]));
    });
    expect(chatRows().map((row) => row.textContent)).toEqual(["Chat A"]);

    // When: the daemon binds a new session inside the registered workspace's
    // cwd and the server auto-enrolls a new chat row there.
    vi.mocked(listWorkspaces).mockResolvedValue([{
      ...established,
      chats: [...established.chats, { id: "chat-bound", name: "Bound chat", provider: "omo" }],
    }]);
    vi.mocked(listWorkspaceSessions).mockResolvedValue({
      items: [
        { id: "chat-bound", name: "Bound chat", source: "stored" as const, recencyMs: 50, live: true },
        { id: "chat-a", name: "Chat A", source: "stored" as const, recencyMs: 10 },
      ],
      nextCursor: "",
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DISCOVERY_MERGE_INTERVAL_MS);
    });

    // Then: the chat merges into the known workspace, its ready first page
    // refreshes through the scheduled path, and the new row renders live.
    expect(latest?.workspaces[0]?.chats.map((chat) => chat.id)).toEqual(["chat-a", "chat-bound"]);
    expect(chatRows().map((row) => row.querySelector(".th-tree-label")?.textContent))
      .toEqual(["Bound chat", "Chat A"]);
    expect(listWorkspaceSessions).toHaveBeenCalledTimes(2);
    expect(chatRows()[0]!.querySelector(".th-tree-live")).not.toBeNull();
  });
});
