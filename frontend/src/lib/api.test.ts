import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  apiDownload,
  apiJson,
  apiRaw,
  apiVoid,
  fetchOlderHistory,
  notifyUnauthorized,
  setUnauthorizedHandler,
} from "./api";

function errorResponse(status: number, body = ""): Response {
  return {
    ok: false,
    status,
    statusText: status === 401 ? "Unauthorized" : "Internal Server Error",
    json: async () => {
      if (body.length === 0) throw new SyntaxError("empty body");
      return JSON.parse(body) as unknown;
    },
  } as unknown as Response;
}

describe("api unauthorized handling", () => {
  afterEach(() => {
    setUnauthorizedHandler(undefined);
    vi.unstubAllGlobals();
  });

  it("fires the handler on a 401 from apiJson and still rejects with ApiError", async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    vi.stubGlobal("fetch", vi.fn(async () => errorResponse(401, '{"error":"session expired"}')));

    const error: unknown = await apiJson("/api/thing").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect((error as ApiError).message).toBe("session expired");
    expect(handler).toHaveBeenCalledExactlyOnceWith();
  });

  it("fires the handler on 401s from apiVoid and apiRaw too", async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    vi.stubGlobal("fetch", vi.fn(async () => errorResponse(401)));

    await expect(apiVoid("/api/auth/check")).rejects.toBeInstanceOf(ApiError);
    await expect(apiRaw("/api/upload", { body: "x" })).rejects.toBeInstanceOf(ApiError);

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("fires the handler on a 401 from an intercepted download", async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    vi.stubGlobal("fetch", vi.fn(async () => errorResponse(401)));

    await expect(apiDownload("/api/fs/download?path=notes.txt", "notes.txt")).rejects.toMatchObject({
      status: 401,
    });

    expect(handler).toHaveBeenCalledExactlyOnceWith();
  });

  it("does not fire the handler for other error statuses", async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    vi.stubGlobal("fetch", vi.fn(async () => errorResponse(500)));

    await expect(apiJson("/api/thing")).rejects.toMatchObject({ status: 500 });
    expect(handler).not.toHaveBeenCalled();
  });

  it("still rejects with ApiError when no handler is registered", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => errorResponse(401)));

    await expect(apiVoid("/api/thing")).rejects.toMatchObject({ status: 401 });
  });

  it("lets non-REST paths trigger the same handler via notifyUnauthorized", () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);

    notifyUnauthorized();
    notifyUnauthorized();
    expect(handler).toHaveBeenCalledTimes(2);

    setUnauthorizedHandler(undefined);
    expect(() => notifyUnauthorized()).not.toThrow();
    expect(handler).toHaveBeenCalledTimes(2);
  });
});

describe("fetchOlderHistory", () => {
  afterEach(() => {
    setUnauthorizedHandler(undefined);
    vi.unstubAllGlobals();
  });

  it("requests an encoded history page and returns its payload", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => ({
      ok: true,
      status: 200,
      json: async () => ({ sessionId: "durable", entries: [{ id: "e1" }], historyComplete: false }),
    }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchOlderHistory("ws /", "chat?", { session: "session/1", before: "entry 2", limit: 50 })).resolves.toEqual({
      kind: "page", sessionId: "durable", entries: [{ id: "e1" }], historyComplete: false,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/workspaces/ws%20%2F/chats/chat%3F/history?session=session%2F1&before=entry+2&limit=50",
    );
  });

  it.each([
    [409, { kind: "stale" }],
    [404, { kind: "gone" }],
    [503, { kind: "busy" }],
    [500, { kind: "error", status: 500 }],
  ] as const)("maps HTTP %s", async (status, expected) => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status }) as Response));
    await expect(fetchOlderHistory("w", "c", { session: "s", before: "e" })).resolves.toEqual(expected);
  });

  it("routes 401 through unauthorized handling and returns an error result", async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401 }) as Response));
    await expect(fetchOlderHistory("w", "c", { session: "s", before: "e" })).resolves.toEqual({
      kind: "error", status: 401,
    });
    expect(handler).toHaveBeenCalledExactlyOnceWith();
  });

  it("classifies network and abort failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    await expect(fetchOlderHistory("w", "c", { session: "s", before: "e" })).resolves.toEqual({ kind: "error" });

    const controller = new AbortController();
    controller.abort();
    await expect(fetchOlderHistory("w", "c", { session: "s", before: "e" }, controller.signal)).resolves.toEqual({
      kind: "aborted",
    });
  });

  it("rejects malformed success payloads as errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ sessionId: "s", entries: "not-an-array", historyComplete: false }),
    }) as Response));
    await expect(fetchOlderHistory("w", "c", { session: "s", before: "e" })).resolves.toEqual({
      kind: "error", status: 200,
    });
  });
});
