import { afterEach, describe, expect, it, vi } from "vitest";
import { createTerminal, fsCreateFolder } from "./terminal";

describe("createTerminal", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends one explicit provider, an optional resume identity, and never a model", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(
      JSON.stringify({ id: "chat-1", name: "chat", provider: "omo" }),
      { status: 201 },
    ));
    vi.stubGlobal("fetch", fetchMock);

    await createTerminal("ws-1", "", "omo");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe("/api/workspaces/ws-1/chats");
    expect(JSON.parse(String(init?.body))).toEqual({ name: "", provider: "omo" });
    expect(String(init?.body)).not.toContain("model");

    await createTerminal("ws-1", "Disk session", "omo", "/sessions/disk.jsonl");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [resumePath, resumeInit] = fetchMock.mock.calls[1]!;
    expect(resumePath).toBe("/api/workspaces/ws-1/chats");
    expect(JSON.parse(String(resumeInit?.body))).toEqual({
      name: "Disk session",
      provider: "omo",
      resumeIdentity: "/sessions/disk.jsonl",
    });
    expect(String(resumeInit?.body)).not.toContain("model");
  });
});

describe("fsCreateFolder", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("posts the parent path and leaf name to the mkdir endpoint", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(
      JSON.stringify({ path: "/work/new" }),
      { status: 201 },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const created = await fsCreateFolder("/work", "new");

    expect(created).toEqual({ path: "/work/new" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe("/api/fs/mkdir");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ path: "/work", name: "new" });
  });
});
