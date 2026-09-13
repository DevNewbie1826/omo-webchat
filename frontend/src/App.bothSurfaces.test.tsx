import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { apiJson } from "./lib/api";

/**
 * Both-surfaces integration: the REAL Sidebar and the REAL home live-session
 * block mount together on the REAL useWorkspaces hook. A live session absent
 * from the loaded picker rows gains its last-activity timestamp only through
 * the sidebar's membership crawl; both surfaces must still order identically
 * (working first, then most recent), before and after the session settles to
 * idle. Only the transport and pane layout are mocked.
 */

const workspace = {
  id: "ws-1",
  name: "Workspace",
  path: "/work",
  chats: [{ id: "chat-a", name: "A visible", provider: "omo" as const }],
};

const workspaceTwo = {
  id: "ws-2",
  name: "Workspace Two",
  path: "/work-two",
  chats: [{ id: "chat-b", name: "B visible", provider: "omo" as const }],
};

/** First catalog page: only the already-loaded picker row. */
const PAGE_ONE = {
  items: [{ id: "chat-a", name: "A visible", source: "stored", recencyMs: 10 }],
  nextCursor: "p2",
};
/** Continuation page the membership crawl pages to: the hidden live session
 * with a much newer timestamp than every loaded row. */
const PAGE_TWO = {
  items: [{ id: "z-hidden", name: "Z hidden", source: "stored", recencyMs: 5000 }],
  nextCursor: "",
};

function liveEntry(id: string, title: string, active: boolean): unknown {
  return { id, title, active, task: null, dag: null };
}

/** z-hidden does main-session work (active flag); chat-a is idle. */
const PHASE_WORKING = {
  sessions: [liveEntry("z-hidden", "Z hidden", true), liveEntry("chat-a", "A visible", false)],
};
/** z-hidden settled to idle: both rows are idle, so recency decides. */
const PHASE_IDLE = {
  sessions: [liveEntry("z-hidden", "Z hidden", false), liveEntry("chat-a", "A visible", false)],
};

vi.mock("./features/auth/auth", () => ({
  checkAuth: vi.fn(async () => true),
  logout: vi.fn(async () => undefined),
}));
vi.mock("./lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/api")>();
  return { ...actual, apiJson: vi.fn() };
});
vi.mock("./lib/chatWs", () => ({ connectChat: vi.fn() }));
vi.mock("./lib/useMediaQuery", () => ({ useMediaQuery: vi.fn(() => false) }));
vi.mock("./features/split/paneTree", () => ({ findLeaf: vi.fn(() => null) }));
vi.mock("./features/split/ChatPane", () => ({ ChatPane: () => <div data-testid="chat-pane" /> }));
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
    assignSession: vi.fn(),
    focusPane: vi.fn(),
    split: vi.fn(),
    closePane: vi.fn(),
    changeRatio: vi.fn(),
    hasPane: () => true,
    unplaceSession: vi.fn(),
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

describe("App + Sidebar both-surfaces live ordering", () => {
  let container: HTMLDivElement;
  let root: Root;
  let livePayload: unknown;
  let workspaceList: readonly unknown[];
  let sessionPagesByWs: Readonly<Record<string, (cursor: string) => unknown>>;

  const catalogCalls = (wsId = "ws-1"): string[] =>
    vi.mocked(apiJson).mock.calls
      .map(([path]) => path)
      .filter((path) => path.startsWith(`/api/workspaces/${wsId}/sessions`));

  /** First-page requests issued without an abort signal: the catalog
   * scheduler's cadence and the expand-effect load. The membership crawl
   * always carries a signal, so it never pollutes this count. */
  const scheduledFirstPageCalls = (wsId: string): number =>
    vi.mocked(apiJson).mock.calls
      .filter(([path, options]) =>
        path === `/api/workspaces/${wsId}/sessions?limit=5`
        && !(options as { readonly signal?: unknown } | undefined)?.signal)
      .length;

  const cardNames = (selector: string): string[] =>
    [...container.querySelectorAll<HTMLElement>(`${selector} .th-overview-card`)]
      .map((card) => card.querySelector(".th-overview-card-name")?.textContent ?? "");

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    installMatchMedia();
    window.localStorage.clear();
    window.localStorage.setItem("th-lang", "en");
    livePayload = PHASE_WORKING;
    vi.mocked(apiJson).mockClear();
    workspaceList = [workspace];
    sessionPagesByWs = {
      "ws-1": (cursor) => (cursor === "p2" ? PAGE_TWO : PAGE_ONE),
    };
    vi.mocked(apiJson).mockImplementation(async (path: string) => {
      if (path === "/api/sessions/live") return livePayload;
      if (path === "/api/workspaces") return workspaceList;
      const sessionsMatch = /^\/api\/workspaces\/([^/]+)\/sessions/.exec(path);
      if (sessionsMatch) {
        const cursor = /[?&]cursor=([^&]*)/.exec(path)?.[1] ?? "";
        const pages = sessionPagesByWs[sessionsMatch[1]!];
        if (pages) return pages(cursor);
      }
      return [];
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("orders both surfaces identically from crawl-learned recency, before and after settling to idle", async () => {
    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {});

    // Both surfaces mounted; the membership crawl learned z-hidden's timestamp
    // (it is absent from the loaded first page) and attributed it to ws-1.
    expect(container.querySelector(".th-sidebar-live")).not.toBeNull();
    expect(container.querySelector(".th-home-live")).not.toBeNull();
    expect(catalogCalls()).toContain("/api/workspaces/ws-1/sessions?limit=5&cursor=p2");

    // Working first: z-hidden (active main work) leads on BOTH surfaces.
    expect(cardNames(".th-sidebar-live")).toEqual(["Z hidden", "A visible"]);
    expect(cardNames(".th-home-live")).toEqual(["Z hidden", "A visible"]);

    // Production scheduling path: the catalog scheduler owns the single 15s
    // recency cadence. Nothing catalog-related fires before the cadence...
    const baseline = catalogCalls().length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(14_000);
    });
    expect(catalogCalls().length).toBe(baseline);

    // ...and one cadence later exactly one scheduled first-page refresh fires
    // (its sessionLists replacement re-runs the membership crawl, which pages
    // the union again: +1 scheduled page, +2 crawl pages, nothing else).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    const afterOneCadence = catalogCalls();
    expect(afterOneCadence.length).toBe(baseline + 3);
    expect(afterOneCadence.slice(baseline).sort()).toEqual([
      "/api/workspaces/ws-1/sessions?limit=5",
      "/api/workspaces/ws-1/sessions?limit=5",
      "/api/workspaces/ws-1/sessions?limit=5&cursor=p2",
    ]);

    // z-hidden settles to idle; the next poll (4s cadence) delivers it.
    livePayload = PHASE_IDLE;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    await act(async () => {});

    // Both idle now: the crawl-learned timestamp (5000 > 10) puts z-hidden
    // first on BOTH surfaces. Without the shared recency source the main
    // surface has no timestamp for z-hidden and orders it last.
    expect(cardNames(".th-sidebar-live")).toEqual(["Z hidden", "A visible"]);
    expect(cardNames(".th-home-live")).toEqual(["Z hidden", "A visible"]);
  });

  it("keeps exactly the 15s cadence for a stable owner while a second owner joins and leaves", async () => {
    // Two ready workspaces: both expanded, both first pages loaded. ws-1 owns
    // chat-a (live throughout); ws-2 owns chat-b, which alternates in and out
    // of the live feed on every 4s poll. Owner churn must never reset ws-1's
    // armed cadence: exactly four scheduled ws-1 refreshes in 60 seconds.
    workspaceList = [workspace, workspaceTwo];
    sessionPagesByWs = {
      "ws-1": (cursor) => (cursor === "p2" ? PAGE_TWO : PAGE_ONE),
      "ws-2": () => ({
        items: [{ id: "chat-b", name: "B visible", source: "stored", recencyMs: 20 }],
        nextCursor: "",
      }),
    };
    window.localStorage.setItem("th-ws-expanded", JSON.stringify(["ws-1", "ws-2"]));
    const entryA = liveEntry("chat-a", "A visible", true);
    const entryB = liveEntry("chat-b", "B visible", true);
    livePayload = { sessions: [entryA] };

    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {});

    // Both owners' first pages are ready; ws-1 is the sole initial owner.
    expect(container.querySelector(".th-sidebar-live")).not.toBeNull();
    const baseline = scheduledFirstPageCalls("ws-1");
    expect(baseline).toBe(1);

    for (let tick = 1; tick <= 15; tick += 1) {
      // ws-2 joins on odd polls and leaves on even ones.
      livePayload = { sessions: tick % 2 === 1 ? [entryA, entryB] : [entryA] };
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_000);
      });
    }

    // 60 simulated seconds: the armed interval fired at 15/30/45/60s for the
    // continuously live ws-1, regardless of ws-2's churn.
    expect(scheduledFirstPageCalls("ws-1")).toBe(baseline + 4);
  });

  it("schedules zero periodic requests when the feed's only rows are excluded from the live list", async () => {
    // A legacy row: no active flag, no running work. isLiveSessionListed
    // rejects it, so neither surface lists it and no workspace may be
    // registered as a live owner - even though chat-a is attributable to
    // ws-1 through the chat list.
    livePayload = { sessions: [{ id: "chat-a", title: "Legacy row", task: null, dag: null }] };
    window.localStorage.setItem("th-ws-expanded", JSON.stringify(["ws-1"]));

    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {});

    // Excluded from both live surfaces.
    expect(container.querySelector(".th-sidebar-live")).toBeNull();
    expect(container.querySelector(".th-home-live")).toBeNull();

    // Three full cadences: not a single further catalog request.
    const baseline = catalogCalls().length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000);
    });
    expect(catalogCalls().length).toBe(baseline);
  });

  it("clears the registered periodic targets when logging out through the real control", async () => {
    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {});

    // ws-1 is a live owner; the cadence is armed.
    expect(container.querySelector(".th-sidebar-live")).not.toBeNull();
    const logoutButton = container.querySelector<HTMLButtonElement>('.th-sidebar-footer button[title="Log out"]');
    expect(logoutButton).not.toBeNull();

    await act(async () => {
      logoutButton!.click();
    });
    await act(async () => {});

    // Three full cadences after logout: zero further catalog requests.
    const baseline = catalogCalls().length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000);
    });
    expect(catalogCalls().length).toBe(baseline);
  });
});
