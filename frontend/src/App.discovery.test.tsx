import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { apiJson } from "./lib/api";
import { checkAuth } from "./features/auth/auth";

/** Live-session payload the real shared poller serves for /api/sessions/live. */
const harness = vi.hoisted(() => ({
  live: { sessions: [] as readonly unknown[] },
  catalog: [] as readonly unknown[],
}));

vi.mock("./features/auth/auth", () => ({
  checkAuth: vi.fn(async () => true),
  logout: vi.fn(async () => undefined),
}));
vi.mock("./lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/api")>();
  return {
    ...actual,
    apiJson: vi.fn(async (path: string) => {
      if (path === "/api/sessions/live") return harness.live;
      if (path === "/api/workspaces") return harness.catalog;
      if (path.includes("/sessions")) return { items: [], nextCursor: "" };
      return [];
    }),
    setUnauthorizedHandler: vi.fn(),
  };
});
vi.mock("./lib/chatWs", () => ({ connectChat: vi.fn() }));
vi.mock("./lib/useMediaQuery", () => ({ useMediaQuery: vi.fn(() => false) }));
vi.mock("./features/split/paneTree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./features/split/paneTree")>();
  return { ...actual, findLeaf: vi.fn(() => null) };
});
vi.mock("./features/split/ChatPane", () => ({ ChatPane: () => <div data-testid="chat-pane" /> }));
vi.mock("./components/Sidebar", () => ({
  MOBILE_QUERY: "(max-width: 768px)",
  Sidebar: (props: { readonly liveSessions: ReadonlySet<string>; readonly workspaces: readonly { readonly id: string }[] }) => (
    <aside
      data-testid="sidebar"
      data-live={[...props.liveSessions].sort().join(",")}
      data-ws={props.workspaces.map((workspace) => workspace.id).join(",")}
    />
  ),
}));
vi.mock("./features/workspace/WorkspaceWizard", () => ({ WorkspaceWizard: () => null }));
vi.mock("./components/NewChatDialog", () => ({ NewChatDialog: () => null }));
vi.mock("./features/terminal/terminal", () => ({ createTerminal: vi.fn() }));
vi.mock("./features/workspace/useProviderDiscovery", () => ({
  useProviderDiscovery: () => ({
    discovery: {
      status: "loaded" as const,
      providers: [{ id: "omo" as const, label: "omo", binary: "omo", available: true }],
    },
    retry: vi.fn(),
  }),
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

const ownedWorkspace = {
  id: "ws-1",
  name: "Workspace",
  path: "/work",
  chats: [{ id: "chat-a", name: "A", provider: "omo" as const }],
};
const enrolledWorkspace = {
  id: "ws-enrolled",
  name: "owa1",
  path: "/work/owa1",
  chats: [{ id: "chat-enrolled", name: "Enrolled chat", provider: "omo" as const }],
};

/** One live row as the REST/push transports carry it. */
function liveEntry(id: string, title: string): unknown {
  return { id, title, task: null, dag: null };
}

describe("App live-id discovery trigger", () => {
  let container: HTMLDivElement;
  let root: Root;

  const catalogCalls = (): number =>
    vi.mocked(apiJson).mock.calls.filter(([path]) => path === "/api/workspaces").length;
  const sidebarAttr = (name: string): string =>
    container.querySelector('[data-testid="sidebar"]')?.getAttribute(name) ?? "";

  /** Settles the microtask chain a resolved fake-timer callback started. */
  async function flush(): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    installMatchMedia();
    window.localStorage.clear();
    window.localStorage.setItem("th-lang", "en");
    vi.mocked(checkAuth).mockResolvedValue(true);
    harness.live = { sessions: [] };
    harness.catalog = [ownedWorkspace];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it("fetches the catalog once for a live id no workspace owns and shows the merged workspace", async () => {
    // Given: an authenticated tab whose catalog holds one workspace and whose
    // live feed is empty. Only the boot load has fetched the catalog.
    await act(async () => {
      root.render(<App />);
    });
    await flush();
    expect(sidebarAttr("data-ws")).toBe("ws-1");
    expect(sidebarAttr("data-live")).toBe("");
    expect(catalogCalls()).toBe(1);

    // When: a live frame announces a session id no loaded workspace owns.
    harness.catalog = [ownedWorkspace, enrolledWorkspace];
    harness.live = { sessions: [liveEntry("chat-enrolled", "Enrolled chat")] };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    await flush();

    // Then: the trigger asked for exactly one catalog merge and the new
    // workspace is in App state, while the still-unknown case below is not
    // retried into a poll.
    expect(sidebarAttr("data-live")).toBe("chat-enrolled");
    expect(catalogCalls()).toBe(2);
    expect(sidebarAttr("data-ws")).toBe("ws-1,ws-enrolled");
  });

  it("issues no further fetch for repeated live ticks with the same owned and unknown ids", async () => {
    // Given: a tab that has already discovered its unknown id.
    await act(async () => {
      root.render(<App />);
    });
    await flush();
    harness.catalog = [ownedWorkspace, enrolledWorkspace];
    harness.live = { sessions: [liveEntry("chat-enrolled", "Enrolled chat")] };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    await flush();
    expect(catalogCalls()).toBe(2);

    // When: three more live ticks carry the same id set - an owned row plus an
    // id no catalog fetch can resolve - with changing row content, so every
    // tick publishes a fresh array and a fresh Set.
    harness.live = { sessions: [liveEntry("chat-enrolled", "Enrolled chat"), liveEntry("ghost-1", "Ghost")] };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    await flush();
    expect(catalogCalls()).toBe(3);

    for (const title of ["Ghost 2", "Ghost 3", "Ghost 4"]) {
      harness.live = { sessions: [liveEntry("chat-enrolled", "Enrolled chat"), liveEntry("ghost-1", title)] };
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_000);
      });
      await flush();
    }

    // Then: membership churn never refetches the catalog - the trigger is the
    // derived id set, and an already-requested id is not requested again.
    expect(catalogCalls()).toBe(3);
  });

  it("fetches the catalog on visibility regain and shows a chat created through REST elsewhere", async () => {
    // Given: a settled tab with no live session at all - a chat created
    // through REST elsewhere and never run emits no frame.
    await act(async () => {
      root.render(<App />);
    });
    await flush();
    expect(catalogCalls()).toBe(1);

    // When: the tab regains visibility with that chat now in the catalog.
    harness.catalog = [ownedWorkspace, enrolledWorkspace];
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flush();

    // Then: one merge ran and the workspace is visible.
    expect(catalogCalls()).toBe(2);
    expect(sidebarAttr("data-ws")).toBe("ws-1,ws-enrolled");
  });
});
