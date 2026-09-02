import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../App";
import { Sidebar } from "../../components/Sidebar";
import type { SidebarProps } from "../../components/Sidebar";
import { __resetLiveBadgeStoreForTests, ingestExtensionEvent } from "./liveBadgeStore";
import { checkAuth } from "../auth/auth";
import type { Workspace, WorkspaceSession } from "./workspace";

// C002 edge coverage for the live data surfaces: empty states, live-list poll
// failure/recovery, WS-drop convergence through the overview poll, and v2
// union visibility of cursorstore-only sessions in the sidebar tree.

const layoutMocks = vi.hoisted(() => ({
  focusedSessionId: null as string | null,
  focusSession: vi.fn(() => false),
}));

vi.mock("../../features/auth/auth", () => ({ checkAuth: vi.fn(), logout: vi.fn() }));
vi.mock("../../lib/chatWs", () => ({ connectChat: vi.fn() }));
vi.mock("../../features/terminal/terminal", () => ({
  createTerminal: vi.fn(),
  deleteTerminal: vi.fn(),
  renameTerminal: vi.fn(),
}));
vi.mock("../../features/workspace/useProviderDiscovery", () => ({
  useProviderDiscovery: () => ({
    discovery: {
      status: "loaded" as const,
      providers: [{ id: "omo" as const, label: "omo", binary: "omo", available: true }],
    },
    retry: vi.fn(),
  }),
}));
vi.mock("../../features/split/useLayout", () => ({
  useLayout: () => ({
    root: { kind: "leaf" as const, sessionId: null },
    focusedPaneId: "pane-1",
    placed: new Set<string>(),
    focusSession: layoutMocks.focusSession,
    assignSession: vi.fn((_paneId: string, sessionId: string) => {
      layoutMocks.focusedSessionId = sessionId;
    }),
    focusPane: vi.fn(),
    split: vi.fn(),
    closePane: vi.fn(),
    changeRatio: vi.fn(),
    hasPane: vi.fn(() => true),
    unplaceSession: vi.fn(),
  }),
}));
vi.mock("../../features/split/paneTree", () => ({
  findLeaf: vi.fn((_root: unknown, paneId: string) =>
    layoutMocks.focusedSessionId === null
      ? null
      : { kind: "leaf" as const, id: paneId, sessionId: layoutMocks.focusedSessionId }),
}));
vi.mock("../../features/split/ChatPane", () => ({
  ChatPane: ({ chatSession }: { chatSession: { readonly id: string } }) => (
    <div data-testid="chat-pane" data-session-id={chatSession.id} />
  ),
}));

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function taskPayload(running: number, prefix: string): unknown {
  return {
    parent_session_id: "tm-1",
    tasks: Array.from({ length: running }, (_, i) => ({
      task_id: `${prefix}-t${i + 1}`,
      name: `Task ${i + 1}`,
      status: "running",
      updated_at: new Date(Date.now() - 1000).toISOString(),
      live_progress: { activity: "thinking", last_assistant_line: `line ${i + 1}` },
    })),
  };
}

/** Enriched live-summary rows: id + title + raw task/dag payloads. */
function liveBody(title: string, running: number, prefix: string): unknown {
  return { sessions: [{ id: "tm-1", title, task: taskPayload(running, prefix), dag: null }] };
}

/** Installs a fetch mock that serves /api/sessions/live from a fixed queue;
 * once the queue is exhausted every further poll gets an empty session list. */
function installLivePollQueue(entries: readonly (Response | Error)[]): ReturnType<typeof vi.fn> {
  const queue = [...entries];
  return vi.fn((input: RequestInfo | URL): Promise<Response> => {
    if (String(input) !== "/api/sessions/live") {
      return Promise.reject(new Error(`unexpected request: ${String(input)}`));
    }
    const next = queue.shift();
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next ?? okJson({ sessions: [] }));
  });
}

const WORKSPACE: Workspace = {
  id: "ws-1",
  name: "Workspace One",
  path: "/work",
  chats: [{ id: "tm-1", name: "Session One", provider: "omo" }],
};

const SESSION_ROW: WorkspaceSession = {
  id: "tm-1",
  name: "Session One",
  source: "stored",
  recencyMs: 1,
};

function sidebarProps(workspaces: readonly Workspace[], rows: readonly WorkspaceSession[]): SidebarProps {
  return {
    collapsed: false,
    onToggleCollapse: () => undefined,
    workspaces,
    activeTerminalId: null,
    placedSessions: new Set<string>(),
    liveSessions: new Set<string>(),
    expanded: new Set(workspaces.map((ws) => ws.id)),
    sessionLists: new Map([[WORKSPACE.id, rows]]),
    sessionPages: new Map(),
    onToggleExpanded: () => undefined,
    onLoadMoreSessions: () => undefined,
    onSelectTerminal: () => undefined,
    onImportSession: async () => undefined,
    onAddWorkspace: () => undefined,
    onAddTerminal: () => undefined,
    onDeleteWorkspace: () => undefined,
    onDeleteTerminal: () => undefined,
    onRenameWorkspace: async () => undefined,
    onRenameTerminal: async () => undefined,
    onLogout: () => undefined,
    notify: () => undefined,
  };
}

describe("C002 surface recovery", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    __resetLiveBadgeStoreForTests();
    window.localStorage.setItem("th-lang", "en");
    vi.mocked(checkAuth).mockResolvedValue(true);
    layoutMocks.focusedSessionId = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Drain the microtask chains of in-flight poll fetches. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  const sessionBadges = (): HTMLElement[] =>
    Array.from(container.querySelectorAll<HTMLElement>(".th-tree-children .th-tree-running"));

  function openOverview(): void {
    const trigger = container.querySelector<HTMLButtonElement>('button[title="sidebar.overview"]');
    expect(trigger).not.toBeNull();
    act(() => {
      trigger?.click();
    });
  }

  describe("empty state", () => {
    it("renders sidebar and overview empty states with no workspaces and no sessions", async () => {
      vi.stubGlobal("fetch", installLivePollQueue([okJson({ sessions: [] })]));
      await act(async () => {
        root.render(<Sidebar {...sidebarProps([], [])} />);
      });
      await settle();

      expect(container.querySelector(".th-sidebar-empty")).not.toBeNull();
      expect(container.querySelector(".th-tree")).toBeNull();
      openOverview();
      expect(document.body.querySelector(".th-overview-empty")).not.toBeNull();
      expect(document.body.querySelectorAll(".th-overview-card")).toHaveLength(0);
    });

    it("renders a workspace with zero sessions without crash", async () => {
      vi.stubGlobal("fetch", installLivePollQueue([okJson({ sessions: [] })]));
      await act(async () => {
        root.render(<Sidebar {...sidebarProps([WORKSPACE], [])} />);
      });
      await settle();

      expect(container.querySelector(".th-tree")).not.toBeNull();
      expect(container.querySelectorAll(".th-tree-children > .th-tree-node")).toHaveLength(0);
      openOverview();
      expect(document.body.querySelector(".th-overview-empty")).not.toBeNull();
    });
  });

  describe("live-list poll failure", () => {
    it("keeps the empty surface while polls fail and recovers on the next successful poll", async () => {
      vi.stubGlobal("fetch", installLivePollQueue([
        new Error("network down"),
        okJson(liveBody("Enriched One", 1, "p1")),
      ]));
      await act(async () => {
        root.render(<Sidebar {...sidebarProps([WORKSPACE], [SESSION_ROW])} />);
      });
      await settle();

      openOverview();
      expect(document.body.querySelector(".th-overview-empty")).not.toBeNull();
      expect(document.body.querySelectorAll(".th-overview-card")).toHaveLength(0);
      expect(sessionBadges()).toHaveLength(0);

      // Next 4s poll succeeds: card and tree badge appear from the poll alone.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4000);
      });
      await settle();
      const cards = document.body.querySelectorAll<HTMLElement>(".th-overview-card");
      expect(cards).toHaveLength(1);
      expect(cards[0]?.textContent).toContain("Enriched One");
      expect(sessionBadges().map((badge) => badge.textContent)).toEqual(["1"]);
    });

    it("keeps the last known-good card across a failed poll and converges on the next success", async () => {
      vi.stubGlobal("fetch", installLivePollQueue([
        okJson(liveBody("Enriched One", 1, "p1")),
        new Error("network down"),
        okJson(liveBody("Enriched One", 2, "p2")),
      ]));
      await act(async () => {
        root.render(<Sidebar {...sidebarProps([WORKSPACE], [SESSION_ROW])} />);
      });
      await settle();
      expect(sessionBadges().map((badge) => badge.textContent)).toEqual(["1"]);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(4000);
      });
      await settle();
      // Transient failure keeps the last known-good snapshot in every surface.
      expect(sessionBadges().map((badge) => badge.textContent)).toEqual(["1"]);
      expect(document.body.querySelectorAll(".th-overview-card")).toHaveLength(0); // panel never opened

      await act(async () => {
        await vi.advanceTimersByTimeAsync(4000);
      });
      await settle();
      expect(sessionBadges().map((badge) => badge.textContent)).toEqual(["2"]);
    });
  });

  describe("reconnect convergence", () => {
    it("converges the overview badge from the poll after a WS drop and lets a rebound frame win again", async () => {
      vi.stubGlobal("fetch", installLivePollQueue([
        okJson(liveBody("Enriched One", 1, "p1")),
        okJson(liveBody("Enriched One", 3, "p3")),
      ]));
      await act(async () => {
        root.render(<Sidebar {...sidebarProps([WORKSPACE], [SESSION_ROW])} />);
      });
      await settle();
      expect(sessionBadges().map((badge) => badge.textContent)).toEqual(["1"]);

      // Attached chat pushes a fresher WS frame.
      act(() => {
        ingestExtensionEvent("tm-1", "omo.task.updated", taskPayload(2, "ws2"));
      });
      expect(sessionBadges().map((badge) => badge.textContent)).toEqual(["2"]);

      // WS drops: no more frames. The next poll payload (changed content) must
      // reconverge the badge from REST, not from the stale WS override.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4000);
      });
      await settle();
      expect(sessionBadges().map((badge) => badge.textContent)).toEqual(["3"]);

      // Rebind: a fresh frame after the drop is fresher than the poll again.
      act(() => {
        ingestExtensionEvent("tm-1", "omo.task.updated", taskPayload(4, "ws4"));
      });
      expect(sessionBadges().map((badge) => badge.textContent)).toEqual(["4"]);
    });
  });

  describe("v2 union visibility", () => {
    it("shows a cursorstore-only union row in the tree, clickable like a stored row", async () => {
      const workspaces: Workspace[] = [{
        id: "ws-1",
        name: "Workspace One",
        path: "/work",
        chats: [{ id: "chat-stored", name: "Stored chat", provider: "omo" }],
      }];
      // GET /api/workspaces/ws-1/sessions after the backend union: the legacy
      // stored chat plus a cursorstore-only chat that ws.chats does not carry.
      const sessionsPage = {
        items: [
          { id: "chat-stored", name: "Stored chat", source: "stored", recencyMs: 2000 },
          { id: "chat-cursor", name: "Cursor chat", source: "stored", recencyMs: 1000 },
        ],
        nextCursor: "",
      };
      const posts: Array<{ path: string; body: unknown }> = [];
      const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const path = String(input);
        if (path === "/api/workspaces") return Promise.resolve(okJson(workspaces));
        if (path.startsWith("/api/workspaces/ws-1/sessions?")) return Promise.resolve(okJson(sessionsPage));
        if (path === "/api/sessions/live") return Promise.resolve(okJson({ sessions: [] }));
        if (init?.method === "POST") {
          posts.push({ path, body: JSON.parse(String(init.body)) });
          return Promise.resolve(okJson({ id: "chat-x", name: "x", provider: "omo" }));
        }
        return Promise.reject(new Error(`unexpected request: ${init?.method ?? "GET"} ${path}`));
      });
      vi.stubGlobal("fetch", fetchMock);

      await act(async () => {
        root.render(<App />);
      });
      await settle();
      act(() => {
        container
          .querySelector<HTMLButtonElement>(".th-tree-workspace > .th-tree-node > .th-tree-chevron")
          ?.click();
      });
      await settle();

      const rows = (): HTMLElement[] =>
        Array.from(container.querySelectorAll<HTMLElement>(".th-tree-children > .th-tree-node"));
      expect(rows()).toHaveLength(2);
      const storedRow = rows().find((row) => row.textContent?.includes("Stored chat"));
      const cursorRow = rows().find((row) => row.textContent?.includes("Cursor chat"));
      expect(storedRow).toBeDefined();
      expect(cursorRow).toBeDefined();

      // No layout drift: the union row renders through the same component path
      // as a stored row — identical node/activation classes, enabled
      // activation, no discovered/missing-source tag, same row actions.
      const storedActivation = storedRow!.querySelector<HTMLButtonElement>(".th-tree-activation");
      const cursorActivation = cursorRow!.querySelector<HTMLButtonElement>(".th-tree-activation");
      expect(cursorRow!.className).toBe(storedRow!.className);
      expect(cursorActivation).not.toBeNull();
      expect(cursorActivation!.disabled).toBe(false);
      expect(cursorActivation!.className).toBe(storedActivation!.className);
      expect(cursorRow!.querySelector(".th-tree-source")).toBeNull();
      expect(cursorRow!.querySelectorAll(".th-tree-actions button")).toHaveLength(
        storedRow!.querySelectorAll(".th-tree-actions button").length,
      );

      // Clickable: activation opens the chat itself — no import round trip.
      act(() => {
        cursorActivation!.click();
      });
      await settle();
      expect(container.querySelector('[data-testid="chat-pane"]')?.getAttribute("data-session-id"))
        .toBe("chat-cursor");
      expect(posts).toHaveLength(0);
    });
  });
});
