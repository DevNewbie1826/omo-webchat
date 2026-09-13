import { afterEach, describe, expect, it, vi } from "vitest";
import { listWorkspaceSessions, resolveWorkspaceSessionMembership } from "./workspace";
import type { Workspace } from "./workspace";

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("listWorkspaceSessions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests the first page with the five-entry limit and no cursor", async () => {
    const fetchMock = vi.fn(async () => okResponse({ items: [], nextCursor: "" }));
    vi.stubGlobal("fetch", fetchMock);

    const page = await listWorkspaceSessions("ws 1");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workspaces/ws%201/sessions?limit=5",
      expect.objectContaining({ method: "GET" }),
    );
    expect(page).toEqual({ items: [], nextCursor: "" });
  });

  it("passes the continuation cursor and returns the typed page", async () => {
    const fetchMock = vi.fn(async () =>
      okResponse({
        items: [{ id: "s6", name: "Older", source: "discovered", recencyMs: 1000 }],
        nextCursor: "",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const page = await listWorkspaceSessions("ws-1", "cursor-token");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workspaces/ws-1/sessions?limit=5&cursor=cursor-token",
      expect.anything(),
    );
    expect(page.items).toEqual([{ id: "s6", name: "Older", source: "discovered", recencyMs: 1000 }]);
    expect(page.nextCursor).toBe("");
  });

  it("removes legacy already-adopted provenance rows from UI state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse({
      items: [
        { id: "chat-1", name: "Stored", source: "stored", recencyMs: 2 },
        { id: "durable-1", name: "Source", source: "alreadyAdopted", recencyMs: 1 },
      ],
      nextCursor: "",
    })));

    const page = await listWorkspaceSessions("ws-1");
    expect(page.items.map((item) => item.id)).toEqual(["chat-1"]);
  });

  it("resolves running membership beyond page one without populating the visible list", async () => {
    const workspace: Workspace = { id: "ws-1", name: "Workspace", path: "/work", chats: [] };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      return path.includes("cursor=page-2")
        ? okResponse({
            items: [{ id: "cursor-only", name: "Cursor only", source: "stored", recencyMs: 7 }],
            nextCursor: "page-3",
          })
        : okResponse({
            items: Array.from({ length: 5 }, (_, index) => ({
              id: `recent-${index}`,
              name: `Recent ${index}`,
              source: "stored",
              recencyMs: 10 - index,
            })),
            nextCursor: "page-2",
          });
    });
    vi.stubGlobal("fetch", fetchMock);

    const membership = await resolveWorkspaceSessionMembership(
      [workspace],
      new Set(["cursor-only"]),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(membership.memberships.get("ws-1")).toEqual(new Set(["cursor-only"]));
    expect(membership.recency.get("cursor-only")).toBe(7);
    expect(membership.hadFailures).toBe(false);
  });

  it("returns the catalog recency for every matched session without extra requests", async () => {
    const workspace: Workspace = { id: "ws-1", name: "Workspace", path: "/work", chats: [] };
    vi.stubGlobal("fetch", vi.fn(async () => okResponse({
      items: [
        { id: "live-a", name: "A", source: "stored", recencyMs: 30 },
        { id: "live-b", name: "B", source: "stored", recencyMs: 20 },
        { id: "other", name: "Other", source: "stored", recencyMs: 10 },
        { id: "live-a", name: "A alias", source: "discovered", recencyMs: 99 },
      ],
      nextCursor: "",
    })));

    const membership = await resolveWorkspaceSessionMembership(
      [workspace],
      new Set(["live-a", "live-b"]),
    );

    expect(membership.recency).toEqual(new Map([["live-a", 30], ["live-b", 20]]));
    expect(membership.hadFailures).toBe(false);
  });

  it("keeps the highest recency when workspaces disagree about a session", async () => {
    const workspaces: Workspace[] = [
      { id: "ws-1", name: "One", path: "/one", chats: [] },
      { id: "ws-2", name: "Two", path: "/two", chats: [] },
    ];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) =>
      okResponse({
        items: [{
          id: "live",
          name: "Live",
          source: "stored",
          recencyMs: String(input).includes("ws-1") ? 40 : 60,
        }],
        nextCursor: "",
      })));

    const membership = await resolveWorkspaceSessionMembership(workspaces, new Set(["live"]));

    expect(membership.recency.get("live")).toBe(60);
  });
});
