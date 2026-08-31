import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  apiDownload,
  apiJson,
  apiRaw,
  apiVoid,
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
