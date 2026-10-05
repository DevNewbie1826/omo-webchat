import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import type { WorkspaceSession } from "../features/workspace/workspace";

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

const workspace = { id: "ws-1", name: "Workspace", path: "/work", chats: [] };
const NOW = new Date("2026-10-05T12:00:00.000Z").getTime();

const liveAlpha = {
  sessionId: "sess-a",
  durableSessionId: "durable-1",
  sessionPath: "/s/a.jsonl",
  cwd: "/work",
  name: "Alpha",
  status: "working",
  questions: [],
  updatedAt: NOW - 5 * 60_000,
  messageCount: 12,
};
const liveAlphaConflict = {
  ...liveAlpha,
  sessionId: "sess-a2",
  durableSessionId: "durable-2",
  name: "Alpha replacement",
  status: "idle",
};
const liveBeta = {
  sessionId: "sess-b",
  durableSessionId: "disk-b",
  sessionPath: "/s/b.jsonl",
  cwd: "/work",
  name: "Beta live",
  status: "idle",
  questions: [],
  updatedAt: NOW - 60_000,
  messageCount: 0,
};
const liveGamma = {
  sessionId: "sess-g",
  durableSessionId: "",
  sessionPath: "/s/g.jsonl",
  cwd: "/work",
  name: "Gamma",
  status: "idle",
  questions: [],
  updatedAt: NOW - 2 * 60_000,
  messageCount: 0,
};
const liveBlocked = {
  sessionId: "sess-q",
  durableSessionId: "durable-q",
  sessionPath: "/s/q.jsonl",
  cwd: "/work",
  name: "",
  status: "blocked",
  questions: ["pick a target", "confirm?"],
  updatedAt: NOW - 90_000,
  messageCount: 3,
};

function installMatchMedia(): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
  }));
}

describe("SessionTree rpc live rows", () => {
  let container: HTMLDivElement;
  let root: Root;
  let workspacesDeferred: Deferred<Response>;
  let sessionsQueue: Array<() => Promise<Response>>;
  let openQueue: Array<() => Promise<Response>>;
  let sessionsCalls: number;
  let fetchMock: ReturnType<typeof vi.fn>;

  const openCalls = (): readonly (readonly [RequestInfo | URL, RequestInit | undefined])[] =>
    fetchMock.mock.calls
      .filter(([input, init]) => String(input) === "/api/workspaces/ws-1/rpc-sessions/open" && init?.method === "POST")
      .map(([input, init]) => [input as RequestInfo | URL, init as RequestInit | undefined] as const);

  const pushSessions = (): Deferred<Response> => {
    const d = deferred<Response>();
    sessionsQueue.push(() => d.promise);
    return d;
  };

  const pushOpen = (): Deferred<Response> => {
    const d = deferred<Response>();
    openQueue.push(() => d.promise);
    return d;
  };

  const workspaceToggle = (): HTMLButtonElement => {
    const toggle = container.querySelector<HTMLButtonElement>(".th-tree-chevron[aria-expanded]");
    expect(toggle).not.toBeNull();
    return toggle!;
  };

  const toggleWorkspace = (): void => {
    act(() => workspaceToggle().click());
  };

  const rpcRow = (sessionId: string): HTMLElement | null =>
    container.querySelector<HTMLElement>(`[data-th-rpc-session="${sessionId}"]`);

  const activationsContaining = (text: string): HTMLElement[] =>
    Array.from(container.querySelectorAll<HTMLElement>(".th-tree-activation"))
      .filter((el) => el.textContent?.includes(text));

  /** Renders the app, loads the workspace list, expands ws-1 and resolves the
   * first sessions fetch (history page + always-complete live section). */
  async function renderExpanded(
    body: unknown,
  ): Promise<void> {
    const first = pushSessions();
    await act(async () => { root.render(<App />); });
    await act(async () => {
      workspacesDeferred.resolve(jsonResponse([workspace]));
      await workspacesDeferred.promise;
    });
    toggleWorkspace();
    await act(async () => {
      first.resolve(jsonResponse(body));
      await first.promise;
    });
  }

  /** Refetches the live section through an expand/re-expand cycle. */
  async function refetchViaToggle(body: unknown): Promise<void> {
    const d = pushSessions();
    toggleWorkspace();
    toggleWorkspace();
    await act(async () => {
      d.resolve(jsonResponse(body));
      await d.promise;
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    installMatchMedia();
    window.localStorage.setItem("th-lang", "en");
    appMocks.checkAuth.mockResolvedValue(true);
    workspacesDeferred = deferred<Response>();
    sessionsQueue = [];
    openQueue = [];
    sessionsCalls = 0;
    fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = String(input);
      if (path === "/api/workspaces") return workspacesDeferred.promise;
      if (path.startsWith("/api/workspaces/ws-1/sessions?")) {
        sessionsCalls += 1;
        const next = sessionsQueue.shift();
        if (next) return next();
        return Promise.reject(new Error(`unexpected sessions fetch #${sessionsCalls}: ${path}`));
      }
      if (path === "/api/workspaces/ws-1/rpc-sessions/open" && init?.method === "POST") {
        const next = openQueue.shift();
        if (next) return next();
        return Promise.reject(new Error("unexpected rpc open request"));
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
    vi.useRealTimers();
  });

  it("pins live rows above the paged history without load-more", async () => {
    const history: WorkspaceSession[] = Array.from({ length: 5 }, (_, i) => ({
      id: `chat-${i}`,
      name: `Chat ${i}`,
      source: "stored",
      recencyMs: i + 1,
    }));
    await renderExpanded({ items: history, nextCursor: "next-page", live: [liveAlpha] });

    const liveRow = rpcRow("sess-a");
    expect(liveRow).not.toBeNull();
    expect(liveRow!.querySelector(".th-tree-running")).not.toBeNull();
    expect(liveRow!.querySelector(".th-tree-live-recency")?.textContent).toBe("5m ago");
    expect(liveRow!.textContent).toContain("Alpha");
    // History stays paged: the more button is offered and was not clicked.
    expect(container.querySelector(".th-tree-more")).not.toBeNull();
    expect(activationsContaining("Chat 4")).toHaveLength(1);
    // The pinned live row renders before every history row.
    const firstHistoryRow = activationsContaining("Chat 0")[0]!.closest(".th-tree-node");
    expect(Boolean(liveRow!.compareDocumentPosition(firstHistoryRow!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });

  it("shows the question-waiting pill with the joined questions in ko locale", async () => {
    window.localStorage.setItem("th-lang", "ko");
    await renderExpanded({ items: [], nextCursor: "", live: [liveBlocked] });

    const row = rpcRow("sess-q");
    expect(row).not.toBeNull();
    const pill = row!.querySelector(".th-tree-questions");
    expect(pill?.textContent).toBe("질문 대기");
    expect(pill?.getAttribute("title")).toBe("pick a target\nconfirm?");
    // Name fallback: the short session id labels the row.
    expect(row!.textContent).toContain("sess-q");
  });

  it("renders and refreshes every first-page bound status without manager ownership", async () => {
    window.localStorage.setItem("th-lang", "ko");
    const items = [
      { id: "chat-a", name: "Bound Alpha", source: "stored", recencyMs: 2,
        live: { status: "working", questions: [] } },
      { id: "chat-b", name: "Bound Beta", source: "stored", recencyMs: 1,
        live: { status: "blocked", questions: ["choose target", "confirm"] } },
    ];
    await renderExpanded({ items, nextCursor: "page-two", live: [liveGamma] });
    const boundRow = (name: string): HTMLElement =>
      activationsContaining(name)[0]!.closest<HTMLElement>(".th-tree-node")!;
    expect(boundRow("Bound Alpha").querySelector(".th-tree-running")).not.toBeNull();
    expect(boundRow("Bound Beta").querySelector(".th-tree-questions")?.textContent).toBe("질문 대기");
    expect(boundRow("Bound Beta").querySelector(".th-tree-questions")?.getAttribute("title"))
      .toBe("choose target\nconfirm");
    expect(rpcRow("sess-g")).not.toBeNull();

    const tick = pushSessions();
    const tickPageTwo = pushSessions();
    act(() => { vi.advanceTimersByTime(15_000); });
    await act(async () => {
      tick.resolve(jsonResponse({ items: [
        { ...items[0], live: { status: "blocked", questions: ["new question"] } },
        { ...items[1], live: { status: "working", questions: [] } },
      ], nextCursor: "page-two", live: [] }));
      tickPageTwo.resolve(jsonResponse({ items: [], nextCursor: "", live: [] }));
      await tick.promise;
    });
    expect(boundRow("Bound Alpha").querySelector(".th-tree-running")).toBeNull();
    expect(boundRow("Bound Alpha").querySelector(".th-tree-questions")?.getAttribute("title"))
      .toBe("new question");
    expect(boundRow("Bound Beta").querySelector(".th-tree-questions")).toBeNull();
    expect(boundRow("Bound Beta").querySelector(".th-tree-running")).not.toBeNull();
    expect(rpcRow("sess-g")).toBeNull();
    const request = fetchMock.mock.calls.filter(([input]) => String(input).includes("/sessions?")).at(-1);
    expect(String(request![0])).toBe("/api/workspaces/ws-1/sessions?limit=5&cursor=page-two");

    const settled = pushSessions();
    const settledPageTwo = pushSessions();
    act(() => { vi.advanceTimersByTime(15_000); });
    await act(async () => {
      settled.resolve(jsonResponse({ items: items.map(({ live: _live, ...item }) => item),
        nextCursor: "page-two", live: [] }));
      settledPageTwo.resolve(jsonResponse({ items: [], nextCursor: "", live: [] }));
      await settled.promise;
    });
    expect(boundRow("Bound Alpha").querySelector(".th-tree-questions")).toBeNull();
    expect(boundRow("Bound Beta").querySelector(".th-tree-running")).toBeNull();
  });

  it("keeps a same-path discovered replacement with a different durable id visible", async () => {
    await renderExpanded({ items: [{
      id: "replacement-b", name: "Beta replacement", source: "discovered",
      recencyMs: 1, resumeIdentity: liveBeta.sessionPath,
    }], nextCursor: "", live: [liveBeta] });
    expect(activationsContaining("Beta")).toHaveLength(2);
  });

  it("suppresses a compatible discovered row after lexical path cleanup", async () => {
    await renderExpanded({ items: [{
      id: liveBeta.durableSessionId, name: "Beta file", source: "discovered",
      recencyMs: 1, resumeIdentity: "/s/nested/../b.jsonl",
    }], nextCursor: "", live: [liveBeta] });
    expect(activationsContaining("Beta")).toHaveLength(1);
  });

  it("suppresses a realpath-normalized /tmp alias while keeping a different durable id visible", async () => {
    await renderExpanded({ items: [{
      id: liveBeta.durableSessionId, name: "Beta file", source: "discovered",
      recencyMs: 2, resumeIdentity: "/private/tmp/b.jsonl",
    }, {
      id: "replacement-b", name: "Beta replacement", source: "discovered",
      recencyMs: 1, resumeIdentity: "/private/tmp/b.jsonl",
    }], nextCursor: "", live: [{
      ...liveBeta, sessionPath: "/tmp/b.jsonl", comparisonPath: "/private/tmp/b.jsonl",
    }] });
    expect(activationsContaining("Beta file")).toHaveLength(0);
    expect(activationsContaining("Beta live")).toHaveLength(1);
    expect(activationsContaining("Beta replacement")).toHaveLength(1);
  });

  it("opens a live row in place, then folds it into the chat row on refresh", async () => {
    await renderExpanded({ items: [], nextCursor: "", live: [liveAlpha] });

    const open = pushOpen();
    act(() => rpcRow("sess-a")!.querySelector<HTMLButtonElement>(".th-tree-activation")!.click());
    expect(openCalls()).toHaveLength(1);
    expect(JSON.parse(String(openCalls()[0]![1]?.body))).toEqual({ sessionId: "sess-a" });

    await act(async () => {
      open.resolve(jsonResponse({ id: "chat-a", name: "Alpha", provider: "omo" }, 201));
      await open.promise;
    });
    // The same select flow the discovered-row open uses.
    expect(appMocks.focusPane).toHaveBeenCalledWith("pane-1");
    expect(appMocks.assignSession).toHaveBeenCalledWith("pane-1", "chat-a", false);

    // Server lag: the next refresh still lists the session. The live row
    // must fold into the bound chat row — exactly one row, carrying the
    // watcher working chip even though the manager owns no route here.
    await refetchViaToggle({ items: [], nextCursor: "", live: [liveAlpha] });
    expect(rpcRow("sess-a")).toBeNull();
    const chatRows = activationsContaining("Alpha");
    expect(chatRows).toHaveLength(1);
    expect(chatRows[0]!.closest(".th-tree-node")!.querySelector(".th-tree-running")).not.toBeNull();
  });

  it("renders a conflicting durable id beside the bound chat row", async () => {
    await renderExpanded({ items: [], nextCursor: "", live: [liveAlpha] });
    const open = pushOpen();
    act(() => rpcRow("sess-a")!.querySelector<HTMLButtonElement>(".th-tree-activation")!.click());
    await act(async () => {
      open.resolve(jsonResponse({ id: "chat-a", name: "Alpha", provider: "omo" }, 201));
      await open.promise;
    });

    await refetchViaToggle({ items: [], nextCursor: "", live: [liveAlphaConflict] });
    expect(rpcRow("sess-a2")).not.toBeNull();
    expect(activationsContaining("Alpha")).toHaveLength(2);
  });

  it("suppresses the discovered history row when an unbound live row shares its path", async () => {
    const discovered: WorkspaceSession = {
      id: "disk-b",
      name: "Beta file",
      source: "discovered",
      recencyMs: 1,
      resumeIdentity: "/s/b.jsonl",
    };
    await renderExpanded({ items: [discovered], nextCursor: "", live: [liveBeta] });

    const rows = activationsContaining("Beta");
    expect(rows).toHaveLength(1);
    const row = rpcRow("sess-b");
    expect(row).not.toBeNull();
    expect(rows[0]).toBe(row!.querySelector(".th-tree-activation"));
  });

  it("removes a vanished unbound live row from the cumulative state", async () => {
    await renderExpanded({ items: [], nextCursor: "", live: [liveGamma] });
    expect(rpcRow("sess-g")).not.toBeNull();

    await refetchViaToggle({ items: [], nextCursor: "", live: [] });
    expect(rpcRow("sess-g")).toBeNull();
    expect(activationsContaining("Gamma")).toHaveLength(0);
  });

  it("refreshes the live section on re-expand and on the 15s cadence without manager ownership", async () => {
    await renderExpanded({ items: [], nextCursor: "", live: [] });
    expect(sessionsCalls).toBe(1);

    await refetchViaToggle({ items: [], nextCursor: "", live: [liveGamma] });
    expect(sessionsCalls).toBe(2);
    expect(rpcRow("sess-g")).not.toBeNull();

    const tick = pushSessions();
    act(() => { vi.advanceTimersByTime(15_000); });
    expect(sessionsCalls).toBe(3);
    await act(async () => {
      tick.resolve(jsonResponse({ items: [], nextCursor: "", live: [] }));
      await tick.promise;
    });
    expect(rpcRow("sess-g")).toBeNull();
  });

  it("drops malformed live items", async () => {
    await renderExpanded({ items: [], nextCursor: "", live: [{ sessionId: "" }, { bogus: true }, liveGamma] });
    expect(rpcRow("sess-g")).not.toBeNull();
    expect(container.querySelectorAll("[data-th-rpc-session]")).toHaveLength(1);
  });

  it("shows the failed state and retries the open", async () => {
    await renderExpanded({ items: [], nextCursor: "", live: [liveAlpha] });

    const failed = pushOpen();
    const activation = rpcRow("sess-a")!.querySelector<HTMLButtonElement>(".th-tree-activation")!;
    act(() => activation.click());
    expect(activation.disabled).toBe(true);
    expect(activation.textContent).toContain("Opening");
    await act(async () => {
      failed.resolve(jsonResponse({ error: "open failed" }, 500));
      await failed.promise;
    });
    expect(rpcRow("sess-a")!.textContent).toContain("Open failed");

    const retry = pushOpen();
    act(() => rpcRow("sess-a")!.querySelector<HTMLButtonElement>(".th-tree-activation")!.click());
    expect(openCalls()).toHaveLength(2);
    await act(async () => {
      retry.resolve(jsonResponse({ id: "chat-a", name: "Alpha", provider: "omo" }, 201));
      await retry.promise;
    });
    expect(appMocks.assignSession).toHaveBeenCalledWith("pane-1", "chat-a", false);
  });
});
