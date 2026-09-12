import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { SessionTree } from "./SessionTree";
import { sessionOpenAttemptKey } from "../features/workspace/useSessionOpenAttempts";
import type { Terminal, Workspace, WorkspaceSession } from "../features/workspace/workspace";

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
    expect(appMocks.focusPane).toHaveBeenCalledWith("pane-1");
    expect(appMocks.assignSession).toHaveBeenCalledWith("pane-1", openedChat.id, false);
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
    // Nothing is running in this fixture, so no pinned target exists: the
    // tree does not offer a dead View live action, and no overview opens.
    expect(container.querySelector(".th-tree-view-live")).toBeNull();
    expect(document.body.querySelector(".th-overview")).toBeNull();
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
    expect(appMocks.focusPane).toHaveBeenCalledWith("pane-1");
    expect(appMocks.assignSession).toHaveBeenCalledWith("pane-1", openedChat.id, false);
    expect(container.querySelector(".th-tree-session-active")).toBeNull();
  });

  it("renders a failed attempt and retries it", async () => {
    const failed = deferred<Response>();
    openResponses.push(failed.promise, deferred<Response>().promise);
    await renderLoadedTree();

    act(() => sourceActivation().click());
    await act(async () => {
      failed.resolve(jsonResponse({ error: "open failed" }, 500));
      await failed.promise;
    });

    expect(container.querySelector(".th-tree-session-active")?.textContent).toContain("Open failed");
    act(() => container.querySelector<HTMLButtonElement>(".th-tree-retry-open")?.click());
    expect(openCalls()).toHaveLength(2);
  });

  it("forwards the session id through onViewLive from the tree's view-live button", () => {
    const treeWorkspace: Workspace = { ...workspace, chats: [] };
    const onViewLive = vi.fn();
    act(() => {
      root.render(
        <SessionTree
          workspaces={[treeWorkspace]}
          activeTerminalId={null}
          placedSessions={new Set<string>()}
          liveSessions={new Set<string>()}
          runningCounts={new Map([[discovered.id, 2]])}
          expanded={new Set(["ws-1"])}
          sessionLists={new Map([["ws-1", [discovered]]])}
          sessionPages={new Map()}
          onToggle={() => undefined}
          onLoadMoreSessions={() => undefined}
          onSelect={() => undefined}
          onOpen={async () => undefined}
          openAttempts={new Map([[sessionOpenAttemptKey("ws-1", discovered.id), "session-active"]])}
          onViewLive={onViewLive}
          onAddTerminal={() => undefined}
          onDeleteWorkspace={() => undefined}
          onDeleteTerminal={() => undefined}
          onRenameWorkspace={async () => undefined}
          onRenameTerminal={async () => undefined}
          notify={() => undefined}
        />,
      );
    });

    const viewLive = container.querySelector<HTMLButtonElement>(".th-tree-view-live");
    expect(viewLive).not.toBeNull();
    act(() => viewLive?.click());
    expect(onViewLive).toHaveBeenCalledTimes(1);
    expect(onViewLive).toHaveBeenCalledWith(discovered.id);
  });

  it("offers View live only for a session-active row whose running count is positive", () => {
    const idleRow: WorkspaceSession = { ...discovered, id: "disk-idle", name: "Idle elsewhere" };
    const busyRow: WorkspaceSession = { ...discovered, id: "disk-busy", name: "Busy elsewhere" };
    const failedRow: WorkspaceSession = { ...discovered, id: "disk-failed", name: "Failed open" };
    const treeWorkspace: Workspace = { ...workspace, chats: [] };
    act(() => {
      root.render(
        <SessionTree
          workspaces={[treeWorkspace]}
          activeTerminalId={null}
          placedSessions={new Set<string>()}
          liveSessions={new Set<string>()}
          runningCounts={new Map([[busyRow.id, 2]])}
          expanded={new Set(["ws-1"])}
          sessionLists={new Map([["ws-1", [idleRow, busyRow, failedRow]]])}
          sessionPages={new Map()}
          onToggle={() => undefined}
          onLoadMoreSessions={() => undefined}
          onSelect={() => undefined}
          onOpen={async () => undefined}
          openAttempts={new Map([
            [sessionOpenAttemptKey("ws-1", idleRow.id), "session-active"],
            [sessionOpenAttemptKey("ws-1", busyRow.id), "session-active"],
            [sessionOpenAttemptKey("ws-1", failedRow.id), "failed"],
          ])}
          onViewLive={() => undefined}
          onAddTerminal={() => undefined}
          onDeleteWorkspace={() => undefined}
          onDeleteTerminal={() => undefined}
          onRenameWorkspace={async () => undefined}
          onRenameTerminal={async () => undefined}
          notify={() => undefined}
        />,
      );
    });

    const rowOf = (name: string): HTMLElement => {
      const activation = Array.from(container.querySelectorAll<HTMLButtonElement>(".th-tree-activation"))
        .find((button) => button.textContent?.includes(name));
      const row = activation?.closest<HTMLElement>(".th-tree-node");
      expect(row).not.toBeNull();
      return row!;
    };

    // Idle session-active row: no pinned target, so no View live; force-open stays.
    const idle = rowOf("Idle elsewhere");
    expect(idle.querySelector(".th-tree-view-live")).toBeNull();
    expect(idle.querySelector(".th-tree-force-open")).not.toBeNull();

    // Running session-active row: View live renders beside force-open.
    const busy = rowOf("Busy elsewhere");
    expect(busy.querySelector(".th-tree-view-live")).not.toBeNull();
    expect(busy.querySelector(".th-tree-force-open")).not.toBeNull();

    // Failed rows keep retry and never offer View live.
    const failed = rowOf("Failed open");
    expect(failed.querySelector(".th-tree-retry-open")).not.toBeNull();
    expect(failed.querySelector(".th-tree-view-live")).toBeNull();
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
