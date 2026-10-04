import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api";
import { listRpcSessions, openRpcSession } from "./rpcSessions";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const validItem = {
  sessionId: "rpc-5",
  durableSessionId: "01a1durable",
  sessionPath: "/abs/x.jsonl",
  cwd: "/abs/ws",
  name: "Headless fix",
  status: "blocked",
  questions: ["Pick one?"],
  messageCount: 3,
  updatedAt: 1790000000000,
  closedAt: 1790000001000,
  workspaceId: "ws-abc",
  chatId: "chat-123",
};

describe("rpcSessions client", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  describe("listRpcSessions", () => {
    it("returns parsed sessions and drops malformed items", async () => {
      fetchMock.mockResolvedValue(jsonResponse({
        sessions: [
          validItem,
          { ...validItem, sessionId: "rpc-missing-status", status: "exploded" },
          { ...validItem, sessionId: "" },
          { ...validItem, sessionId: "rpc-no-ws", workspaceId: "" },
          "not-an-object",
          null,
          {
            sessionId: "rpc-minimal",
            durableSessionId: "01a1min",
            sessionPath: "/abs/m.jsonl",
            cwd: "/abs/ws",
            status: "idle",
            workspaceId: "ws-abc",
            questions: ["ok", 7, null],
          },
        ],
      }));

      const sessions = await listRpcSessions();

      expect(sessions).toHaveLength(2);
      expect(sessions[0]).toEqual({
        sessionId: "rpc-5",
        durableSessionId: "01a1durable",
        sessionPath: "/abs/x.jsonl",
        cwd: "/abs/ws",
        name: "Headless fix",
        status: "blocked",
        questions: ["Pick one?"],
        messageCount: 3,
        updatedAt: 1790000000000,
        closedAt: 1790000001000,
        workspaceId: "ws-abc",
        chatId: "chat-123",
      });
      expect(sessions[1]).toEqual({
        sessionId: "rpc-minimal",
        durableSessionId: "01a1min",
        sessionPath: "/abs/m.jsonl",
        cwd: "/abs/ws",
        name: "",
        status: "idle",
        questions: ["ok"],
        messageCount: 0,
        updatedAt: 0,
        workspaceId: "ws-abc",
      });
      const [path, init] = fetchMock.mock.calls[0]!;
      expect(path).toBe("/api/rpc-sessions");
      expect(init?.method ?? "GET").toBe("GET");
    });

    it("throws a TypeError on a malformed envelope", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ sessions: "nope" }));
      await expect(listRpcSessions()).rejects.toBeInstanceOf(TypeError);
    });

    it("forwards the abort signal", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ sessions: [] }));
      const ctrl = new AbortController();
      await listRpcSessions(ctrl.signal);
      expect(fetchMock.mock.calls[0]![1]?.signal).toBe(ctrl.signal);
    });
  });

  describe("openRpcSession", () => {
    it("posts the session id and returns the opened chat", async () => {
      const chat = { id: "chat-9", name: "Headless fix", provider: "omo" };
      fetchMock.mockResolvedValue(jsonResponse(chat, 201));

      const opened = await openRpcSession("ws-abc", "rpc-5");

      expect(opened).toEqual(chat);
      const [path, init] = fetchMock.mock.calls[0]!;
      expect(path).toBe("/api/workspaces/ws-abc/rpc-sessions/open");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ sessionId: "rpc-5" });
    });

    it("propagates 404 when the session is absent or closed", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ error: "rpc session not found" }, 404));

      const failure = await openRpcSession("ws-abc", "rpc-gone").catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ApiError);
      expect((failure as ApiError).status).toBe(404);
    });

    it("rejects an invalid chat payload instead of passing it downstream", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ id: 7 }, 200));

      const failure = await openRpcSession("ws-abc", "rpc-5").catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ApiError);
      expect((failure as ApiError).status).toBe(200);
    });
  });
});
