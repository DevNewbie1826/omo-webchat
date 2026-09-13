import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { apiJson } from "./lib/api";
import { connectChat } from "./lib/chatWs";
import type { ChatHandlers } from "./lib/chatWs";

vi.mock("./features/auth/auth", () => ({ checkAuth: vi.fn(async () => true), logout: vi.fn() }));
vi.mock("./lib/api", async original => ({ ...await original<object>(), apiJson: vi.fn() }));
vi.mock("./lib/chatWs", () => ({ connectChat: vi.fn() }));
vi.mock("./lib/useMediaQuery", () => ({ useMediaQuery: () => false }));
vi.mock("./features/split/paneTree", () => ({ findLeaf: () => null }));
vi.mock("./features/split/ChatPane", () => ({ ChatPane: () => null }));
vi.mock("./features/workspace/WorkspaceWizard", () => ({ WorkspaceWizard: () => null }));
vi.mock("./components/NewChatDialog", () => ({ NewChatDialog: () => null }));
vi.mock("./features/workspace/useProviderDiscovery", () => ({ useProviderDiscovery: () => ({
  discovery: { status: "loaded", providers: [{ id: "omo", label: "omo", binary: "omo", available: true }] },
  retry: vi.fn(),
}) }));
vi.mock("./features/split/useLayout", () => ({ useLayout: () => ({
  root: { kind: "leaf", id: "pane-1", sessionId: null }, focusedPaneId: "pane-1", placed: new Set<string>(),
  focusSession: () => false, assignSession: vi.fn(), focusPane: vi.fn(), split: vi.fn(), closePane: vi.fn(),
  changeRatio: vi.fn(), hasPane: () => true, unplaceSession: vi.fn(),
}) }));

const older = { id: "a", title: "A older", active: false, last_activity_ms: 100, running: { agents: 0 } };
const newer = { id: "z", title: "Z newer", active: false, last_activity_ms: 200, running: { agents: 0 } };

describe("rendered lean recency on Sidebar and home", () => {
  let container: HTMLDivElement;
  let root: Root;
  let handlers: ChatHandlers;
  let rows: readonly object[];
  let catalog: readonly object[];
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("matchMedia", (media: string) => ({ matches: false, media,
      addEventListener: () => undefined, removeEventListener: () => undefined }));
    window.localStorage.clear();
    rows = [older, newer];
    catalog = [];
    vi.mocked(connectChat).mockImplementation(h => {
      handlers = h;
      return { send: () => true, close: () => undefined };
    });
    vi.mocked(apiJson).mockImplementation(async path => {
      if (path === "/api/sessions/live") return { sessions: rows };
      if (path === "/api/workspaces") return [{ id: "ws", name: "Workspace", path: "/work", chats: [] }];
      if (path.startsWith("/api/workspaces/ws/sessions")) return { items: catalog, nextCursor: "" };
      return [];
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.localStorage.clear();
  });
  function expectBoth(titles: readonly string[]): void {
    for (const surface of [".th-sidebar-live", ".th-home-live"]) {
      expect([...container.querySelectorAll(`${surface} .th-overview-card-name`)]
        .map(node => node.textContent)).toEqual(titles);
    }
  }
  it("renders newer lean rows before conflicting titles when catalog recency is absent", async () => {
    // Given idle lean rows with reverse alphabetical recency and no catalog.
    // When both real surfaces mount.
    await act(async () => root.render(<App />));
    // Then accepted lean recency, not title, determines their rendered order.
    expectBoth(["Z newer", "A older"]);
  });
  it("prefers accepted lean recency when the catalog advertises the opposite order", async () => {
    // Given stale catalog values that would put A first.
    catalog = [{ id: "a", name: "A older", source: "stored", recencyMs: 9000 },
      { id: "z", name: "Z newer", source: "stored", recencyMs: 1 }];
    // When both surfaces mount with the lean feed.
    await act(async () => root.render(<App />));
    // Then catalog values cannot override accepted lean receipts.
    expectBoth(["Z newer", "A older"]);
  });
  it("reorders both mounted surfaces when a newer pushed revision arrives", async () => {
    // Given A initially newest, matching the title tie-break order.
    rows = [{ ...older, last_activity_ms: 300 }, newer];
    await act(async () => root.render(<App />));
    expectBoth(["A older", "Z newer"]);
    // When Z receives a strictly newer revision.
    act(() => handlers.onFrame({ type: "sessions.activity", sessionId: "z", durableSessionId: "z",
      overflow: false, active: false, last_activity_ms: 400, running: { agents: 0 } }));
    // Then the final rendered comparators react to accepted push recency.
    expectBoth(["Z newer", "A older"]);
  });
  it("keeps main and child work before more recent idle sessions", async () => {
    // Given old working rows and a much newer idle row.
    rows = [{ ...older, active: true, last_activity_ms: 1 },
      { ...newer, last_activity_ms: 2, running: { agents: 1 } },
      { ...older, id: "idle", title: "Idle newest", last_activity_ms: 9000 }];
    // When both real surfaces render.
    await act(async () => root.render(<App />));
    // Then working grouping precedes recency, with recency ordering within it.
    expectBoth(["Z newer", "A older", "Idle newest"]);
  });
  it("preserves deterministic recency and title ties across many sessions", async () => {
    // Given reverse-title receipt order, pairs tied on receipt, and scrambled transport order.
    const ordered = Array.from({ length: 40 }, (_, index) => ({
      id: `s-${index}`, title: `${String(39 - index).padStart(2, "0")}-${index % 2}`,
      active: false, last_activity_ms: 1000 - Math.floor(index / 2), running: { agents: 0 },
    }));
    rows = [...ordered.filter((_, index) => index % 2 === 0), ...ordered.filter((_, index) => index % 2 === 1)].reverse();
    const expected = Array.from({ length: 20 }, (_, pair) => [ordered[pair * 2 + 1]?.title, ordered[pair * 2]?.title]).flat();
    // When both surfaces render the complete feed.
    await act(async () => root.render(<App />));
    // Then each receipt pair uses title order without discarding recency between pairs.
    for (const surface of [".th-sidebar-live", ".th-home-live"]) {
      expect([...container.querySelectorAll(`${surface} .th-overview-card-name`)]
        .map(node => node.textContent)).toEqual(expected);
    }
  });
  it("falls back to catalog recency only for a row without an accepted lean receipt", async () => {
    // Given a timestamp-less compatible row with known catalog recency.
    rows = [{ id: "a", title: "A older", active: false }, newer];
    catalog = [{ id: "a", name: "A older", source: "stored", recencyMs: 300 }];
    // When both surfaces render.
    await act(async () => root.render(<App />));
    // Then that row retains the catalog fallback instead of becoming timeless.
    expectBoth(["A older", "Z newer"]);
  });
});
