import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, setUnauthorizedHandler } from "../../lib/api";
import { detectFileTrigger, listDir, searchFiles } from "./fileSearch";

function unauthorizedResponse(): Response {
  return {
    ok: false,
    status: 401,
    statusText: "Unauthorized",
    json: async () => {
      throw new SyntaxError("empty body");
    },
  } as unknown as Response;
}

afterEach(() => {
  setUnauthorizedHandler(undefined);
  vi.unstubAllGlobals();
});

describe("file search unauthorized handling", () => {
  it("routes a search 401 through the shared unauthorized handler", async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    vi.stubGlobal("fetch", vi.fn(async () => unauthorizedResponse()));

    await expect(searchFiles("/work", "notes")).rejects.toBeInstanceOf(ApiError);
    expect(handler).toHaveBeenCalledExactlyOnceWith();
  });

  it("routes a directory-list 401 through the shared unauthorized handler", async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    vi.stubGlobal("fetch", vi.fn(async () => unauthorizedResponse()));

    await expect(listDir("/work", "./docs/")).rejects.toMatchObject({ status: 401 });
    expect(handler).toHaveBeenCalledExactlyOnceWith();
  });
});

describe("detectFileTrigger", () => {
  it("detects @ at the start with a query at the caret", () => {
    expect(detectFileTrigger("@ses", 4)).toEqual({ start: 0, query: "ses" });
  });

  it("detects @ after a space mid-line", () => {
    expect(detectFileTrigger("see @ses", 8)).toEqual({ start: 4, query: "ses" });
  });

  it("returns null when @ is not at a word boundary", () => {
    expect(detectFileTrigger("foo@bar", 7)).toBeNull();
  });

  it("returns null when the char before the caret is a space", () => {
    expect(detectFileTrigger("see @ses ", 9)).toBeNull();
  });

  it("returns null with no @ before the caret", () => {
    expect(detectFileTrigger("hello", 5)).toBeNull();
  });

  it("handles an empty query right after @", () => {
    expect(detectFileTrigger("see @", 5)).toEqual({ start: 4, query: "" });
  });

  it("returns null at caret 0", () => {
    expect(detectFileTrigger("@x", 0)).toBeNull();
  });
});
