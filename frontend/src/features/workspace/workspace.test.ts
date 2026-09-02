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

  it("resolves running membership beyond page one without populating the visible list", async () => {
    const workspace: Workspace = { id: "ws-1", name: "Workspace", path: "/work", chats: [] };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      return path.includes("cursor=page-2")
        ? okResponse({
            items: [{ id: "cursor-only", name: "Cursor only", source: "stored", recencyMs: 1 }],
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
    expect(membership.hadFailures).toBe(false);
  });
});
