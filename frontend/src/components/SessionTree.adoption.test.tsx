import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import type { Terminal, WorkspaceSession } from "../features/workspace/workspace";

const appMocks = vi.hoisted(() => ({
  assignSession: vi.fn(),
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
    focusPane: vi.fn(),
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
const discovered: WorkspaceSession = {
  id: "disk-session-key",
  name: "Disk session",
  source: "discovered",
  recencyMs: 1,
  resumeIdentity: "/sessions/disk-session.jsonl",
};
const openedChat: Terminal = { id: "chat-opened", name: "Disk session", provider: "omo" };

function installMatchMedia(): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
  }));
}

describe("discovered-session in-place open wiring", () => {
  let container: HTMLDivElement;
  let root: Root;
  let workspaceResponse: Deferred<Response>;
  let sessionsResponse: Deferred<Response>;
  let openResponses: Promise<Response>[];
  let fetchMock: ReturnType<typeof vi.fn>;

  const openCalls = (): readonly (readonly [RequestInfo | URL, RequestInit | undefined])[] =>
    fetchMock.mock.calls
      .filter(([input, init]) => String(input).endsWith("/sessions/open") && init?.method === "POST")
      .map(([input, init]) => [input as RequestInfo | URL, init as RequestInit | undefined] as const);

  const sourceActivation = (): HTMLButtonElement => {
    const activation = Array.from(container.querySelectorAll<HTMLButtonElement>(".th-tree-activation"))
      .find((button) => button.textContent?.includes(discovered.name));
    expect(activation).toBeDefined();
    return activation!;
  };

  async function renderLoadedTree(items: readonly WorkspaceSession[] = [discovered]): Promise<void> {
    await act(async () => { root.render(<App />); });
    await act(async () => {
      workspaceResponse.resolve(jsonResponse([workspace]));
      await workspaceResponse.promise;
    });
    const expand = container.querySelector<HTMLButtonElement>(".th-tree-chevron[aria-expanded]");
    expect(expand).not.toBeNull();
    act(() => expand?.click());
    await act(async () => {
      sessionsResponse.resolve(jsonResponse({ items, nextCursor: "" }));
      await sessionsResponse.promise;
    });
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    installMatchMedia();
    window.localStorage.setItem("th-lang", "en");
    appMocks.checkAuth.mockResolvedValue(true);
    workspaceResponse = deferred<Response>();
    sessionsResponse = deferred<Response>();
    openResponses = [];
    fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = String(input);
      if (path === "/api/workspaces") return workspaceResponse.promise;
      if (path.startsWith("/api/workspaces/ws-1/sessions?")) return sessionsResponse.promise;
      if (path === "/api/workspaces/ws-1/sessions/open" && init?.method === "POST") {
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

  it("opens a discovered row in place and activates the returned chat", async () => {
    const response = deferred<Response>();
    openResponses.push(response.promise);
    await renderLoadedTree();

    act(() => sourceActivation().click());

    expect(openCalls()).toHaveLength(1);
    const [path, init] = openCalls()[0]!;
    expect(path).toBe("/api/workspaces/ws-1/sessions/open");
    expect(JSON.parse(String(init?.body))).toEqual({
      id: discovered.id,
      resumeIdentity: discovered.resumeIdentity,
    });

    await act(async () => {
      response.resolve(jsonResponse(openedChat, 201));
      await response.promise;
    });
    expect(appMocks.assignSession).toHaveBeenCalledWith("pane-1", openedChat.id);
    expect(container.textContent).not.toContain("Adopted");
  });

  it("shows session-active state and force-opens with force=true", async () => {
    const blocked = deferred<Response>();
    const forced = deferred<Response>();
    openResponses.push(blocked.promise, forced.promise);
    await renderLoadedTree();

    act(() => sourceActivation().click());
    await act(async () => {
      blocked.resolve(jsonResponse({ state: "session-active", sizeDelta: 4, mtimeDeltaNano: 9 }, 409));
      await blocked.promise;
    });

    expect(container.querySelector(".th-tree-session-active")?.textContent).toContain("In use elsewhere");
    const forceButton = container.querySelector<HTMLButtonElement>(".th-tree-force-open");
    expect(forceButton?.textContent).toBe("Open anyway");
    act(() => forceButton?.click());

    expect(openCalls()).toHaveLength(2);
    expect(JSON.parse(String(openCalls()[1]![1]?.body))).toEqual({
      id: discovered.id,
      resumeIdentity: discovered.resumeIdentity,
      force: true,
    });
    await act(async () => {
      forced.resolve(jsonResponse(openedChat, 201));
      await forced.promise;
    });
    expect(appMocks.assignSession).toHaveBeenCalledWith("pane-1", openedChat.id);
    expect(container.querySelector(".th-tree-session-active")).toBeNull();
  });

  it("issues only one request while an open is pending", async () => {
    openResponses.push(deferred<Response>().promise);
    await renderLoadedTree();
    const activation = sourceActivation();
    act(() => { activation.click(); activation.click(); });
    expect(openCalls()).toHaveLength(1);
    expect(activation.disabled).toBe(true);
    expect(activation.getAttribute("aria-busy")).toBe("true");
    expect(activation.textContent).toContain("Opening");
  });
});
