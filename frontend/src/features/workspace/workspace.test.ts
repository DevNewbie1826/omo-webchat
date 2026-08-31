import { afterEach, describe, expect, it, vi } from "vitest";
import { listWorkspaceSessions } from "./workspace";

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
});
