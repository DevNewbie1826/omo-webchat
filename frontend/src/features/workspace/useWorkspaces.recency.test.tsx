import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { deferred } from "../../App.testHarness";
import type { LayoutApi } from "../split/useLayout";
import type { WorkspaceSessionPage, Workspace } from "./workspace";
import { CATALOG_REFRESH_DELAY_MS, useWorkspaces } from "./useWorkspaces";

const workspace: Workspace = { id: "ws", name: "Workspace", path: "/work", chats: [
  { id: "web", name: "Web", provider: "omo" },
] };
const disk = { id: "disk", name: "Disk", source: "discovered", recencyMs: 100 } as const;
const web = { id: "web", name: "Web", source: "stored", recencyMs: 80 } as const;
const layout: LayoutApi = {
  root: { kind: "leaf", id: "pane", sessionId: null }, focusedPaneId: "pane", placed: new Set(),
  focusPane: vi.fn(), hasPane: () => true, assignSession: vi.fn(), split: vi.fn(), closePane: vi.fn(),
  changeRatio: vi.fn(), unplaceSession: vi.fn(), focusSession: () => false,
};
let root: Root;
let container: HTMLDivElement;
let current: ReturnType<typeof useWorkspaces>;
let pages: ReturnType<typeof deferred<WorkspaceSessionPage>>[];
let touches: ReturnType<typeof deferred<{ readonly recencyMs: number }>>[];
let paths: string[];
const notify = vi.fn();
function Probe() {
  current = useWorkspaces({ layout, notify, t: key => key, confirm: async () => true });
  return null;
}
beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear(); paths = []; pages = []; touches = [];
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const url = new URL(input, "http://localhost");
    paths.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    if (url.pathname === "/api/workspaces") return Response.json([workspace]);
    if (url.pathname.endsWith("/touch")) {
      const touch = deferred<{ readonly recencyMs: number }>(); touches.push(touch);
      return Response.json(await touch.promise);
    }
    if (url.pathname.endsWith("/sessions")) {
      const page = deferred<WorkspaceSessionPage>(); pages.push(page);
      return Response.json(await page.promise);
    }
    throw new Error(`Unexpected URL ${url}`);
  });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<Probe />));
  await act(async () => current.load());
  act(() => current.ensureSessionsLoaded("ws"));
  await act(async () => pages[0]?.resolve({ items: [disk, web], nextCursor: "more" }));
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); localStorage.clear();
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
function rows() { return current.sessionLists.get("ws")?.map(row => [row.id, row.recencyMs]); }

it("sorts all loaded rows numerically with ordinal ties when a continuation contains newer activity", async () => {
  // Given: loaded disk and stored rows, with a continuation in flight.
  act(() => { void current.loadMoreSessions("ws"); });
  // When: a newer row plus an updated overlap arrives on the next page.
  await act(async () => pages[1]?.resolve({ items: [
    { ...web, recencyMs: 150 }, { ...disk, id: "A", recencyMs: 120 }, { ...disk, id: "a", recencyMs: 120 },
  ], nextCursor: "" }));
  // Then: neither source priority nor page concatenation affects recency.
  expect(rows()).toEqual([["web", 150], ["A", 120], ["a", 120], ["disk", 100]]);
});

it("persists explicit use without blocking local activation and rejects older use responses", async () => {
  // Given: two explicit activations with distinct server confirmations.
  act(() => current.markSessionUsed("ws", "web"));
  expect(rows()?.[0]).toEqual(["web", 1000]);
  vi.setSystemTime(2000);
  act(() => current.markSessionUsed("ws", "web"));
  // When: the newer request completes before the older request.
  await act(async () => touches[1]?.resolve({ recencyMs: 1800 }));
  await act(async () => touches[0]?.resolve({ recencyMs: 900 }));
  // Then: server confirmation wins over optimistic/client time and old responses.
  expect(paths.filter(path => path.endsWith("/touch"))).toEqual([
    "POST /api/workspaces/ws/chats/web/touch", "POST /api/workspaces/ws/chats/web/touch",
  ]);
  expect(rows()?.[0]).toEqual(["web", 1800]);
});

it("retains confirmed use and continuation rows when an older head refresh arrives", async () => {
  // Given: a loaded continuation and confirmed activation.
  act(() => { void current.loadMoreSessions("ws"); });
  await act(async () => pages[1]?.resolve({ items: [{ ...disk, id: "tail", recencyMs: 10 }], nextCursor: "" }));
  act(() => current.markSessionUsed("ws", "web"));
  await act(async () => touches[0]?.resolve({ recencyMs: 900 }));
  // When: the bounded refresh returns an older snapshot.
  await act(async () => vi.advanceTimersByTime(CATALOG_REFRESH_DELAY_MS));
  await act(async () => pages[2]?.resolve({ items: [disk, web], nextCursor: "more" }));
  // Then
  expect(rows()).toEqual([["web", 900], ["disk", 100], ["tail", 10]]);
});

it("does not resurrect a deleted row when a page or usage response arrives late", async () => {
  // Given: in-flight use and continuation requests for a row being deleted.
  act(() => current.markSessionUsed("ws", "web"));
  act(() => { void current.loadMoreSessions("ws"); });
  const chat = workspace.chats[0]; if (!chat) throw new Error("fixture missing chat");
  await act(async () => current.handleDeleteTerminal(workspace, chat));
  // When
  await act(async () => touches[0]?.resolve({ recencyMs: 900 }));
  await act(async () => pages[1]?.resolve({ items: [web], nextCursor: "" }));
  // Then
  expect(rows()).toEqual([["disk", 100]]);
});

it("does not restore a removed workspace when an old page resolves", async () => {
  // Given
  act(() => { void current.loadMoreSessions("ws"); });
  await act(async () => current.handleDeleteWorkspace(workspace));
  // When
  await act(async () => pages[1]?.resolve({ items: [web], nextCursor: "" }));
  // Then
  expect(current.sessionLists.has("ws")).toBe(false);
  expect(current.sessionPages.has("ws")).toBe(false);
});

it("keeps represented source activity when a canonical page still carries its durable alias", async () => {
  // Given: an in-place binding whose discovered source is folded into web.
  const chat = workspace.chats[0]; if (!chat) throw new Error("fixture missing chat");
  act(() => current.addCreatedSession("ws", chat, disk));
  act(() => { void current.loadMoreSessions("ws"); });
  // When: later activity arrives on the original durable ID.
  await act(async () => pages[1]?.resolve({ items: [{ ...disk, recencyMs: 5000 }], nextCursor: "" }));
  // Then: the stored representative gets the activity, without a second row.
  expect(rows()).toEqual([["web", 5000]]);
});

it("keeps server activity observed under an optimistic use when confirmation is older", async () => {
  // Given: optimistic use is ahead of the server clock.
  act(() => current.markSessionUsed("ws", "web"));
  act(() => { void current.loadMoreSessions("ws"); });
  await act(async () => pages[1]?.resolve({ items: [{ ...web, recencyMs: 900 }], nextCursor: "" }));
  // When: explicit-use confirmation is older than the observed file activity.
  await act(async () => touches[0]?.resolve({ recencyMs: 200 }));
  // Then: lowering the optimistic clock must not discard known server activity.
  expect(rows()).toEqual([["web", 900], ["disk", 100]]);
});

it("rolls back optimistic use and reports failure when the endpoint returns malformed recency", async () => {
  // Given
  notify.mockClear();
  act(() => current.markSessionUsed("ws", "web"));
  // When: the wire returns null (JSON representation of NaN).
  await act(async () => touches[0]?.resolve({ recencyMs: Number.NaN }));
  // Then
  expect(rows()).toEqual([["disk", 100], ["web", 80]]);
  expect(notify).toHaveBeenCalledWith("toast.error", "error");
});

it("retains newer title metadata when an earlier use response completes", async () => {
  // Given
  act(() => current.markSessionUsed("ws", "web"));
  act(() => current.handleChatName("ws", "web", "Confirmed title"));
  // When
  await act(async () => touches[0]?.resolve({ recencyMs: 900 }));
  // Then
  expect(current.sessionLists.get("ws")?.find(item => item.id === "web")?.name).toBe("Confirmed title");
});

it("reconciles a newly created row to authoritative use time when the client clock is ahead", async () => {
  // Given
  act(() => current.addCreatedSession("ws", { id: "created", name: "Created", provider: "omo" }));
  act(() => current.markSessionUsed("ws", "created"));
  // When
  await act(async () => touches[0]?.resolve({ recencyMs: 900 }));
  // Then
  expect(rows()?.[0]).toEqual(["created", 900]);
});

it("preserves logical file recency when adding its stored wrapper without activation", () => {
  // Given: file activity predates the client clock used for new metadata wrappers.
  const chat = workspace.chats[0]; if (!chat) throw new Error("fixture missing chat");
  // When: identity wrapping alone is not explicit use.
  act(() => current.addCreatedSession("ws", chat, disk));
  // Then: the representative inherits file activity, not wrapper creation time.
  expect(rows()).toEqual([["web", 100]]);
  expect(paths.filter(path => path.endsWith("/touch"))).toEqual([]);
});
