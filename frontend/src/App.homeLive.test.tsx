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
  openBodies: [] as unknown[],
  openOutcomes: [] as ("open" | "active")[],
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
        if (home.openOutcomes.shift() === "active") {
          throw new actual.ApiError(409, "session active", { state: "session-active" });
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
vi.mock("./features/split/paneTree", () => ({ findLeaf: vi.fn(() => null) }));
vi.mock("./features/split/SplitView", async () => {
  const { splitViewMock } = await import("./App.testHarness");
  return splitViewMock;
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
      sessionLists: new Map([["ws-1", [home.discovered]]]),
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

  async function renderApp(): Promise<void> {
    await act(async () => {
      root.render(<App />);
    });
    // Settle checkAuth, the first shared live-session poll, and the summaries.
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {});
    }
  }

  it("pins the running session above the picker and opens it through the discovered-session path", async () => {
    home.livePayload = livePayloadWith("running", "Refactor auth");
    await renderApp();

    const block = container.querySelector(".th-home-live");
    expect(block).not.toBeNull();
    expect(block!.querySelector(".th-home-live-label")?.textContent).toContain("Running sessions");
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

  it("omits the block when no live session has running agents", async () => {
    home.livePayload = livePayloadWith("completed", "Idle session");
    await renderApp();

    expect(container.querySelector(".th-picker-pane")).not.toBeNull();
    expect(container.querySelector(".th-home-live")).toBeNull();
  });

  it("hands the block to the split layout's empty panes on wide screens", async () => {
    emptyState.splitEnabled = true;
    expect(useMediaQueryMock.useMediaQuery("(min-width: 1024px)")).toBe(true);
    home.livePayload = livePayloadWith("running", "Refactor auth");
    await renderApp();

    const splitView = container.querySelector("[data-testid='split-view']");
    expect(splitView).not.toBeNull();
    // The wide layout owns the empty state: the cards ride into SplitView as
    // the runningSessions prop, and the narrow empty state never renders.
    expect(splitView!.querySelector(".th-home-live")).not.toBeNull();
    expect(splitView!.querySelector(".th-home-live .th-overview-card")).not.toBeNull();
    expect(container.querySelector(".th-empty")).toBeNull();
  });

  it("keeps the session-active force and retry states on the card", async () => {
    home.livePayload = livePayloadWith("running", "Refactor auth");
    home.openOutcomes = ["active", "open"];
    await renderApp();

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
});
