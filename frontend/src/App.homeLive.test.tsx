import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { emptyState, useMediaQueryMock } from "./App.testHarness";
import { translate } from "./i18n";

/** Shared mock state for the App home live-session surface. The live-session
 * data rides the real shared poller and badge store; only the transport
 * (apiJson) and the pane layout are mocked, matching App.testHarness. */
const home = vi.hoisted(() => ({
  checkAuth: vi.fn(),
  assignSession: vi.fn(),
  focusPane: vi.fn(),
  workspace: { id: "ws-1", name: "Workspace", path: "/work", chats: [] as never[] },
  catalogRow: {
    id: "disk-1",
    name: "Disk session",
    source: "stored" as const,
    recencyMs: 1,
  },
  livePayload: { sessions: [] as readonly unknown[] },
  catalogSessions: [] as unknown[],
  openBodies: [] as unknown[],
}));

vi.mock("./features/auth/auth", () => ({
  checkAuth: home.checkAuth,
  logout: vi.fn(async () => undefined),
}));

vi.mock("./lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/api")>();
  return {
    ...actual,
    apiJson: vi.fn(async (path: string, options?: { readonly method?: string; readonly body?: unknown }) => {
      if (path === "/api/sessions/live") return home.livePayload;
      // Recorded so every case can prove the open path issues no REST call.
      if (path === "/api/workspaces/ws-1/sessions/open" && options?.method === "POST") {
        home.openBodies.push(options.body);
        return { id: "chat-opened", name: "Disk session", provider: "omo" };
      }
      return [];
    }),
  };
});

vi.mock("./lib/chatWs", () => ({ connectChat: vi.fn() }));
vi.mock("./features/terminal/terminal", () => ({ createTerminal: vi.fn() }));
vi.mock("./lib/useMediaQuery", async () => {
  const { useMediaQueryMock } = await import("./App.testHarness");
  return useMediaQueryMock;
});
vi.mock("./features/split/paneTree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./features/split/paneTree")>();
  return { ...actual, findLeaf: vi.fn(() => null) };
});
vi.mock("./features/split/ChatPane", () => ({ ChatPane: () => <div data-testid="chat-pane" /> }));
vi.mock("./components/Sidebar", () => ({
  MOBILE_QUERY: "(max-width: 768px)",
  Sidebar: () => <aside data-testid="sidebar" />,
}));
vi.mock("./features/workspace/WorkspaceWizard", () => ({ WorkspaceWizard: () => null }));
vi.mock("./components/NewChatDialog", () => ({ NewChatDialog: () => null }));
vi.mock("./features/workspace/useProviderDiscovery", () => ({
  useProviderDiscovery: () => ({
    discovery: {
      status: "loaded" as const,
      providers: [{ id: "omo" as const, label: "omo", binary: "omo", available: true }],
    },
    retry: vi.fn(),
  }),
}));

vi.mock("./features/split/useLayout", () => ({
  useLayout: () => ({
    root: { kind: "leaf" as const, id: "pane-1", sessionId: null },
    focusedPaneId: "pane-1",
    placed: new Set<string>(),
    focusSession: () => false,
    assignSession: home.assignSession,
    focusPane: home.focusPane,
    split: vi.fn(),
    closePane: vi.fn(),
    changeRatio: vi.fn(),
    hasPane: () => true,
    unplaceSession: vi.fn(),
  }),
}));

vi.mock("./features/workspace/useWorkspaces", () => ({
  useWorkspaces: () => {
    const [workspaces, setWorkspaces] = useState([home.workspace]);
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(["ws-1"]));
    return {
      workspaces,
      setWorkspaces,
      expanded,
      setExpanded,
      sessions: new Map(),
      sessionLists: new Map([["ws-1", home.catalogSessions]]),
      sessionPages: new Map([["ws-1", { ready: true, loading: false, hasMore: false, nextCursor: "" }]]),
      load: () => undefined,
      addCreatedSession: () => undefined,
      loadMoreSessions: async () => undefined,
      ensureSessionsLoaded: () => undefined,
      markSessionUsed: () => undefined,
      toggleExpanded: () => undefined,
      handleDeleteWorkspace: async () => undefined,
      handleDeleteTerminal: async () => undefined,
      handleRenameWorkspace: async () => undefined,
      handleRenameTerminal: async () => undefined,
      handleChatName: () => undefined,
    };
  },
}));

function installMatchMedia(): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

/** A live (process-attached) session whose only task carries the given status. */
function livePayloadWith(taskStatus: string, title: string): { sessions: readonly unknown[] } {
  return {
    sessions: [
      {
        id: "disk-1",
        title,
        running: { agents: taskStatus === "running" ? 1 : 0 },
        done: taskStatus === "completed" ? 1 : 0,
        last_line: "ls",
      },
    ],
  };
}

/** One live-session payload entry: a running/idle agent task, no task at
 * all, and/or the main-session active flag. */
function liveSessionEntry(
  id: string,
  title: string,
  opts: { readonly taskStatus?: string; readonly active?: boolean } = {},
): unknown {
  return {
    id,
    title,
    ...(opts.active === undefined ? {} : { active: opts.active }),
    running: { agents: opts.taskStatus === "running" ? 1 : 0 },
    done: opts.taskStatus === "completed" ? 1 : 0,
    ...(opts.taskStatus === undefined ? {} : { last_line: "ls" }),
  };
}

describe("App home running sessions", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    installMatchMedia();
    emptyState.splitEnabled = false;
    window.localStorage.setItem("th-lang", "en");
    home.checkAuth.mockResolvedValue(true);
    home.livePayload = { sessions: [] };
    home.catalogSessions = [home.catalogRow];
    home.openBodies = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  /** Resolves when an element matching `selector` exists inside the mounted
   * container. Subscribes via MutationObserver BEFORE the triggering action,
   * so the await observes the exact render transition - no polling. */
  function whenRendered(selector: string): Promise<Element> {
    const existing = container.querySelector(selector);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        const el = container.querySelector(selector);
        if (el) {
          observer.disconnect();
          resolve(el);
        }
      });
      observer.observe(container, { childList: true, subtree: true });
    });
  }

  async function renderApp(readySelector: string): Promise<void> {
    // Subscribe to the first meaningful render before mounting.
    const ready = whenRendered(readySelector);
    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {
      await ready;
    });
  }

  it("pins the running session above the picker and opens it without an open request", async () => {
    home.livePayload = livePayloadWith("running", "Refactor auth");
    await renderApp(".th-home-live");

    const block = container.querySelector(".th-home-live");
    expect(block).not.toBeNull();
    // Structural label check: the section header exists and carries the
    // working-count badge (translation wiring is covered by locale tests).
    const label = block!.querySelector(".th-home-live-label");
    expect(label).not.toBeNull();
    expect(label!.querySelector(".th-home-live-count")?.textContent).toBe("1");
    const cards = block!.querySelectorAll<HTMLElement>(".th-overview-card");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.querySelector(".th-overview-card-name")?.textContent).toBe("Refactor auth");
    expect(cards[0]!.querySelector(".th-overview-card-line")?.textContent).toBe("ls");

    const picker = container.querySelector(".th-picker-pane");
    expect(picker).not.toBeNull();
    expect(block!.compareDocumentPosition(picker!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    act(() => {
      cards[0]!.querySelector<HTMLButtonElement>(".th-overview-card-open")!.click();
    });

    // The catalog row is already a stored chat identity: activation is a
    // local placement, never a sessions/open request.
    expect(home.openBodies).toEqual([]);
    await act(async () => {});
    expect(home.focusPane).toHaveBeenCalledWith("pane-1");
    expect(home.assignSession).toHaveBeenCalledWith("pane-1", home.catalogRow.id, false);
  });

  it("omits the block when there are no live sessions at all", async () => {
    home.livePayload = { sessions: [] };
    await renderApp(".th-picker-pane");

    expect(container.querySelector(".th-picker-pane")).not.toBeNull();
    expect(container.querySelector(".th-home-live")).toBeNull();
  });

  it("omits the block when every live session has no open target", async () => {
    // A foreign engine UUID no stored chat or loaded session row owns: the
    // card could not open anything, so the whole block stays unrendered.
    home.livePayload = { sessions: [liveSessionEntry("durable-uuid-9", "Ghost elsewhere", { taskStatus: "running" })] };
    home.catalogSessions = [];
    await renderApp(".th-picker-pane");

    expect(container.querySelector(".th-picker-pane")).not.toBeNull();
    expect(container.querySelector(".th-home-live")).toBeNull();
  });

  it("renders only the openable card and counts only its running work", async () => {
    // disk-1 resolves through the loaded catalog row; durable-uuid-9 resolves
    // to nothing. Its three running agents must not appear on the card, in
    // the label count, or anywhere in the block.
    home.livePayload = {
      sessions: [
        liveSessionEntry("disk-1", "Refactor auth", { taskStatus: "running" }),
        { id: "durable-uuid-9", title: "Ghost elsewhere", running: { agents: 3 }, done: 0, last_line: "pwd" },
      ],
    };
    await renderApp(".th-home-live");

    const block = container.querySelector(".th-home-live");
    expect(block).not.toBeNull();
    const cards = [...block!.querySelectorAll<HTMLElement>(".th-overview-card")];
    expect(cards.map((card) => card.querySelector(".th-overview-card-name")?.textContent)).toEqual(["Refactor auth"]);
    expect(block!.textContent).not.toContain("Ghost elsewhere");
    expect(block!.querySelector(".th-home-live-count")?.textContent).toBe("1");
  });

  it("lists every live session, working first then most recent, idle included", async () => {
    home.catalogSessions = [
      { ...home.catalogRow, id: "disk-1", recencyMs: 10 },
      { ...home.catalogRow, id: "disk-2", name: "Idle recent", recencyMs: 3000 },
      { ...home.catalogRow, id: "disk-3", name: "Idle older", recencyMs: 2000 },
    ];
    // Payload order is deliberately neither working-first nor recency order.
    // The idle rows have no task and no DAG at all, matching the harness
    // fixture for attached-but-idle sessions.
    home.livePayload = {
      sessions: [
        liveSessionEntry("disk-3", "Idle older", { active: false }),
        liveSessionEntry("disk-1", "Working session", { taskStatus: "running" }),
        liveSessionEntry("disk-2", "Idle recent", { active: false }),
      ],
    };
    await renderApp(".th-home-live");

    const block = container.querySelector(".th-home-live");
    expect(block).not.toBeNull();
    const cards = [...block!.querySelectorAll<HTMLElement>(".th-overview-card")];
    expect(cards).toHaveLength(3);
    expect(cards.map((card) => card.querySelector(".th-overview-card-name")?.textContent))
      .toEqual(["Working session", "Idle recent", "Idle older"]);
    // The count badge still totals agent work only, and its accessible name
    // says what it counts.
    const count = block!.querySelector(".th-home-live-count");
    expect(count?.textContent).toBe("1");
    // Shipped-copy equality with the exact numeric parameter: any other
    // count (10, 11, 21, ...) fails, whatever the shipped phrasing is.
    expect(count?.getAttribute("aria-label")).toBe(translate("en", "overview.runningAria", { n: 1 }));
    // No card renders the removed done/DAG metadata; the last-output line
    // remains the only supplemental content on the resting cards.
    expect(cards[1]!.querySelector(".th-overview-card-running")).toBeNull();
    expect(cards[0]!.querySelector(".th-overview-card-running")).not.toBeNull();
    for (const card of cards) {
      expect(card.querySelector(".th-overview-card-meta")).toBeNull();
      expect(card.textContent).not.toContain("Done");
      expect(card.textContent).not.toContain("DAG");
    }
  });

  it("lists a session whose only activity is the main agent (active flag, no agent tasks)", async () => {
    home.livePayload = { sessions: [liveSessionEntry("disk-1", "Main only", { active: true })] };
    await renderApp(".th-home-live");

    const card = container.querySelector<HTMLElement>(".th-home-live .th-overview-card");
    expect(card).not.toBeNull();
    expect(card!.querySelector(".th-overview-card-name")?.textContent).toBe("Main only");
    // Main-running marker, not a numeric agent badge.
    expect(card!.querySelector(".th-overview-card-running")).not.toBeNull();
    // Zero child agents: no count next to the label, and no meta line on the card.
    expect(container.querySelector(".th-home-live-count")).toBeNull();
    expect(card!.querySelector(".th-overview-card-meta")).toBeNull();
  });

  it("hands the block to the split layout's empty panes on wide screens", async () => {
    emptyState.splitEnabled = true;
    expect(useMediaQueryMock.useMediaQuery("(min-width: 1024px)")).toBe(true);
    home.livePayload = livePayloadWith("running", "Refactor auth");
    await renderApp(".th-home-live");

    // The REAL SplitView renders the empty leaf pane: the running-session cards
    // ride in as the runningSessions prop above the pane's session picker, and
    // the narrow empty state never renders.
    const pane = container.querySelector(".th-pane-wrap");
    expect(pane).not.toBeNull();
    const block = pane!.querySelector(".th-home-live");
    expect(block).not.toBeNull();
    const card = block!.querySelector<HTMLElement>(".th-overview-card");
    expect(card?.querySelector(".th-overview-card-name")?.textContent).toBe("Refactor auth");
    const picker = pane!.querySelector(".th-picker-pane");
    expect(picker).not.toBeNull();
    expect(block!.compareDocumentPosition(picker!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector(".th-empty")).toBeNull();

    // Activation through the wide-layout card places the chat locally too:
    // the same no-REST open path as the narrow surface.
    act(() => {
      card!.querySelector<HTMLButtonElement>(".th-overview-card-open")!.click();
    });
    expect(home.openBodies).toEqual([]);
    await act(async () => {});
    expect(home.assignSession).toHaveBeenCalledWith("pane-1", home.catalogRow.id, false);
  });

  it("keeps the home card free of any force-open or read-only state", async () => {
    home.livePayload = livePayloadWith("running", "Refactor auth");
    await renderApp(".th-home-live");

    const card = container.querySelector<HTMLElement>(".th-home-live .th-overview-card");
    expect(card).not.toBeNull();
    act(() => {
      card!.querySelector<HTMLButtonElement>(".th-overview-card-open")!.click();
    });
    await act(async () => {});

    // The open placed the chat locally; the card never regresses to a
    // session-active takeover UI - no force-open control, no read-only
    // prose, no lingering status region.
    expect(home.openBodies).toEqual([]);
    expect(home.assignSession).toHaveBeenCalledWith("pane-1", home.catalogRow.id, false);
    const settledBlock = container.querySelector(".th-home-live");
    expect(settledBlock).not.toBeNull();
    expect(container.querySelector(".th-home-live .th-overview-force-open")).toBeNull();
    expect(settledBlock!.textContent).not.toContain("overview.readOnlyLive");
    expect(container.querySelector(".th-home-live .th-overview-card-state")).toBeNull();
  });
});
