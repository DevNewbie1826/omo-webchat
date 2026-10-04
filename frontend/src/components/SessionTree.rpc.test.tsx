import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../i18n";
import type { I18nValue } from "../i18n";
import { App } from "../App";
import { SessionTree } from "./SessionTree";
import { rpcSessionAttemptKey } from "../features/workspace/useRpcSessions";
import type { RpcSessionInfo } from "../features/workspace/rpcSessions";
import type { Terminal, Workspace, WorkspaceSession } from "../features/workspace/workspace";

const i18n: I18nValue = {
  lang: "en",
  setLang: () => undefined,
  font: "system",
  setFont: () => undefined,
  fontSize: 13,
  setFontSize: () => undefined,
  t: (key, vars) => (vars ? `${key} ${Object.values(vars).join(" ")}` : key),
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function rpcSession(overrides: Partial<RpcSessionInfo> = {}): RpcSessionInfo {
  return {
    sessionId: "rpc-1",
    durableSessionId: "01a1durable-1",
    sessionPath: "/work/x.jsonl",
    cwd: "/work",
    name: "Headless alpha",
    status: "idle",
    questions: [],
    messageCount: 1,
    updatedAt: 0,
    workspaceId: "ws-1",
    ...overrides,
  };
}

const workspaceOne: Workspace = { id: "ws-1", name: "Workspace", path: "/work", chats: [] };
const workspaceTwo: Workspace = { id: "ws-2", name: "Other", path: "/other", chats: [] };

const treeSessions: readonly WorkspaceSession[] = [
  { id: "01a1durable-2", name: "Duplicate", source: "discovered", recencyMs: 2, resumeIdentity: "/work/dup.jsonl" },
  { id: "disk-7", name: "Disk keep", source: "discovered", recencyMs: 1, resumeIdentity: "/work/keep.jsonl" },
];

const rpcSessions: readonly RpcSessionInfo[] = [
  rpcSession({ sessionId: "rpc-1", status: "working", name: "Worker" }),
  rpcSession({ sessionId: "rpc-2", durableSessionId: "01a1durable-2", status: "blocked", name: "Blocked one", questions: ["Continue?"] }),
  rpcSession({ sessionId: "rpc-3", status: "done", name: "Done one" }),
  rpcSession({ sessionId: "rpc-4", status: "idle", name: "" }),
  rpcSession({ sessionId: "rpc-5", status: "closed", name: "Closed one" }),
  rpcSession({ sessionId: "rpc-6", workspaceId: "ws-2", status: "idle", name: "Other workspace row" }),
];

interface TreeHandlers {
  onOpenRpc?: (ws: Workspace, rpc: RpcSessionInfo) => Promise<"opened" | "failed" | void>;
  rpcOpenAttempts?: ReadonlyMap<string, "opening" | "failed">;
  rpcSessions?: readonly RpcSessionInfo[];
}

describe("SessionTree RPC session group", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function renderTree(handlers: TreeHandlers = {}): void {
    act(() => {
      root.render(
        <I18nContext.Provider value={i18n}>
          <SessionTree
            workspaces={[workspaceOne, workspaceTwo]}
            activeTerminalId={null}
            placedSessions={new Set<string>()}
            liveSessions={new Set<string>()}
            expanded={new Set(["ws-1", "ws-2"])}
            sessionLists={new Map([["ws-1", treeSessions], ["ws-2", []]])}
            sessionPages={new Map()}
            onToggle={() => undefined}
            onLoadMoreSessions={() => undefined}
            onSelect={() => undefined}
            onOpen={async () => undefined}
            onAddTerminal={() => undefined}
            onDeleteWorkspace={() => undefined}
            onDeleteTerminal={() => undefined}
            onRenameWorkspace={async () => undefined}
            onRenameTerminal={async () => undefined}
            notify={() => undefined}
            rpcSessions={handlers.rpcSessions ?? rpcSessions}
            onOpenRpc={handlers.onOpenRpc ?? (async () => undefined)}
            {...(handlers.rpcOpenAttempts ? { rpcOpenAttempts: handlers.rpcOpenAttempts } : {})}
          />
        </I18nContext.Provider>,
      );
    });
  }

  const workspaceGroup = (id: string): HTMLElement => {
    const element = Array.from(container.querySelectorAll<HTMLElement>(".th-tree-workspace"))
      .find((node) => node.querySelector(".th-tree-workspace-activation")?.getAttribute("aria-label") === id);
    expect(element, `workspace group ${id}`).toBeDefined();
    return element!;
  };

  it("renders one row per listed session with its status pill, only under its own workspace", () => {
    renderTree();

    const one = workspaceGroup("Workspace");
    expect(one.querySelector(".th-tree-rpc")?.getAttribute("role")).toBe("group");
    for (const status of ["working", "blocked", "done", "idle", "closed"]) {
      const pill = one.querySelector<HTMLElement>(`.th-rpc-status--${status}`);
      expect(pill, `pill ${status}`).not.toBeNull();
      expect(pill!.textContent).toBe(`sidebar.rpc.status.${status}`);
    }
    expect(one.textContent).toContain("Worker");
    expect(one.textContent).toContain("Blocked one");
    expect(one.textContent).toContain("Done one");
    expect(one.querySelector(".th-tree-rpc")?.textContent).not.toContain("Other workspace row");
    const otherRow = one.querySelector('[aria-label="sidebar.rpc.aria Other workspace row sidebar.rpc.status.idle"]');
    expect(otherRow).toBeNull();

    const two = workspaceGroup("Other");
    expect(two.querySelector(".th-tree-rpc")?.textContent).toContain("Other workspace row");
    expect(two.querySelectorAll(".th-rpc-status")).toHaveLength(1);
  });

  it("falls back to the session id when the daemon session has no name", () => {
    renderTree();

    const idle = workspaceGroup("Workspace")
      .querySelector('[aria-label="sidebar.rpc.aria rpc-4 sidebar.rpc.status.idle"]');
    expect(idle).not.toBeNull();
    expect(idle!.textContent).toContain("rpc-4");
  });

  it("puts the pending question text in the blocked row's title", () => {
    renderTree();

    const blocked = workspaceGroup("Workspace")
      .querySelector<HTMLButtonElement>('[aria-label="sidebar.rpc.aria Blocked one sidebar.rpc.status.blocked"]');
    expect(blocked?.getAttribute("title")).toBe("Continue?");
  });

  it("hides a discovered history row duplicated by a listed RPC session", () => {
    renderTree();

    const one = workspaceGroup("Workspace");
    expect(one.textContent).not.toContain("Duplicate");
    expect(one.textContent).toContain("Disk keep");
  });

  it("keeps discovered rows when no RPC session duplicates them", () => {
    renderTree({ rpcSessions: [rpcSession({ durableSessionId: "01a1-unrelated" })] });

    expect(workspaceGroup("Workspace").textContent).toContain("Duplicate");
  });

  it("does not render the group at all when the workspace has no RPC sessions", () => {
    renderTree({ rpcSessions: rpcSessions.filter((rpc) => rpc.workspaceId !== "ws-1") });

    expect(workspaceGroup("Workspace").querySelector(".th-tree-rpc")).toBeNull();
  });

  it("keeps a closed row non-interactive", () => {
    const onOpenRpc = vi.fn(async () => "opened" as const);
    renderTree({ onOpenRpc });

    const closed = workspaceGroup("Workspace")
      .querySelector<HTMLButtonElement>('[aria-label="sidebar.rpc.aria Closed one sidebar.rpc.status.closed"]');
    expect(closed?.disabled).toBe(true);
    act(() => closed?.click());
    expect(onOpenRpc).not.toHaveBeenCalled();
  });

  it("opens on click, shows the opening state, and retries after a failure", () => {
    const onOpenRpc = vi.fn(async () => "opened" as const);
    renderTree({
      onOpenRpc,
      rpcOpenAttempts: new Map([
        [rpcSessionAttemptKey("ws-1", "rpc-2"), "failed"],
      ]),
    });

    const one = workspaceGroup("Workspace");
    const worker = one.querySelector<HTMLButtonElement>('[aria-label="sidebar.rpc.aria Worker sidebar.rpc.status.working"]')!;
    act(() => worker.click());
    expect(onOpenRpc).toHaveBeenCalledTimes(1);
    expect(onOpenRpc).toHaveBeenCalledWith(workspaceOne, expect.objectContaining({ sessionId: "rpc-1" }));

    const blocked = one.querySelector<HTMLElement>('[aria-label="sidebar.rpc.aria Blocked one sidebar.rpc.status.blocked"]')!;
    expect(blocked.textContent).toContain("sidebar.tm.openFailed");
    act(() => blocked.click());
    expect(onOpenRpc).toHaveBeenCalledTimes(2);
    expect(onOpenRpc).toHaveBeenLastCalledWith(workspaceOne, expect.objectContaining({ sessionId: "rpc-2" }));
  });

  it("renders the opening label from the attempts map", () => {
    renderTree({
      rpcOpenAttempts: new Map([
        [rpcSessionAttemptKey("ws-1", "rpc-3"), "opening"],
      ]),
    });

    const done = workspaceGroup("Workspace")
      .querySelector<HTMLElement>('[aria-label="sidebar.rpc.aria Done one sidebar.rpc.status.done"]');
    expect(done?.textContent).toContain("sidebar.tm.opening");
  });
});

describe("App RPC open wiring", () => {
  const appMocks = vi.hoisted(() => ({
    assignSession: vi.fn(),
    focusPane: vi.fn(),
    checkAuth: vi.fn(async () => true),
    focusSession: vi.fn(() => false),
  }));

  vi.mock("../features/auth/auth", () => ({
    checkAuth: appMocks.checkAuth,
    logout: vi.fn(async () => undefined),
  }));

  vi.mock("../features/workspace/useLiveSessions", () => ({
    useLiveSessions: () => new Set<string>(),
    useLiveSessionInfos: () => [],
  }));

  vi.mock("../features/workspace/useProviderDiscovery", () => ({
    useProviderDiscovery: () => ({
      discovery: { status: "loaded" as const, providers: [{ id: "omo" as const, label: "omo", binary: "omo", available: true }] },
      retry: vi.fn(),
    }),
  }));

  vi.mock("../features/split/useLayout", () => ({
    useLayout: () => ({
      root: { kind: "leaf" as const, id: "pane-1", sessionId: null },
      focusedPaneId: "pane-1",
      placed: new Set<string>(),
      focusPane: appMocks.focusPane,
      hasPane: vi.fn(() => true),
      assignSession: appMocks.assignSession,
      split: vi.fn(),
      closePane: vi.fn(),
      changeRatio: vi.fn(),
      unplaceSession: vi.fn(),
      focusSession: appMocks.focusSession,
    }),
  }));

  let container: HTMLDivElement;
  let root: Root;
  let workspaceResponse: Deferred<Response>;
  let sessionsResponse: Deferred<Response>;
  let rpcListResponse: Deferred<Response>;
  let openResponses: Promise<Response>[];
  let fetchMock: ReturnType<typeof vi.fn>;

  const openCalls = (): readonly (readonly [RequestInfo | URL, RequestInit | undefined])[] =>
    fetchMock.mock.calls
      .filter(([input, init]) => String(input).endsWith("/rpc-sessions/open") && init?.method === "POST")
      .map(([input, init]) => [input as RequestInfo | URL, init as RequestInit | undefined] as const);

  function installMatchMedia(): void {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: () => undefined, removeEventListener: () => undefined,
      addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
    }));
  }

  async function renderLoadedApp(): Promise<void> {
    await act(async () => { root.render(<App />); });
    await act(async () => {
      workspaceResponse.resolve(jsonResponse([workspaceOne]));
      await workspaceResponse.promise;
    });
    const expand = container.querySelector<HTMLButtonElement>(".th-tree-chevron[aria-expanded]");
    expect(expand).not.toBeNull();
    act(() => expand?.click());
    await act(async () => {
      sessionsResponse.resolve(jsonResponse({ items: [], nextCursor: "" }));
      await sessionsResponse.promise;
    });
    await act(async () => {
      rpcListResponse.resolve(jsonResponse({
        sessions: [
          rpcSession({ sessionId: "rpc-1", status: "idle", name: "Headless alpha" }),
          rpcSession({ sessionId: "rpc-2", status: "working", name: "Headless beta", chatId: "chat-9" }),
        ],
      }));
      await rpcListResponse.promise;
    });
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    installMatchMedia();
    window.localStorage.setItem("th-lang", "en");
    appMocks.checkAuth.mockResolvedValue(true);
    workspaceResponse = deferred<Response>();
    sessionsResponse = deferred<Response>();
    rpcListResponse = deferred<Response>();
    openResponses = [];
    fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = String(input);
      if (path === "/api/workspaces") return workspaceResponse.promise;
      if (path.startsWith("/api/workspaces/ws-1/sessions?")) return sessionsResponse.promise;
      if (path === "/api/rpc-sessions") return rpcListResponse.promise;
      if (path === "/api/workspaces/ws-1/rpc-sessions/open" && init?.method === "POST") {
        const response = openResponses.shift();
        if (response) return response;
      }
      return Promise.reject(new Error(`unexpected request: ${init?.method ?? "GET"} ${path}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.localStorage.clear();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("clicking unbound and bound rows both open through the RPC endpoint and activate the returned chat", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    openResponses.push(first.promise, second.promise);
    await renderLoadedApp();

    const unbound = container.querySelector<HTMLButtonElement>('[aria-label="Headless alpha, Idle"]');
    const bound = container.querySelector<HTMLButtonElement>('[aria-label="Headless beta, Working"]');
    expect(unbound).not.toBeNull();
    expect(bound).not.toBeNull();

    act(() => unbound?.click());
    expect(openCalls()).toHaveLength(1);
    expect(JSON.parse(String(openCalls()[0]![1]?.body))).toEqual({ sessionId: "rpc-1" });
    await act(async () => {
      first.resolve(jsonResponse({ id: "chat-1", name: "Headless alpha", provider: "omo" }, 201));
      await first.promise;
    });
    expect(appMocks.focusPane).toHaveBeenCalledWith("pane-1");
    expect(appMocks.assignSession).toHaveBeenCalledWith("pane-1", "chat-1", false);

    act(() => bound?.click());
    expect(openCalls()).toHaveLength(2);
    expect(JSON.parse(String(openCalls()[1]![1]?.body))).toEqual({ sessionId: "rpc-2" });
    await act(async () => {
      second.resolve(jsonResponse({ id: "chat-9", name: "Headless beta", provider: "omo" }, 200));
      await second.promise;
    });
    expect(appMocks.assignSession).toHaveBeenLastCalledWith("pane-1", "chat-9", false);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/sessions/open"))).toHaveLength(0);
  });
});
