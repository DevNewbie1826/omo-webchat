import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { deferred } from "./App.testHarness";
import type { Terminal } from "./features/workspace/workspace";

vi.mock("./lib/chatWs", () => ({ connectChat: vi.fn((handlers) => {
  handlers.onOpen?.();
  return { send: vi.fn(), close: vi.fn() };
}) }));

const stored = { id: "stored-a", name: "Stored A", provider: "omo" };
const newer = { id: "stored-new", name: "Newer", provider: "omo" };
const discovered = { id: "discovered-b", name: "Discovered B", source: "discovered", recencyMs: 30 };
const paged = { id: "discovered-c", name: "Discovered C", source: "discovered", recencyMs: 10 };
const unresolved = { id: "union-row", name: "Union row", source: "stored", recencyMs: 20 };

describe("App pane routing with real layout, sidebar, picker and chat", () => {
  let container: HTMLDivElement;
  let root: Root;
  let narrow: boolean;
  let empty: boolean;
  let opening: ReturnType<typeof deferred<Terminal>>;
  let failPage: boolean;
  let failMore: boolean;
  let activeConflict: boolean;
  let requests: { path: string; method: string; body: string }[];

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    narrow = false; empty = false; failPage = false; failMore = false; activeConflict = false;
    requests = [];
    opening = deferred<Terminal>();
    localStorage.setItem("th-lang", "en");
    localStorage.setItem("th-ws-expanded", '["ws"]');
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(min-width: 1024px)" ? !narrow : query === "(max-width: 768px)" && narrow,
      addEventListener() {}, removeEventListener() {},
    }));
    vi.stubGlobal("ResizeObserver", class {
      observe() {} unobserve() {} disconnect() {}
    });
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      const url = new URL(input, "http://localhost");
      const path = url.pathname;
      requests.push({ path: path + url.search, method: init?.method ?? "GET", body: String(init?.body ?? "") });
      if (path === "/api/auth/check") return new Response(null, { status: 204 });
      if (path === "/api/providers") return Response.json([{ id: "omo", available: true }]);
      if (path === "/api/workspaces") return Response.json([{ id: "ws", name: "Workspace", path: "/fixture", chats: [stored, newer] }]);
      if (path === "/api/layout") return Response.json({ layout: narrow
        ? { kind: "leaf", id: "left", sessionId: null }
        : { kind: "split", id: "split", dir: "h", ratio: 0.5,
            first: { kind: "leaf", id: "left", sessionId: empty ? null : stored.id },
            second: { kind: "leaf", id: "right", sessionId: null } } });
      if (path.endsWith("/sessions/open")) {
        if (activeConflict && !String(init?.body).includes('"force":true')) return Response.json({ state: "session-active" }, { status: 409 });
        return Response.json(await opening.promise);
      }
      if (path === "/api/workspaces/ws/chats" && init?.method === "POST") return Response.json(await opening.promise);
      if (path === "/api/workspaces/ws/sessions") {
        if (failPage || (failMore && url.searchParams.has("cursor"))) return new Response("failed", { status: 500 });
        return Response.json(url.searchParams.has("cursor") ? { items: [paged], nextCursor: "" } : {
          items: [discovered, unresolved, { ...stored, source: "stored", recencyMs: 15 }, { ...newer, source: "stored", recencyMs: 5 }], nextCursor: "page-2",
        });
      }
      if (path.endsWith("/goal")) return Response.json({ goal: null });
      if (path.endsWith("/activity")) return Response.json({ history: {} });
      if (path.startsWith("/api/sessions/")) return Response.json({ sessions: [] });
      throw new Error(`Unexpected fixture endpoint ${path}`);
    });
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  });
  async function mount() { await act(async () => root.render(<App />)); }
  function pane(index: number) {
    const result = container.querySelectorAll<HTMLElement>(".th-pane-wrap")[index];
    if (!result) throw new Error(`Missing pane ${index}`);
    return result;
  }
  function button(scope: ParentNode, selector: string) {
    const result = scope.querySelector<HTMLButtonElement>(selector);
    if (!result) throw new Error(`Missing button ${selector}`);
    return result;
  }
  async function click(target: HTMLElement) { await act(async () => target.click()); }
  async function focusPane(index: number) { await act(async () => button(pane(index), "button").focus()); }
  function row(scope: ParentNode, name: string) { return button(scope, `[aria-label="Workspace / ${name}"]`); }
  function sidebar(name: string) {
    const result = [...container.querySelectorAll<HTMLButtonElement>(".th-tree-children .th-tree-activation")].find(e => e.textContent === name);
    if (!result) throw new Error(`Missing sidebar row ${name}`);
    return result;
  }
  function title(index: number) { return pane(index).querySelector(".th-termhead-name")?.textContent ?? null; }
  function assertNoDestructiveCalls() {
    expect(requests.filter(r => r.method === "DELETE" || /stop|disconnect/.test(r.path))).toEqual([]);
  }

  it("moves a hosted session to the pointer-selected empty destination without import, stop or delete", async () => {
    await mount();
    act(() => pane(1).dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
    await click(sidebar("Stored A"));
    expect([title(0), title(1)]).toEqual([null, "Stored A"]);
    expect(container.querySelectorAll(".th-pane--focused")).toHaveLength(1);
    expect(pane(1).querySelector(".th-pane--focused") ?? pane(1).matches(".th-pane--focused")).toBeTruthy();
    expect(requests.filter(r => r.path.endsWith("/sessions/open"))).toHaveLength(0);
    expect(sidebar("Stored A").getAttribute("aria-current")).toBe("true");
    expect(container.querySelector(".th-tree-children .th-tree-activation")?.textContent).toBe("Stored A");
    assertNoDestructiveCalls();
  });
  it("activates occupied and empty panes by keyboard while portal focus preserves the active destination", async () => {
    await mount(); await focusPane(1);
    expect(pane(1).matches(".th-pane--focused")).toBe(true);
    await click(button(pane(0), '.th-disconnect-btn'));
    expect(pane(1).matches(".th-pane--focused")).toBe(true);
    await click(button(document, '.th-confirm-actions .th-btn--ghost'));
    await focusPane(0);
    expect(pane(0).querySelector(".th-pane--focused")).not.toBeNull();
  });
  it("opens discovered rows through the empty picker and preserves the captured target across focus changes", async () => {
    await mount(); await click(row(pane(1), "Discovered B")); await focusPane(0);
    await act(async () => opening.resolve({ id: "opened-b", name: "Opened B", provider: "omo" }));
    expect([title(0), title(1)]).toEqual(["Stored A", "Opened B"]);
    expect(pane(0).querySelector(".th-pane--focused")).not.toBeNull();
    expect(requests.filter(r => r.path.endsWith("/sessions/open"))).toHaveLength(1);
  });
  it.each(["newer", "closed"])("drops a deferred sidebar open when its destination is %s", async (mode) => {
    await mount(); await focusPane(1); await click(sidebar("Discovered B"));
    if (mode === "newer") await click(sidebar("Newer"));
    else await click(button(pane(1), '[aria-label="Close pane"]'));
    await act(async () => opening.resolve({ id: "opened-b", name: "Opened B", provider: "omo" }));
    expect(container.querySelectorAll(".th-termhead-name")).toHaveLength(mode === "newer" ? 2 : 1);
    expect([...container.querySelectorAll(".th-termhead-name")].map(e => e.textContent)).toEqual(mode === "newer" ? ["Stored A", "Newer"] : ["Stored A"]);
    expect(container.querySelectorAll(".th-pane--focused")).toHaveLength(1);
    assertNoDestructiveCalls();
  });
  it.each([false, true])("pages and opens discovered sessions in the shared empty surface (narrow=%s)", async (mobile) => {
    narrow = mobile; empty = true; await mount();
    const surface = narrow ? button(container, ".th-empty").parentElement ?? container : pane(1);
    expect(row(surface, "Stored A")).toBeDefined(); expect(row(surface, "Union row")).toBeDefined();
    await click(button(surface, ".th-picker-load-more"));
    await click(row(surface, "Discovered C"));
    await act(async () => opening.resolve({ id: "opened-c", name: "Opened C", provider: "omo" }));
    expect(container.querySelectorAll(".th-termhead-name")).toHaveLength(1);
    expect(container.querySelector(".th-termhead-name")?.textContent).toBe("Opened C");
  });
  it.each(["newer", "closed"])("keeps new-chat completion from replacing a %s target", async (mode) => {
    await mount(); await click(button(pane(1), ".th-picker-pane-create button"));
    expect(requests.filter(r => r.method === "POST" && r.path.endsWith("/chats"))).toHaveLength(1);
    if (mode === "newer") { await focusPane(1); await click(sidebar("Newer")); }
    else await click(button(pane(1), '[aria-label="Close pane"]'));
    await act(async () => opening.resolve({ id: "created", name: "Created", provider: "omo" }));
    expect([...container.querySelectorAll(".th-termhead-name")].map(e => e.textContent)).toEqual(mode === "newer" ? ["Stored A", "Newer"] : ["Stored A"]);
  });
  it("opens an unresolved stored row without a preparation request", async () => {
    await mount(); await click(row(pane(1), "Union row"));
    expect(title(1)).toBe("Union row");
    expect(requests.filter(r => r.path.endsWith("/sessions/open"))).toHaveLength(0);
  });
  it("shows first-page failure and supports explicit retry without a fetch loop", async () => {
    failPage = true; await mount();
    expect(pane(1).querySelector('[role="alert"]')).not.toBeNull();
    failPage = false; await click(button(pane(1), ".th-picker-page-retry"));
    expect(row(pane(1), "Discovered B")).toBeDefined();
  });
  it("retains loaded rows and exposes retry after a continuation failure", async () => {
    await mount(); failMore = true; await click(button(pane(1), ".th-picker-load-more"));
    expect(pane(1).querySelector('[role="alert"]')).not.toBeNull();
    expect(row(pane(1), "Stored A")).toBeDefined();
    failMore = false; await click(button(pane(1), ".th-picker-page-retry"));
    expect(row(pane(1), "Discovered C")).toBeDefined();
  });
  it("keeps session-active recovery explicit and opens exactly once on force", async () => {
    activeConflict = true; await mount(); await click(row(pane(1), "Discovered B"));
    expect(pane(1).querySelector('[role="status"]')).not.toBeNull();
    await click(button(pane(1), ".th-picker-force-open"));
    await act(async () => opening.resolve({ id: "opened-b", name: "Opened B", provider: "omo" }));
    expect(title(1)).toBe("Opened B");
    expect(requests.filter(r => r.path.endsWith("/sessions/open")).map(r => JSON.parse(r.body).force ?? false)).toEqual([false, true]);
  });
});
