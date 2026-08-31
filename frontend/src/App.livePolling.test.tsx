import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { App } from "./App";
import type { Workspace } from "./features/workspace/workspace";
import { checkAuth } from "./features/auth/auth";
import { apiJson } from "./lib/api";
import type { RequestOptions } from "./lib/api";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type LiveCall = {
  promise: Promise<{ readonly sessions: readonly string[] }>;
  resolve: (value: { readonly sessions: readonly string[] }) => void;
  reject: (reason?: unknown) => void;
  readonly signal?: AbortSignal | undefined;
};
const liveCalls: LiveCall[] = [];
const sidebarRenders = vi.hoisted(() => ({ count: 0 }));

function liveCall(index: number): LiveCall {
  const call = liveCalls[index];
  if (!call) throw new Error(`missing live call ${index}`);
  return call;
}

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

vi.mock("./features/auth/auth", () => ({ checkAuth: vi.fn(), logout: vi.fn() }));
vi.mock("./lib/api", () => ({ apiJson: vi.fn(), setUnauthorizedHandler: vi.fn() }));
vi.mock("./lib/chatWs", () => ({ connectChat: vi.fn() }));
vi.mock("./features/split/useLayout", () => ({
  useLayout: () => ({
    root: { kind: "leaf", sessionId: null },
    focusedPaneId: "pane-1",
    placed: new Set<string>(),
    focusSession: vi.fn(() => false),
    assignSession: vi.fn(),
    focusPane: vi.fn(),
    split: vi.fn(),
    closePane: vi.fn(),
    changeRatio: vi.fn(),
    hasPane: vi.fn(() => false),
  }),
}));
vi.mock("./features/split/paneTree", () => ({ findLeaf: vi.fn(() => null) }));
vi.mock("./features/split/SplitView", () => ({ SplitView: () => <div data-testid="split-view" /> }));
vi.mock("./features/split/ChatPane", () => ({ ChatPane: () => <div data-testid="chat-pane" /> }));
vi.mock("./components/Sidebar", () => ({
  MOBILE_QUERY: "(max-width: 768px)",
  Sidebar: (props: { readonly liveSessions: ReadonlySet<string> }) => {
    sidebarRenders.count += 1;
    return (
      <div
        data-testid="sidebar"
        data-live={Array.from(props.liveSessions).slice().sort().join(",")}
      />
    );
  },
}));
vi.mock("./features/workspace/WorkspaceWizard", () => ({ WorkspaceWizard: () => null }));
vi.mock("./components/NewChatDialog", () => ({ NewChatDialog: () => null }));
vi.mock("./features/workspace/useWorkspaces", () => ({
  useWorkspaces: () => ({
    workspaces: [] as readonly Workspace[],
    setWorkspaces: () => undefined,
    expanded: new Set<string>(),
    setExpanded: () => undefined,
    sessions: new Map<string, unknown>(),
    load: () => undefined,
    toggleExpanded: () => undefined,
    handleDeleteWorkspace: async () => undefined,
    handleDeleteTerminal: async () => undefined,
    handleRenameWorkspace: async () => undefined,
    handleRenameTerminal: async () => undefined,
  }),
}));
vi.mock("./features/terminal/terminal", () => ({ createTerminal: vi.fn() }));
vi.mock("./lib/useMediaQuery", () => ({ useMediaQuery: vi.fn(() => false) }));

describe("App live-session polling", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    liveCalls.length = 0;
    sidebarRenders.count = 0;
    installMatchMedia();
    window.localStorage.setItem("th-lang", "en");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.mocked(checkAuth).mockResolvedValue(true);
    vi.mocked(apiJson).mockImplementation(async (path: string, options?: RequestOptions) => {
      if (path === "/api/sessions/live") {
        const base = deferred<{ readonly sessions: readonly string[] }>();
        const call: LiveCall = { ...base, signal: options?.signal };
        // Mirror real fetch: aborting the signal rejects the in-flight request.
        options?.signal?.addEventListener("abort", () => call.reject(new Error("aborted")));
        liveCalls.push(call);
        return call.promise;
      }
      return [];
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  const liveValue = (): string =>
    container.querySelector('[data-testid="sidebar"]')?.getAttribute("data-live") ?? "";

  async function renderApp(): Promise<void> {
    await act(async () => {
      root.render(<App />);
    });
    for (let i = 0; i < 4 && liveCalls.length === 0; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  it("keeps the last known-good set when a poll fails", async () => {
    await renderApp();
    expect(liveCalls.length).toBeGreaterThanOrEqual(1);
    await act(async () => {
      liveCall(0).resolve({ sessions: ["chat-a"] });
      await Promise.resolve();
    });
    expect(liveValue()).toBe("chat-a");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(liveCalls.length).toBe(2);
    await act(async () => {
      liveCall(1).reject(new Error("network"));
      await Promise.resolve();
    });
    expect(liveValue()).toBe("chat-a");
  });

  it("applies a delayed response without piling up overlapping requests", async () => {
    await renderApp();
    await act(async () => {
      liveCall(0).resolve({ sessions: ["chat-a"] });
      await Promise.resolve();
    });
    expect(liveValue()).toBe("chat-a");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(liveCalls.length).toBe(2);

    // While call #2 is pending, advance well past the cadence: chained scheduling
    // must NOT start overlapping requests.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12000);
    });
    expect(liveCalls.length).toBe(2);

    await act(async () => {
      liveCall(1).resolve({ sessions: ["chat-b"] });
      await Promise.resolve();
    });
    expect(liveValue()).toBe("chat-b");
  });

  it("aborts a stalled request before starting its successor (no overlap)", async () => {
    await renderApp();
    expect(liveCalls.length).toBe(1);

    // The 30s stall guard fires: it aborts the hung request and queues one successor.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(liveCall(0).signal?.aborted).toBe(true);
    expect(liveCalls.length).toBe(1); // successor not started until the cadence elapses

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(liveCalls.length).toBe(2);

    // The successor applies normally; the aborted request cannot update state.
    await act(async () => {
      liveCall(1).resolve({ sessions: ["chat-c"] });
      await Promise.resolve();
    });
    expect(liveValue()).toBe("chat-c");
  });

  it("aborts the in-flight request on unmount", async () => {
    await renderApp();
    expect(liveCalls.length).toBe(1);
    expect(liveCall(0).signal?.aborted).toBe(false);
    act(() => root.unmount());
    expect(liveCall(0).signal?.aborted).toBe(true);
  });

  it("does not rerender when a poll returns the same set", async () => {
    await renderApp();
    await act(async () => {
      liveCall(0).resolve({ sessions: ["chat-a"] });
      await Promise.resolve();
    });
    expect(liveValue()).toBe("chat-a");
    const rendersAfterFirst = sidebarRenders.count;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    await act(async () => {
      liveCall(1).resolve({ sessions: ["chat-a"] });
      await Promise.resolve();
    });
    expect(liveValue()).toBe("chat-a");
    expect(sidebarRenders.count).toBe(rendersAfterFirst);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    await act(async () => {
      liveCall(2).resolve({ sessions: ["chat-b"] });
      await Promise.resolve();
    });
    expect(liveValue()).toBe("chat-b");
    expect(sidebarRenders.count).toBeGreaterThan(rendersAfterFirst);
  });
});
