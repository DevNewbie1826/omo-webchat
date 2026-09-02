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
    discovery: {
      status: "loaded" as const,
      providers: [{ id: "omo" as const, label: "omo", binary: "omo", available: true }],
    },
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
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const workspace = {
  id: "ws-1",
  name: "Workspace",
  path: "/work",
  chats: [],
};

const discovered: WorkspaceSession = {
  id: "disk-session-key",
  name: "Disk session",
  source: "discovered",
  recencyMs: 1,
  resumeIdentity: "/sessions/disk-session.jsonl",
};

const adoptedChat: Terminal = {
  id: "chat-adopted",
  name: "Disk session",
  provider: "omo",
};

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

describe("discovered-session adoption wiring", () => {
  let container: HTMLDivElement;
  let root: Root;
  let workspaceResponse: Deferred<Response>;
  let sessionsResponse: Deferred<Response>;
  let adoptionResponses: Promise<Response>[];
  let fetchMock: ReturnType<typeof vi.fn>;

  const adoptionCalls = (): readonly (readonly [RequestInfo | URL, RequestInit | undefined])[] =>
    fetchMock.mock.calls
      .filter(([input, init]) => String(input).endsWith("/sessions/adopt") && init?.method === "POST")
      .map(([input, init]) => [input as RequestInfo | URL, init as RequestInit | undefined] as const);

  const sourceRow = (): HTMLElement => {
    const row = Array.from(container.querySelectorAll<HTMLElement>(".th-tree-children > .th-tree-node"))
      .find((item) => item.textContent?.includes(discovered.name) && item.querySelector(".th-tree-source") !== null);
    expect(row).toBeDefined();
    return row!;
  };

  const sourceActivation = (): HTMLButtonElement => {
    const activation = sourceRow().querySelector<HTMLButtonElement>(".th-tree-activation");
    expect(activation).not.toBeNull();
    return activation!;
  };

  async function renderLoadedTree(items: readonly WorkspaceSession[] = [discovered]): Promise<void> {
    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {
      workspaceResponse.resolve(jsonResponse([workspace]));
      await workspaceResponse.promise;
    });

    const workspaceExpand = container.querySelector<HTMLButtonElement>(
      ".th-tree-workspace > .th-tree-node > .th-tree-chevron[aria-expanded]",
    );
    expect(workspaceExpand).not.toBeNull();
    act(() => workspaceExpand?.click());
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
    adoptionResponses = [];
    fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = String(input);
      if (path === "/api/workspaces") return workspaceResponse.promise;
      if (path.startsWith("/api/workspaces/ws-1/sessions?")) return sessionsResponse.promise;
      if (path === "/api/workspaces/ws-1/sessions/adopt" && init?.method === "POST") {
        const response = adoptionResponses.shift();
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

  it("adopts a discovered row and opens the returned chat", async () => {
    const adoptionResponse = deferred<Response>();
    adoptionResponses.push(adoptionResponse.promise);
    await renderLoadedTree();

    act(() => sourceActivation().click());

    expect(adoptionCalls()).toHaveLength(1);
    const [path, init] = adoptionCalls()[0]!;
    expect(path).toBe("/api/workspaces/ws-1/sessions/adopt");
    expect(JSON.parse(String(init?.body))).toEqual({
      id: discovered.id,
      name: discovered.name,
      resumeIdentity: discovered.resumeIdentity,
    });

    await act(async () => {
      adoptionResponse.resolve(jsonResponse(adoptedChat, 201));
      await adoptionResponse.promise;
    });
    expect(appMocks.assignSession).toHaveBeenCalledWith("pane-1", adoptedChat.id);
  });

  it("keeps the source row and renders its adopted state after success", async () => {
    const adoptionResponse = deferred<Response>();
    adoptionResponses.push(adoptionResponse.promise);
    await renderLoadedTree();

    act(() => sourceActivation().click());
    await act(async () => {
      adoptionResponse.resolve(jsonResponse(adoptedChat, 201));
      await adoptionResponse.promise;
    });

    const matchingRows = Array.from(container.querySelectorAll<HTMLElement>(".th-tree-children > .th-tree-node"))
      .filter((item) => item.textContent?.includes(adoptedChat.name));
    expect(matchingRows).toHaveLength(2);
    const storedRow = matchingRows.find((row) => row.querySelector(".th-tree-source") === null);
    const adoptedSourceRow = matchingRows.find((row) => row.querySelector(".th-tree-source") !== null);
    expect(storedRow?.querySelectorAll(".th-tree-actions button")).toHaveLength(2);
    expect(adoptedSourceRow?.querySelector(".th-tree-source")?.textContent).toBe("Adopted");
    expect(adoptedSourceRow?.querySelector<HTMLButtonElement>(".th-tree-activation")?.disabled).toBe(true);
  });

  it("shows progress and issues exactly one request while adoption is pending", async () => {
    adoptionResponses.push(deferred<Response>().promise);
    await renderLoadedTree();
    const activation = sourceActivation();

    act(() => {
      activation.click();
      activation.click();
    });

    expect(adoptionCalls()).toHaveLength(1);
    expect(activation.disabled).toBe(true);
    expect(activation.getAttribute("aria-busy")).toBe("true");
    expect(activation.textContent).toContain("Adopting");
  });

  it("surfaces an adoption failure notice and allows retry", async () => {
    const failedResponse = deferred<Response>();
    adoptionResponses.push(failedResponse.promise, deferred<Response>().promise);
    await renderLoadedTree();

    act(() => sourceActivation().click());
    await act(async () => {
      failedResponse.resolve(jsonResponse({ error: "adoption failed" }, 500));
      await failedResponse.promise;
    });

    expect(container.querySelector(".th-toast--error")?.textContent).toBe("Something went wrong");
    expect(adoptionCalls()).toHaveLength(1);
    expect(sourceActivation().disabled).toBe(false);

    act(() => sourceActivation().click());
    expect(adoptionCalls()).toHaveLength(2);
  });

  it("posts the raw empty name when an unnamed discovered session is adopted", async () => {
    const unnamed: WorkspaceSession = {
      id: "disk-empty-session",
      name: "",
      source: "discovered",
      recencyMs: 1,
      resumeIdentity: "/sessions/disk-empty.jsonl",
    };
    adoptionResponses.push(deferred<Response>().promise);
    await renderLoadedTree([unnamed]);

    const activation = container.querySelector<HTMLButtonElement>(
      ".th-tree-children > .th-tree-node .th-tree-activation",
    );
    expect(activation).not.toBeNull();
    act(() => activation?.click());

    const [path, init] = adoptionCalls()[0]!;
    expect(path).toBe("/api/workspaces/ws-1/sessions/adopt");
    expect(JSON.parse(String(init?.body))).toEqual({
      id: unnamed.id,
      name: "",
      resumeIdentity: unnamed.resumeIdentity,
    });
  });
});
