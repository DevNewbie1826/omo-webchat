import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LayoutApi } from "../split/useLayout";
import type { RpcLiveState } from "./rpcSessions";
import { RECENCY_REFRESH_INTERVAL_MS, useWorkspaces } from "./useWorkspaces";

const layout: LayoutApi = {
  root: { kind: "leaf", id: "pane", sessionId: null }, focusedPaneId: "pane", placed: new Set(),
  focusPane: vi.fn(), hasPane: () => true, assignSession: vi.fn(), split: vi.fn(), closePane: vi.fn(),
  changeRatio: vi.fn(), unplaceSession: vi.fn(), focusSession: () => false,
};
let root: Root;
let container: HTMLDivElement;
let current: ReturnType<typeof useWorkspaces>;

function Probe() {
  current = useWorkspaces({ layout, notify: () => undefined, t: key => key, confirm: async () => true });
  return <span data-testid="sixth-status">{current.rpcLiveChats.get("chat-6")?.status ?? "unbound"}</span>;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("refreshes sixth-row working, blocked and unbound states across pages when the expanded workspace also has a manager owner", async () => {
  // Given: six loaded stored rows and a manager-owned chat in the same workspace.
  const chats = Array.from({ length: 6 }, (_, index) => ({
    id: `chat-${index + 1}`, name: `Chat ${index + 1}`, provider: "omo",
  }));
  const requests: string[] = [];
  let live: RpcLiveState | undefined = { status: "working", questions: [] };
  let recencyMs = 100;
  vi.stubGlobal("fetch", async (input: string) => {
    const url = new URL(input, "http://localhost");
    if (url.pathname === "/api/workspaces") {
      return Response.json([{ id: "ws", name: "Workspace", path: "/work", chats }]);
    }
    if (url.pathname === "/api/workspaces/ws/sessions") {
      requests.push(url.search);
      const tail = url.searchParams.get("cursor") === "page-two";
      return Response.json({
        items: (tail ? chats.slice(5) : chats.slice(0, 5)).map(chat => ({
          id: chat.id, name: chat.name, source: "stored", recencyMs,
          ...(chat.id === "chat-6" && live ? { live } : {}),
        })),
        nextCursor: tail ? "" : "page-two",
        live: [],
      });
    }
    throw new Error(`Unexpected URL ${url}`);
  });
  await act(async () => root.render(<Probe />));
  await act(async () => current.load());
  await act(async () => current.setExpanded(new Set(["ws"])));
  await act(async () => current.loadMoreSessions("ws"));
  act(() => current.setRecencyTargets(["ws"]));
  expect(current.sessionLists.get("ws")).toHaveLength(6);
  expect(container.textContent).toBe("working");

  // When: watcher state changes at each real scheduler deadline while ownership remains.
  for (const status of ["working", "blocked", "unbound"] as const) {
    live = status === "unbound" ? undefined : { status, questions: status === "blocked" ? ["question"] : [] };
    recencyMs += 100;
    requests.length = 0;
    await act(async () => vi.advanceTimersByTimeAsync(RECENCY_REFRESH_INTERVAL_MS));

    // Then: every tick traverses the cursor, updates the rendered sixth row,
    // and still applies the owner's authoritative first-page recency.
    expect(requests).toContain("?limit=5&cursor=page-two");
    expect(container.textContent).toBe(status);
    expect(current.rpcLiveChats.get("chat-6")).toEqual(live);
    expect(current.sessionLists.get("ws")?.find(row => row.id === "chat-1")?.recencyMs).toBe(recencyMs);
  }
});
