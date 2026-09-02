import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutApi } from "../split/useLayout";
import { deleteTerminal, renameTerminal } from "../terminal/terminal";
import { applyChatNameToWorkspaces, useWorkspaces } from "./useWorkspaces";
import { deleteWorkspace, listWorkspaceSessions, listWorkspaces } from "./workspace";
import type { Workspace } from "./workspace";

vi.mock("./workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./workspace")>();
  return {
    ...actual,
    deleteWorkspace: vi.fn(),
    listWorkspaceSessions: vi.fn(),
    listWorkspaces: vi.fn(),
  };
});

vi.mock("../terminal/terminal", () => ({
  deleteTerminal: vi.fn(),
  renameTerminal: vi.fn(),
}));

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

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

describe("useWorkspaces provider sessions", () => {
  let container: HTMLDivElement;
  let root: Root;
  let load: (() => Promise<void>) | undefined;

  beforeEach(() => {
    window.localStorage.removeItem("th-ws-expanded");
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("restores expanded workspaces and tolerates corrupt storage", () => {
    let latest: ReturnType<typeof useWorkspaces> | undefined;
    function Probe() {
      latest = useWorkspaces({ notify: () => undefined, t: (key) => key, layout, confirm: async () => true });
      return <span data-testid="expanded">{latest.expanded.has("ws-1") ? "yes" : "no"}</span>;
    }

    act(() => root.render(<Probe />));
    act(() => latest?.setExpanded(new Set(["ws-1"])));
    expect(window.localStorage.getItem("th-ws-expanded")).toBe('["ws-1"]');
    act(() => root.unmount());
    root = createRoot(container);
    act(() => root.render(<Probe />));
    expect(container.querySelector('[data-testid="expanded"]')?.textContent).toBe("yes");
    act(() => root.unmount());
    root = createRoot(container);
    window.localStorage.setItem("th-ws-expanded", "{broken");
    act(() => root.render(<Probe />));
    expect(container.querySelector('[data-testid="expanded"]')?.textContent).toBe("no");
  });

  it("preserves the omo provider returned by the workspace list", async () => {
    vi.mocked(listWorkspaces).mockResolvedValue([
      {
        id: "ws-1",
        name: "Workspace",
        path: "/work",
        chats: [{ id: "chat-1", name: "Chat", provider: "omo" }],
      },
    ]);

    function Probe() {
      const state = useWorkspaces({
        notify: () => undefined,
        t: (key) => key,
        layout,
        confirm: async () => true,
      });
      load = state.load;
      return <span data-testid="provider">{state.sessions.get("chat-1")?.provider}</span>;
    }

    act(() => root.render(<Probe />));
    await act(async () => load?.());

    expect(container.querySelector('[data-testid="provider"]')?.textContent).toBe("omo");
  });
});

describe("useWorkspaces paginated session history", () => {
  let container: HTMLDivElement;
  let root: Root;
  let pendingLatest: ReturnType<typeof useWorkspaces> | undefined;

  function PendingSessionsProbe() {
    pendingLatest = useWorkspaces({
      notify: () => undefined,
      t: (key) => key,
      layout,
      confirm: async () => true,
    });
    return (
      <div data-testid="sidebar-sessions">
        {(pendingLatest.sessionLists.get("ws-1") ?? []).map((session) => (
          <span key={`${session.source}:${session.id}`} data-session-id={session.id}>{session.name}</span>
        ))}
      </div>
    );
  }

  const chats = Array.from({ length: 6 }, (_, index) => ({
    id: `chat-${index + 1}`,
    name: `Chat ${index + 1}`,
    provider: "omo" as const,
  }));
  const workspace: Workspace = {
    id: "ws-1",
    name: "Workspace",
    path: "/work",
    chats,
  };

  beforeEach(() => {
    window.localStorage.removeItem("th-ws-expanded");
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    pendingLatest = undefined;
    vi.mocked(listWorkspaces).mockResolvedValue([workspace]);
    vi.mocked(listWorkspaceSessions).mockResolvedValue({
      items: chats.slice(0, 5).map((chat, index) => ({
        id: chat.id,
        name: chat.name,
        source: "stored" as const,
        recencyMs: 10 - index,
      })),
      nextCursor: "next-page",
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("reloads a restored expansion when its early session page resolves before workspaces", async () => {
    const workspaceList = deferred<Awaited<ReturnType<typeof listWorkspaces>>>();
    const firstPage = deferred<Awaited<ReturnType<typeof listWorkspaceSessions>>>();
    vi.mocked(listWorkspaces).mockReturnValueOnce(workspaceList.promise);
    vi.mocked(listWorkspaceSessions).mockReturnValueOnce(firstPage.promise);
    window.localStorage.setItem("th-ws-expanded", '["ws-1"]');

    act(() => root.render(<PendingSessionsProbe />));
    act(() => {
      void pendingLatest?.load();
    });
    await act(async () => undefined);

    firstPage.resolve({
      items: [{ id: "chat-1", name: "Chat 1", source: "stored", recencyMs: 10 }],
      nextCursor: "",
    });
    await act(async () => undefined);
    workspaceList.resolve([workspace]);
    await act(async () => undefined);

    expect(pendingLatest?.sessionLists.get("ws-1")?.map((item) => item.id)).toEqual(["chat-1"]);
    expect(pendingLatest?.sessionPages.get("ws-1")).toMatchObject({ ready: true, loading: false });
  });

  it("prunes restored expansion ids missing from the canonical workspace list", async () => {
    window.localStorage.setItem("th-ws-expanded", '["ws-1","ws-missing"]');

    act(() => root.render(<PendingSessionsProbe />));
    await act(async () => pendingLatest?.load());

    expect([...pendingLatest!.expanded]).toEqual(["ws-1"]);
    expect(window.localStorage.getItem("th-ws-expanded")).toBe('["ws-1"]');
  });

  it("keeps chats outside the first sidebar page in the canonical sessions map", async () => {
    let latest: ReturnType<typeof useWorkspaces> | undefined;

    function Probe() {
      latest = useWorkspaces({
        notify: () => undefined,
        t: (key) => key,
        layout,
        confirm: async () => true,
      });
      return null;
    }

    act(() => root.render(<Probe />));
    await act(async () => latest?.load());
    act(() => latest?.setExpanded(new Set(["ws-1"])));
    await act(async () => undefined);

    expect(latest?.sessionLists.get("ws-1")).toHaveLength(5);
    expect(latest?.workspaces[0]?.chats).toHaveLength(6);
    expect(latest?.sessions.get("chat-6")).toMatchObject({
      id: "chat-6",
      wsId: "ws-1",
      cwd: "/work",
    });
  });

  it("marks an adopted source and preserves it beside the stored copy through pagination", async () => {
    let latest: ReturnType<typeof useWorkspaces> | undefined;
    vi.mocked(listWorkspaceSessions)
      .mockResolvedValueOnce({
        items: [
          ...chats.slice(0, 4).map((chat, index) => ({
            id: chat.id,
            name: chat.name,
            source: "stored" as const,
            recencyMs: 10 - index,
          })),
          { id: "disk-session", name: "Disk session", source: "discovered", recencyMs: 5 },
        ],
        nextCursor: "next-page",
      })
      .mockResolvedValueOnce({
        items: [
          { id: "chat-new", name: "New chat", source: "stored", recencyMs: 20 },
          { id: "chat-6", name: "Chat 6", source: "stored", recencyMs: 4 },
        ],
        nextCursor: "",
      });

    function Probe() {
      latest = useWorkspaces({
        notify: () => undefined,
        t: (key) => key,
        layout,
        confirm: async () => true,
      });
      return null;
    }

    act(() => root.render(<Probe />));
    await act(async () => latest?.load());
    act(() => latest?.setExpanded(new Set(["ws-1"])));
    await act(async () => undefined);

    act(() => latest?.addCreatedSession("ws-1", {
      id: "chat-new",
      name: "New chat",
      provider: "omo",
    }, "disk-session"));

    expect(latest?.sessionLists.get("ws-1")?.map((item) => item.id)).toEqual([
      "chat-new", "chat-1", "chat-2", "chat-3", "chat-4", "disk-session",
    ]);
    expect(latest?.sessionLists.get("ws-1")?.find((item) => item.id === "disk-session")?.source)
      .toBe("alreadyAdopted");
    expect(latest?.sessionPages.get("ws-1")?.nextCursor).toBe("next-page");

    await act(async () => latest?.loadMoreSessions("ws-1"));

    expect(listWorkspaceSessions).toHaveBeenLastCalledWith("ws-1", "next-page");
    expect(latest?.sessionLists.get("ws-1")?.map((item) => item.id)).toEqual([
      "chat-new", "chat-1", "chat-2", "chat-3", "chat-4", "disk-session", "chat-6",
    ]);
    expect(latest?.sessionLists.get("ws-1")?.filter((item) => item.id === "chat-new"))
      .toHaveLength(1);
    expect(latest?.sessionLists.get("ws-1")?.find((item) => item.id === "disk-session")?.source)
      .toBe("alreadyAdopted");
    expect(latest?.sessionPages.get("ws-1")).toMatchObject({
      ready: true,
      loading: false,
      hasMore: false,
      nextCursor: "",
    });
  });

  it("merges a chat created during the pending first page and keeps load-more deduplicated", async () => {
    let latest: ReturnType<typeof useWorkspaces> | undefined;
    let resolveFirstPage!: (page: Awaited<ReturnType<typeof listWorkspaceSessions>>) => void;
    const firstPage = new Promise<Awaited<ReturnType<typeof listWorkspaceSessions>>>((resolve) => {
      resolveFirstPage = resolve;
    });
    vi.mocked(listWorkspaceSessions)
      .mockReturnValueOnce(firstPage)
      .mockResolvedValueOnce({
        items: [
          { id: "chat-new", name: "New chat", source: "stored", recencyMs: 20 },
          { id: "chat-6", name: "Chat 6", source: "stored", recencyMs: 4 },
        ],
        nextCursor: "",
      });

    function Probe() {
      latest = useWorkspaces({
        notify: () => undefined,
        t: (key) => key,
        layout,
        confirm: async () => true,
      });
      return (
        <div data-testid="sidebar-sessions">
          {(latest.sessionLists.get("ws-1") ?? []).map((session) => (
            <span key={`${session.source}:${session.id}`} data-session-id={session.id}>{session.name}</span>
          ))}
        </div>
      );
    }

    act(() => root.render(<Probe />));
    await act(async () => latest?.load());
    act(() => latest?.setExpanded(new Set(["ws-1"])));

    expect(listWorkspaceSessions).toHaveBeenCalledWith("ws-1", "");
    act(() => {
      const created = { id: "chat-new", name: "New chat", provider: "omo" as const };
      latest?.setWorkspaces((previous) => previous.map((item) =>
        item.id === "ws-1" ? { ...item, chats: [...item.chats, created] } : item));
      latest?.addCreatedSession("ws-1", created);
    });
    expect(container.querySelector('[data-session-id="chat-new"]')).toBeNull();

    await act(async () => resolveFirstPage({
      items: chats.slice(0, 5).map((chat, index) => ({
        id: chat.id,
        name: chat.name,
        source: "stored" as const,
        recencyMs: 10 - index,
      })),
      nextCursor: "next-page",
    }));

    expect(container.querySelector('[data-session-id="chat-new"]')?.textContent).toBe("New chat");
    expect(latest?.sessionLists.get("ws-1")?.map((item) => item.id)).toEqual([
      "chat-new", "chat-1", "chat-2", "chat-3", "chat-4", "chat-5",
    ]);
    expect(latest?.sessionPages.get("ws-1")?.nextCursor).toBe("next-page");

    await act(async () => latest?.loadMoreSessions("ws-1"));

    expect(listWorkspaceSessions).toHaveBeenLastCalledWith("ws-1", "next-page");
    expect(latest?.sessionLists.get("ws-1")?.map((item) => item.id)).toEqual([
      "chat-new", "chat-1", "chat-2", "chat-3", "chat-4", "chat-5", "chat-6",
    ]);
    expect(container.querySelectorAll('[data-session-id="chat-new"]')).toHaveLength(1);
    expect(latest?.workspaces[0]?.chats.map((chat) => chat.id)).toEqual([
      "chat-1", "chat-2", "chat-3", "chat-4", "chat-5", "chat-6", "chat-new",
    ]);
    expect(latest?.sessionPages.get("ws-1")).toMatchObject({
      ready: true,
      loading: false,
      hasMore: false,
      nextCursor: "",
    });
  });

  it("displays an auto-title received before the deferred first page resolves", async () => {
    const firstPage = deferred<Awaited<ReturnType<typeof listWorkspaceSessions>>>();
    vi.mocked(listWorkspaceSessions).mockReturnValueOnce(firstPage.promise);
    const created = { id: "chat-new", name: "New chat", provider: "omo" as const };

    act(() => root.render(<PendingSessionsProbe />));
    await act(async () => pendingLatest?.load());
    act(() => pendingLatest?.setExpanded(new Set(["ws-1"])));
    expect(listWorkspaceSessions).toHaveBeenCalledWith("ws-1", "");

    act(() => {
      pendingLatest?.setWorkspaces((previous) => previous.map((item) =>
        item.id === "ws-1" ? { ...item, chats: [...item.chats, created] } : item));
      pendingLatest?.addCreatedSession("ws-1", created);
      pendingLatest?.handleChatName("ws-1", "chat-new", "Generated title");
    });

    await act(async () => firstPage.resolve({
      items: [
        { id: "chat-new", name: "Generated title", source: "stored", recencyMs: 20 },
        ...chats.slice(0, 4).map((chat, index) => ({
          id: chat.id,
          name: chat.name,
          source: "stored" as const,
          recencyMs: 10 - index,
        })),
      ],
      nextCursor: "next-page",
    }));

    expect(container.querySelector('[data-session-id="chat-new"]')?.textContent).toBe("Generated title");
    expect(pendingLatest?.workspaces[0]?.chats.find((chat) => chat.id === "chat-new")?.name)
      .toBe("Generated title");
  });

  it("keeps an auto-title when the deferred page snapshot predates the created chat", async () => {
    const firstPage = deferred<Awaited<ReturnType<typeof listWorkspaceSessions>>>();
    vi.mocked(listWorkspaceSessions).mockReturnValueOnce(firstPage.promise);
    const created = { id: "chat-new", name: "New chat", provider: "omo" as const };

    act(() => root.render(<PendingSessionsProbe />));
    await act(async () => pendingLatest?.load());
    act(() => pendingLatest?.setExpanded(new Set(["ws-1"])));
    act(() => {
      pendingLatest?.setWorkspaces((previous) => previous.map((item) =>
        item.id === "ws-1" ? { ...item, chats: [...item.chats, created] } : item));
      pendingLatest?.addCreatedSession("ws-1", created);
      pendingLatest?.handleChatName("ws-1", "chat-new", "Generated title");
    });

    await act(async () => firstPage.resolve({
      items: chats.slice(0, 5).map((chat, index) => ({
        id: chat.id,
        name: chat.name,
        source: "stored" as const,
        recencyMs: 10 - index,
      })),
      nextCursor: "next-page",
    }));

    const displayedName = container.querySelector('[data-session-id="chat-new"]')?.textContent;
    expect(displayedName).toBe("Generated title");
    expect(displayedName).not.toBe("New chat");
    expect(pendingLatest?.sessionPages.get("ws-1")?.nextCursor).toBe("next-page");
  });

  it("does not restore a pending created chat deleted before the first page resolves", async () => {
    const firstPage = deferred<Awaited<ReturnType<typeof listWorkspaceSessions>>>();
    vi.mocked(listWorkspaceSessions).mockReturnValueOnce(firstPage.promise);
    vi.mocked(deleteTerminal).mockResolvedValueOnce();
    const created = { id: "chat-new", name: "New chat", provider: "omo" as const };

    act(() => root.render(<PendingSessionsProbe />));
    await act(async () => pendingLatest?.load());
    act(() => pendingLatest?.setExpanded(new Set(["ws-1"])));
    act(() => {
      pendingLatest?.setWorkspaces((previous) => previous.map((item) =>
        item.id === "ws-1" ? { ...item, chats: [...item.chats, created] } : item));
      pendingLatest?.addCreatedSession("ws-1", created);
    });

    await act(async () => pendingLatest?.handleDeleteTerminal(workspace, created));
    await act(async () => firstPage.resolve({
      items: chats.slice(0, 5).map((chat, index) => ({
        id: chat.id,
        name: chat.name,
        source: "stored" as const,
        recencyMs: 10 - index,
      })),
      nextCursor: "next-page",
    }));

    expect(deleteTerminal).toHaveBeenCalledWith("ws-1", "chat-new");
    expect(container.querySelector('[data-session-id="chat-new"]')).toBeNull();
    expect(pendingLatest?.sessionLists.get("ws-1")?.some((session) => session.id === "chat-new")).toBe(false);
  });

  it("displays a manual rename completed before the deferred first page resolves", async () => {
    const firstPage = deferred<Awaited<ReturnType<typeof listWorkspaceSessions>>>();
    vi.mocked(listWorkspaceSessions).mockReturnValueOnce(firstPage.promise);
    const created = { id: "chat-new", name: "New chat", provider: "omo" as const };
    vi.mocked(renameTerminal).mockResolvedValueOnce({ ...created, name: "Renamed chat" });

    act(() => root.render(<PendingSessionsProbe />));
    await act(async () => pendingLatest?.load());
    act(() => pendingLatest?.setExpanded(new Set(["ws-1"])));
    act(() => {
      pendingLatest?.setWorkspaces((previous) => previous.map((item) =>
        item.id === "ws-1" ? { ...item, chats: [...item.chats, created] } : item));
      pendingLatest?.addCreatedSession("ws-1", created);
    });

    await act(async () => pendingLatest?.handleRenameTerminal(workspace, created, "Renamed chat"));
    await act(async () => firstPage.resolve({
      items: [
        { id: "chat-new", name: "Renamed chat", source: "stored", recencyMs: 20 },
        ...chats.slice(0, 4).map((chat, index) => ({
          id: chat.id,
          name: chat.name,
          source: "stored" as const,
          recencyMs: 10 - index,
        })),
      ],
      nextCursor: "next-page",
    }));

    expect(renameTerminal).toHaveBeenCalledWith("ws-1", "chat-new", "Renamed chat");
    expect(container.querySelector('[data-session-id="chat-new"]')?.textContent).toBe("Renamed chat");
  });

  it("keeps a manual rename when the deferred page snapshot predates the created chat", async () => {
    const firstPage = deferred<Awaited<ReturnType<typeof listWorkspaceSessions>>>();
    vi.mocked(listWorkspaceSessions).mockReturnValueOnce(firstPage.promise);
    const created = { id: "chat-new", name: "New chat", provider: "omo" as const };
    vi.mocked(renameTerminal).mockResolvedValueOnce({ ...created, name: "Renamed chat" });

    act(() => root.render(<PendingSessionsProbe />));
    await act(async () => pendingLatest?.load());
    act(() => pendingLatest?.setExpanded(new Set(["ws-1"])));
    act(() => {
      pendingLatest?.setWorkspaces((previous) => previous.map((item) =>
        item.id === "ws-1" ? { ...item, chats: [...item.chats, created] } : item));
      pendingLatest?.addCreatedSession("ws-1", created);
    });

    await act(async () => pendingLatest?.handleRenameTerminal(workspace, created, "Renamed chat"));
    await act(async () => firstPage.resolve({
      items: chats.slice(0, 5).map((chat, index) => ({
        id: chat.id,
        name: chat.name,
        source: "stored" as const,
        recencyMs: 10 - index,
      })),
      nextCursor: "next-page",
    }));

    const displayedName = container.querySelector('[data-session-id="chat-new"]')?.textContent;
    expect(displayedName).toBe("Renamed chat");
    expect(displayedName).not.toBe("New chat");
    expect(pendingLatest?.sessionPages.get("ws-1")?.nextCursor).toBe("next-page");
  });

  it("removes a successfully deleted workspace from persisted expansion", async () => {
    vi.mocked(deleteWorkspace).mockResolvedValueOnce();
    window.localStorage.setItem("th-ws-expanded", '["ws-1"]');

    act(() => root.render(<PendingSessionsProbe />));
    await act(async () => pendingLatest?.load());
    await act(async () => pendingLatest?.handleDeleteWorkspace(workspace));

    expect(pendingLatest?.expanded.has("ws-1")).toBe(false);
    expect(window.localStorage.getItem("th-ws-expanded")).toBe("[]");
  });

  it("unplaces every canonical chat when deleting a partially paged workspace", async () => {
    let latest: ReturnType<typeof useWorkspaces> | undefined;

    function Probe() {
      latest = useWorkspaces({
        notify: () => undefined,
        t: (key) => key,
        layout,
        confirm: async () => true,
      });
      return null;
    }

    act(() => root.render(<Probe />));
    await act(async () => latest?.load());
    act(() => latest?.setExpanded(new Set(["ws-1"])));
    await act(async () => undefined);
    await act(async () => latest?.handleDeleteWorkspace(latest.workspaces[0]!));

    expect(deleteWorkspace).toHaveBeenCalledWith("ws-1");
    expect(layout.unplaceSession).toHaveBeenCalledTimes(6);
    expect(vi.mocked(layout.unplaceSession).mock.calls.map(([id]) => id)).toEqual(
      chats.map((chat) => chat.id),
    );
  });

  it("moves an opened session to the head of its workspace list without refetching", async () => {
    let latest: ReturnType<typeof useWorkspaces> | undefined;

    function Probe() {
      latest = useWorkspaces({
        notify: () => undefined,
        t: (key) => key,
        layout,
        confirm: async () => true,
      });
      return null;
    }

    act(() => root.render(<Probe />));
    await act(async () => latest?.load());
    act(() => latest?.setExpanded(new Set(["ws-1"])));
    await act(async () => undefined);

    expect(latest?.sessionLists.get("ws-1")?.map((item) => item.id)).toEqual([
      "chat-1", "chat-2", "chat-3", "chat-4", "chat-5",
    ]);
    expect(listWorkspaceSessions).toHaveBeenCalledTimes(1);

    act(() => latest?.markSessionUsed("ws-1", "chat-3"));

    // Hoisted to head, deduplicated, purely local state: no page refetch and
    // the paging cursor survives untouched.
    expect(latest?.sessionLists.get("ws-1")?.map((item) => item.id)).toEqual([
      "chat-3", "chat-1", "chat-2", "chat-4", "chat-5",
    ]);
    expect(latest?.sessionLists.get("ws-1")?.filter((item) => item.id === "chat-3"))
      .toHaveLength(1);
    expect(listWorkspaceSessions).toHaveBeenCalledTimes(1);
    expect(latest?.sessionPages.get("ws-1")).toMatchObject({
      ready: true,
      loading: false,
      hasMore: true,
      nextCursor: "next-page",
    });

    // Unknown or foreign ids leave the list untouched.
    act(() => latest?.markSessionUsed("ws-1", "chat-unknown"));
    expect(latest?.sessionLists.get("ws-1")?.map((item) => item.id)).toEqual([
      "chat-3", "chat-1", "chat-2", "chat-4", "chat-5",
    ]);
  });

  it("loads the picker's first page on demand without refetching while loading or ready", async () => {
    let latest: ReturnType<typeof useWorkspaces> | undefined;
    let resolveFirstPage!: (page: Awaited<ReturnType<typeof listWorkspaceSessions>>) => void;
    const firstPage = new Promise<Awaited<ReturnType<typeof listWorkspaceSessions>>>((resolve) => {
      resolveFirstPage = resolve;
    });
    vi.mocked(listWorkspaceSessions).mockReturnValueOnce(firstPage);

    function Probe() {
      latest = useWorkspaces({
        notify: () => undefined,
        t: (key) => key,
        layout,
        confirm: async () => true,
      });
      return null;
    }

    act(() => root.render(<Probe />));
    await act(async () => latest?.load());
    expect(listWorkspaceSessions).not.toHaveBeenCalled();

    act(() => latest?.ensureSessionsLoaded("ws-1"));
    expect(listWorkspaceSessions).toHaveBeenCalledTimes(1);
    expect(listWorkspaceSessions).toHaveBeenCalledWith("ws-1", "");
    expect(latest?.sessionPages.get("ws-1")).toMatchObject({ ready: false, loading: true });

    // Still in flight: a repeated trigger must not start a second fetch.
    act(() => latest?.ensureSessionsLoaded("ws-1"));
    expect(listWorkspaceSessions).toHaveBeenCalledTimes(1);

    await act(async () => resolveFirstPage({
      items: chats.slice(0, 5).map((chat, index) => ({
        id: chat.id,
        name: chat.name,
        source: "stored" as const,
        recencyMs: 10 - index,
      })),
      nextCursor: "next-page",
    }));
    expect(latest?.sessionPages.get("ws-1")).toMatchObject({ ready: true, loading: false });

    // Ready: the trigger is a no-op, no render-driven refetch loop.
    act(() => latest?.ensureSessionsLoaded("ws-1"));
    expect(listWorkspaceSessions).toHaveBeenCalledTimes(1);
    expect(latest?.sessionLists.get("ws-1")?.map((item) => item.id)).toEqual([
      "chat-1", "chat-2", "chat-3", "chat-4", "chat-5",
    ]);
  });
});

describe("applyChatNameToWorkspaces", () => {
  const workspaces: readonly Workspace[] = [
    {
      id: "ws-1",
      name: "Alpha",
      path: "/alpha",
      chats: [
        { id: "chat-1", name: "Old name", provider: "omo" },
        { id: "chat-2", name: "Keep me", provider: "omo" },
      ],
    },
    {
      id: "ws-2",
      name: "Beta",
      path: "/beta",
      chats: [{ id: "chat-3", name: "Other workspace chat", provider: "omo" }],
    },
  ];

  it("replaces only the target chat name immutably", () => {
    const next = applyChatNameToWorkspaces(workspaces, "ws-1", "chat-1", "Weekly recap");
    expect(next).not.toBe(workspaces);
    expect(next[0]).not.toBe(workspaces[0]);
    expect(next[0]?.chats).not.toBe(workspaces[0]?.chats);
    expect(next[0]?.chats[0]).toEqual({ id: "chat-1", name: "Weekly recap", provider: "omo" });
    expect(next[0]?.chats[1]).toBe(workspaces[0]?.chats[1]);
    expect(next[1]).toBe(workspaces[1]);
    expect(workspaces[0]?.chats[0]?.name).toBe("Old name");
  });
});
