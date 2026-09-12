import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { emptyState, useMediaQueryMock } from "./App.testHarness";

/** Shared mock state for the App home live-session surface. The live-session
 * data rides the real shared poller and badge store; only the transport
 * (apiJson) and the pane layout are mocked, matching App.testHarness. */
const home = vi.hoisted(() => ({
  checkAuth: vi.fn(),
  assignSession: vi.fn(),
  focusPane: vi.fn(),
  workspace: { id: "ws-1", name: "Workspace", path: "/work", chats: [] as never[] },
  discovered: {
    id: "disk-1",
    name: "Disk session",
    source: "discovered" as const,
    recencyMs: 1,
    resumeIdentity: "/s/disk-1.jsonl",
  },
  openedChat: { id: "chat-opened", name: "Disk session", provider: "omo" as const },
  livePayload: { sessions: [] as readonly unknown[] },
  catalogSessions: [] as unknown[],
  refreshSessions: vi.fn(),
  openBodies: [] as unknown[],
  openOutcomes: [] as ("open" | "active" | "fail")[],
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
      if (path === "/api/workspaces/ws-1/sessions/open" && options?.method === "POST") {
        home.openBodies.push(options.body);
        const outcome = home.openOutcomes.shift();
        if (outcome === "active") {
          throw new actual.ApiError(409, "session active", { state: "session-active" });
        }
        if (outcome === "fail") {
          throw new actual.ApiError(500, "open exploded");
        }
        return home.openedChat;
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
      refreshSessions: home.refreshSessions,
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
        task: {
          parent_session_id: "disk-1",
          tasks: [
            {
              task_id: "t1",
              name: "Agent",
              status: taskStatus,
              updated_at: new Date(Date.now() - 1000).toISOString(),
              live_progress: { activity: "thinking", last_assistant_line: "ls" },
            },
          ],
        },
        dag: null,
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
    task: opts.taskStatus === undefined
      ? null
      : {
        parent_session_id: id,
        tasks: [
          {
            task_id: "t1",
            name: "Agent",
            status: opts.taskStatus,
            updated_at: new Date(Date.now() - 1000).toISOString(),
            live_progress: { activity: "thinking", last_assistant_line: "ls" },
          },
        ],
      },
    dag: null,
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
    home.catalogSessions = [home.discovered];
    home.openBodies = [];
    home.openOutcomes = [];
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

  /** Rejects when the signal does not fire within `ms`, so a missing
   * transition fails loudly instead of stalling the suite. */
  function bounded<T>(signal: Promise<T>, ms: number): Promise<T> {
    const guard = new Promise<never>((_resolve, reject) => {
      AbortSignal.timeout(ms).addEventListener("abort", () => {
        reject(new Error(`transition signal did not fire within ${ms}ms`));
      });
    });
    return Promise.race([signal, guard]);
  }

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

  /** Resolves with the args of the next placement call on the layout seam. */
  function whenPlaced(): Promise<unknown[]> {
    return new Promise((resolve) => {
      home.assignSession.mockImplementationOnce((...args: unknown[]) => {
        resolve(args);
      });
    });
  }

  async function renderApp(readySelector: string): Promise<void> {
    // Subscribe to the first meaningful render before mounting.
    const ready = bounded(whenRendered(readySelector), 1000);
    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {
      await ready;
    });
  }

  it("pins the running session above the picker and opens it through the discovered-session path", async () => {
    home.livePayload = livePayloadWith("running", "Refactor auth");
    await renderApp(".th-home-live");

    const block = container.querySelector(".th-home-live");
    expect(block).not.toBeNull();
    expect(block!.querySelector(".th-home-live-label")?.textContent).toContain("Sessions");
    expect(block!.querySelector(".th-home-live-count")?.textContent).toBe("1");
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

    // The picker's activation path: POST sessions/open, then the pane takes the chat.
    expect(home.openBodies).toEqual([
      { id: home.discovered.id, resumeIdentity: home.discovered.resumeIdentity },
    ]);
    await act(async () => {});
    expect(home.focusPane).toHaveBeenCalledWith("pane-1");
    expect(home.assignSession).toHaveBeenCalledWith("pane-1", home.openedChat.id, false);
  });

  it("omits the block when there are no live sessions at all", async () => {
    home.livePayload = { sessions: [] };
    await renderApp(".th-picker-pane");

    expect(container.querySelector(".th-picker-pane")).not.toBeNull();
    expect(container.querySelector(".th-home-live")).toBeNull();
  });

  it("lists every live session, working first then most recent, idle included", async () => {
    home.catalogSessions = [
      { ...home.discovered, id: "disk-1", recencyMs: 10 },
      { ...home.discovered, id: "disk-2", name: "Idle recent", recencyMs: 3000 },
      { ...home.discovered, id: "disk-3", name: "Idle older", recencyMs: 2000 },
    ];
    // Payload order is deliberately neither working-first nor recency order.
    home.livePayload = {
      sessions: [
        liveSessionEntry("disk-3", "Idle older", { taskStatus: "completed", active: false }),
        liveSessionEntry("disk-1", "Working session", { taskStatus: "running" }),
        liveSessionEntry("disk-2", "Idle recent", { taskStatus: "completed", active: false }),
      ],
    };
    await renderApp(".th-home-live");

    const block = container.querySelector(".th-home-live");
    expect(block).not.toBeNull();
    const cards = [...block!.querySelectorAll<HTMLElement>(".th-overview-card")];
    expect(cards).toHaveLength(3);
    expect(cards.map((card) => card.querySelector(".th-overview-card-name")?.textContent))
      .toEqual(["Working session", "Idle recent", "Idle older"]);
    // The count badge still totals agent work only.
    expect(block!.querySelector(".th-home-live-count")?.textContent).toBe("1");
    // Idle cards keep the last-output line; only the working card carries the badge.
    expect(cards[1]!.querySelector(".th-overview-card-line")?.textContent).toBe("ls");
    expect(cards[1]!.querySelector(".th-overview-card-running")).toBeNull();
    expect(cards[0]!.querySelector(".th-overview-card-running")).not.toBeNull();
  });

  it("lists a session whose only activity is the main agent (active flag, no agent tasks)", async () => {
    home.livePayload = { sessions: [liveSessionEntry("disk-1", "Main only", { active: true })] };
    await renderApp(".th-home-live");

    const card = container.querySelector<HTMLElement>(".th-home-live .th-overview-card");
    expect(card).not.toBeNull();
    expect(card!.querySelector(".th-overview-card-name")?.textContent).toBe("Main only");
    // Main-running marker, not a numeric agent badge.
    expect(card!.querySelector(".th-overview-card-running")).not.toBeNull();
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

    // Activation through the wide-layout card uses the same discovered open path.
    act(() => {
      card!.querySelector<HTMLButtonElement>(".th-overview-card-open")!.click();
    });
    expect(home.openBodies).toEqual([
      { id: home.discovered.id, resumeIdentity: home.discovered.resumeIdentity },
    ]);
    await act(async () => {});
    expect(home.assignSession).toHaveBeenCalledWith("pane-1", home.openedChat.id, false);
  });

  it("keeps the session-active force and retry states on the card", async () => {
    home.livePayload = livePayloadWith("running", "Refactor auth");
    home.openOutcomes = ["active", "open"];
    await renderApp(".th-home-live");

    const card = container.querySelector<HTMLElement>(".th-home-live .th-overview-card");
    expect(card).not.toBeNull();
    act(() => {
      card!.querySelector<HTMLButtonElement>(".th-overview-card-open")!.click();
    });
    await act(async () => {});

    expect(home.openBodies).toHaveLength(1);
    const state = card!.querySelector(".th-overview-card-state");
    expect(state?.textContent).toContain("Read-only live view");
    const force = state!.querySelector<HTMLButtonElement>(".th-overview-force-open");
    expect(force?.textContent).toBe("Open anyway");

    act(() => force!.click());
    await act(async () => {});

    expect(home.openBodies).toEqual([
      { id: home.discovered.id, resumeIdentity: home.discovered.resumeIdentity },
      { id: home.discovered.id, resumeIdentity: home.discovered.resumeIdentity, force: true },
    ]);
    expect(home.assignSession).toHaveBeenCalledWith("pane-1", home.openedChat.id, false);
    expect(container.querySelector(".th-home-live .th-overview-card-state")).toBeNull();
  });

  it("surfaces a failed discovered open on the card and retries it without force", async () => {
    home.livePayload = livePayloadWith("running", "Refactor auth");
    home.openOutcomes = ["fail", "open"];
    await renderApp(".th-home-live");

    const card = container.querySelector<HTMLElement>(".th-home-live .th-overview-card");
    expect(card).not.toBeNull();

    // First transition: an ordinary discovered open whose POST rejects with a
    // non-409 failure. Subscribe to the retry-control render BEFORE clicking,
    // then await that exact signal with a bounded, rejecting timeout.
    const retryRendered = bounded(whenRendered(".th-overview-retry-open"), 1000);
    await act(async () => {
      card!.querySelector<HTMLButtonElement>(".th-overview-card-open")!.click();
    });
    await act(async () => {
      await retryRendered;
    });

    // The hook recorded the failure through the real App-to-LiveSessionList
    // attempt map: no placement happened, and the retry control is offered.
    expect(home.openBodies).toEqual([
      { id: home.discovered.id, resumeIdentity: home.discovered.resumeIdentity },
    ]);
    expect(home.assignSession).not.toHaveBeenCalled();
    // Structural, prose-independent checks: the card exposes a live status
    // region and an enabled retry control, regardless of translated labels.
    const state = card!.querySelector('.th-overview-card-state[role="status"]');
    expect(state).not.toBeNull();
    const retry = state!.querySelector<HTMLButtonElement>(".th-overview-retry-open");
    expect(retry).not.toBeNull();
    expect(retry!.disabled).toBe(false);

    // Second transition: the retry re-issues the same discovered open body,
    // still without force, and only the success places the returned chat.
    // Subscribe to the placement seam itself BEFORE clicking Retry.
    const placed = bounded(whenPlaced(), 1000);
    await act(async () => {
      retry!.click();
    });
    let placedArgs: unknown[] | undefined;
    await act(async () => {
      placedArgs = await placed;
    });

    expect(home.openBodies).toEqual([
      { id: home.discovered.id, resumeIdentity: home.discovered.resumeIdentity },
      { id: home.discovered.id, resumeIdentity: home.discovered.resumeIdentity },
    ]);
    expect(home.assignSession).toHaveBeenCalledTimes(1);
    expect(placedArgs).toEqual(["pane-1", home.openedChat.id, false]);
    expect(home.assignSession).toHaveBeenCalledWith("pane-1", home.openedChat.id, false);
    expect(container.querySelector(".th-home-live .th-overview-card-state")).toBeNull();
  });
});
