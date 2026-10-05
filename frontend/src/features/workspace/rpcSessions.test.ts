import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { useRpcSessions, type UseRpcSessionsResult } from "./useRpcSessions";
import { translate } from "../../i18n";
import type { Translate } from "../../i18n";
import type { Terminal } from "./workspace";
import {
  formatRpcLiveRecency,
  listWorkspaceRpcLiveSessions,
  openRpcLiveSession,
  parseRpcLiveSection,
  parseRpcLiveSession,
  partitionRpcLiveSessions,
  rpcLiveAliasChatId,
  rpcLiveCompatibleDurable,
  rpcSessionIdentityMatches,
  type RpcLiveSession,
} from "./rpcSessions";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const t: Translate = (key, params) => (params !== undefined && "n" in params ? `${key}=${params["n"]}` : key);

const fullRow: RpcLiveSession = {
  sessionId: "sess-1",
  durableSessionId: "durable-1",
  sessionPath: "/s/one.jsonl",
  cwd: "/work",
  name: "Foreign run",
  status: "working",
  questions: ["pick one"],
  updatedAt: 1_800_000,
  messageCount: 7,
};

describe("parseRpcLiveSession", () => {
  it("accepts a complete row", () => {
    expect(parseRpcLiveSession(fullRow)).toEqual(fullRow);
  });

  it("accepts a minimal row with defaulted optionals", () => {
    expect(parseRpcLiveSession({
      sessionId: "sess-2",
      sessionPath: "/s/two.jsonl",
      status: "idle",
      questions: [],
      updatedAt: 0,
    })).toEqual({
      sessionId: "sess-2",
      durableSessionId: "",
      sessionPath: "/s/two.jsonl",
      cwd: "",
      name: "",
      status: "idle",
      questions: [],
      updatedAt: 0,
      messageCount: 0,
    });
  });

  it.each([
    ["non-record", null],
    ["string", "sess"],
    ["array", [fullRow]],
    ["missing sessionId", { ...fullRow, sessionId: undefined }],
    ["empty sessionId", { ...fullRow, sessionId: "" }],
    ["missing sessionPath", { ...fullRow, sessionPath: undefined }],
    ["unknown status", { ...fullRow, status: "running" }],
    ["questions not an array", { ...fullRow, questions: "pick one" }],
    ["updatedAt missing", { ...fullRow, updatedAt: undefined }],
    ["updatedAt negative", { ...fullRow, updatedAt: -1 }],
    ["updatedAt fractional", { ...fullRow, updatedAt: 1.5 }],
  ])("drops malformed row: %s", (_label, value) => {
    expect(parseRpcLiveSession(value)).toBeNull();
  });

  it("filters non-string questions instead of dropping the row", () => {
    expect(parseRpcLiveSession({ ...fullRow, questions: ["a", 5, null, "b"] }))
      .toEqual({ ...fullRow, questions: ["a", "b"] });
  });
});

describe("parseRpcLiveSection", () => {
  it("returns an empty list for a missing or non-array section", () => {
    expect(parseRpcLiveSection(undefined)).toEqual([]);
    expect(parseRpcLiveSection(null)).toEqual([]);
    expect(parseRpcLiveSection({ live: fullRow })).toEqual([]);
  });

  it("keeps only well-formed rows, preserving order", () => {
    expect(parseRpcLiveSection([fullRow, { bad: true }, { ...fullRow, sessionId: "sess-2" }]))
      .toEqual([fullRow, { ...fullRow, sessionId: "sess-2" }]);
  });
});

describe("rpcLiveCompatibleDurable", () => {
  it("treats equal or either-unknown ids as compatible", () => {
    expect(rpcLiveCompatibleDurable("a", "a")).toBe(true);
    expect(rpcLiveCompatibleDurable("", "a")).toBe(true);
    expect(rpcLiveCompatibleDurable("a", "")).toBe(true);
    expect(rpcLiveCompatibleDurable("", "")).toBe(true);
  });

  it("treats two known different ids as a conflict", () => {
    expect(rpcLiveCompatibleDurable("a", "b")).toBe(false);
  });
});

describe("rpcSessionIdentityMatches with server-normalized paths", () => {
  it("matches the same durable id via /tmp and /private/tmp using the comparison path", () => {
    const row = parseRpcLiveSession({
      ...fullRow, sessionPath: "/tmp/one.jsonl", comparisonPath: "/private/tmp/one.jsonl",
    });
    expect(row?.sessionPath).toBe("/private/tmp/one.jsonl");
    expect(rpcSessionIdentityMatches("/private/tmp/one.jsonl", "durable-1", row?.sessionPath ?? "", "durable-1")).toBe(true);
    expect(rpcLiveAliasChatId(row ?? fullRow, bindings([["durable-1", "chat-a", "/private/tmp/one.jsonl"]]))).toBe("chat-a");
  });

  it("keeps different durable ids distinct at the same normalized path", () => {
    expect(rpcSessionIdentityMatches("/private/tmp/one.jsonl", "durable-1", "/private/tmp/one.jsonl", "durable-2")).toBe(false);
  });

});

const rowA: RpcLiveSession = { ...fullRow, sessionId: "sess-a", sessionPath: "/s/a.jsonl", updatedAt: 10 };
const rowA2: RpcLiveSession = { ...rowA, sessionId: "sess-a2", durableSessionId: "durable-2", updatedAt: 30 };
const rowB: RpcLiveSession = { ...fullRow, sessionId: "sess-b", sessionPath: "/s/b.jsonl", updatedAt: 20 };

function bindings(entries: readonly (readonly [string, string, string])[]): ReadonlyMap<string, { readonly chatId: string; readonly path: string }> {
  return new Map(entries.map(([durable, chatId, path]) => [durable, { chatId, path }]));
}

describe("rpcLiveAliasChatId", () => {
  it("aliases a same-path compatible-durable row into its bound chat", () => {
    expect(rpcLiveAliasChatId(rowA, bindings([["durable-1", "chat-a", "/s/a.jsonl"]]))).toBe("chat-a");
  });

  it("folds lexical path aliases only when durable ids are compatible", () => {
    const binding = bindings([["durable-1", "chat-a", "/s/nested/../a.jsonl"]]);
    expect(rpcLiveAliasChatId(rowA, binding)).toBe("chat-a");
    expect(rpcLiveAliasChatId(rowA2, binding)).toBeUndefined();
  });

  it("aliases when either side recorded no durable id, on the same path", () => {
    expect(rpcLiveAliasChatId({ ...rowA, durableSessionId: "" }, bindings([["durable-1", "chat-a", "/s/a.jsonl"]]))).toBe("chat-a");
    expect(rpcLiveAliasChatId(rowA, bindings([["", "chat-a", "/s/a.jsonl"]]))).toBe("chat-a");
  });

  it("never merges on durable id alone at a different path", () => {
    expect(rpcLiveAliasChatId({ ...rowA, sessionPath: "/s/other.jsonl" }, bindings([["durable-1", "chat-a", "/s/a.jsonl"]]))).toBeUndefined();
  });

  it("renders a conflicting-durable same-path row beside the chat instead of folding", () => {
    expect(rpcLiveAliasChatId(rowA2, bindings([["durable-1", "chat-a", "/s/a.jsonl"]]))).toBeUndefined();
  });

  it("ignores bindings without a path", () => {
    expect(rpcLiveAliasChatId(rowA, bindings([["durable-1", "chat-a", ""]]))).toBeUndefined();
  });
});

describe("partitionRpcLiveSessions", () => {
  it("keeps unbound rows visible, ordered by updatedAt descending", () => {
    const result = partitionRpcLiveSessions([rowA, rowB], new Map());
    expect(result.visible.map((row) => row.sessionId)).toEqual(["sess-b", "sess-a"]);
    expect(result.byChatId.size).toBe(0);
  });

  it("folds compatible rows into byChatId and keeps conflicts visible", () => {
    const result = partitionRpcLiveSessions(
      [rowA, rowA2, rowB],
      bindings([["durable-1", "chat-a", "/s/a.jsonl"]]),
    );
    expect(result.byChatId.get("chat-a")).toEqual(rowA);
    expect(result.visible.map((row) => row.sessionId)).toEqual(["sess-a2", "sess-b"]);
  });
});

describe("formatRpcLiveRecency", () => {
  const now = 1_000_000_000;

  it("buckets the elapsed time with i18n keys", () => {
    expect(formatRpcLiveRecency(now - 30_000, now, t)).toBe("sidebar.live.recencyNow");
    expect(formatRpcLiveRecency(now - 5 * 60_000, now, t)).toBe("sidebar.live.recencyMinutes=5");
    expect(formatRpcLiveRecency(now - 3 * 3_600_000, now, t)).toBe("sidebar.live.recencyHours=3");
    expect(formatRpcLiveRecency(now - 2 * 86_400_000, now, t)).toBe("sidebar.live.recencyDays=2");
  });

  it("clamps future timestamps to just-now", () => {
    expect(formatRpcLiveRecency(now + 60_000, now, t)).toBe("sidebar.live.recencyNow");
  });
});

describe("listWorkspaceRpcLiveSessions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches the workspace sessions endpoint and keeps only well-formed live rows", async () => {
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        Promise.resolve(jsonResponse({ items: [], nextCursor: "", live: [fullRow, { bad: true }] })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const snapshot = await listWorkspaceRpcLiveSessions("ws-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe("/api/workspaces/ws-1/sessions?limit=5");
    expect(snapshot).toEqual({ live: [fullRow], items: [] });
  });

  it("returns an empty list when the backend omits the live section", async () => {
    vi.stubGlobal("fetch", vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        Promise.resolve(jsonResponse({ items: [], nextCursor: "" })),
    ));
    expect(await listWorkspaceRpcLiveSessions("ws-1")).toEqual({ live: [], items: [] });
  });

  it.each(["blocked", "unbound"])("refreshes the sixth bound row through the next cursor when %s", async (state) => {
    const firstFive = Array.from({ length: 5 }, (_, i) => ({
      id: `chat-${i}`, source: "stored", live: { status: "idle", questions: [] },
    }));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ items: firstFive, nextCursor: "page-two", live: [] }))
      .mockResolvedValueOnce(jsonResponse({ items: [{
        id: "chat-5", source: "stored",
        ...(state === "blocked" ? { live: { status: "blocked", questions: ["choose"] } } : {}),
      }], nextCursor: "", live: [] }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let current: UseRpcSessionsResult | undefined;
    function Harness(): null {
      current = useRpcSessions();
      return null;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => { root.render(createElement(Harness)); });
      act(() => current?.applyRows("ws-1", [], [{
        id: "chat-5", source: "stored", live: { status: "working", questions: [] },
      }]));
      const snapshot = await listWorkspaceRpcLiveSessions("ws-1");
      act(() => current?.applyRows("ws-1", snapshot.live, snapshot.items));
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(String(fetchMock.mock.calls[1]?.[0])).toBe("/api/workspaces/ws-1/sessions?limit=5&cursor=page-two");
      expect(snapshot.items).toHaveLength(6);
      expect(current?.boundByWs.get("ws-1")?.get("chat-5")).toEqual(
        state === "blocked" ? { status: "blocked", questions: ["choose"] } : undefined,
      );
    } finally {
      act(() => root.unmount());
    }
  });
});

describe("openRpcLiveSession", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the session id and returns the activated chat", async () => {
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        Promise.resolve(jsonResponse({ id: "chat-1", name: "Alpha", provider: "omo" }, 201)),
    );
    vi.stubGlobal("fetch", fetchMock);
    const chat: Terminal = await openRpcLiveSession("ws-1", "sess-a");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe("/api/workspaces/ws-1/rpc-sessions/open");
    expect(fetchMock.mock.calls[0]![1]?.method).toBe("POST");
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({ sessionId: "sess-a" });
    expect(chat).toEqual({ id: "chat-1", name: "Alpha", provider: "omo" });
  });

  it("rejects a malformed chat payload", async () => {
    vi.stubGlobal("fetch", vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        Promise.resolve(jsonResponse({ name: "no id" })),
    ));
    await expect(openRpcLiveSession("ws-1", "sess-a")).rejects.toMatchObject({ name: "ApiError", status: 200 });
  });
});

describe("rpc live i18n keys", () => {
  it.each([
    "sidebar.live.blocked",
    "sidebar.live.recencyNow",
    "sidebar.live.recencyMinutes",
    "sidebar.live.recencyHours",
    "sidebar.live.recencyDays",
  ])("resolves in ko and en through the translator: %s", (key) => {
    expect(translate("en", key)).not.toBe(key);
    expect(translate("ko", key)).not.toBe(key);
  });

  it("renders the relative-time placeholders in both locales", () => {
    expect(translate("en", "sidebar.live.recencyMinutes", { n: 5 })).toBe("5m ago");
    expect(translate("ko", "sidebar.live.recencyMinutes", { n: 5 })).toBe("5분 전");
    expect(translate("en", "sidebar.live.recencyHours", { n: 3 })).toBe("3h ago");
    expect(translate("ko", "sidebar.live.recencyDays", { n: 2 })).toBe("2일 전");
    expect(translate("en", "sidebar.live.recencyNow")).toBe("just now");
  });

  it("renders the blocked pill copy in both locales", () => {
    expect(translate("en", "sidebar.live.blocked")).toBe("Question waiting");
    expect(translate("ko", "sidebar.live.blocked")).toBe("질문 대기");
  });
});
