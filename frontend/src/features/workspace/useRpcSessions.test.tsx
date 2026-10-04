import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  rpcSessionAttemptKey,
  useRpcSessionOpenAttempts,
  useRpcSessions,
} from "./useRpcSessions";
import type { RpcSessionInfo } from "./rpcSessions";
import type { Workspace } from "./workspace";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function rpcItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: "rpc-5",
    durableSessionId: "01a1durable",
    sessionPath: "/abs/x.jsonl",
    cwd: "/abs/ws",
    name: "Headless fix",
    status: "idle",
    questions: [],
    messageCount: 1,
    updatedAt: 1790000000000,
    workspaceId: "ws-abc",
    ...overrides,
  };
}

function SessionsProbe({ enabled }: { readonly enabled: boolean }) {
  const sessions = useRpcSessions(enabled);
  return <output data-testid="sessions">{JSON.stringify(sessions)}</output>;
}

describe("useRpcSessions poller", () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;
  let pending: Deferred<Response>[];

  const fetchCount = (): number => fetchMock.mock.calls.length;
  const rendered = (): unknown => JSON.parse(
    container.querySelector<HTMLOutputElement>('[data-testid="sessions"]')?.textContent ?? "[]",
  );

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    pending = [];
    fetchMock = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      if (String(input) !== "/api/rpc-sessions") {
        return Promise.reject(new Error(`unexpected request: ${String(input)}`));
      }
      const request = deferred<Response>();
      pending.push(request);
      return request.promise;
    });
    vi.stubGlobal("fetch", fetchMock);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shares one in-flight poll across subscribers and stops with none", async () => {
    act(() => {
      root.render(
        <>
          <SessionsProbe enabled />
          <SessionsProbe enabled />
        </>,
      );
    });
    expect(fetchCount()).toBe(1);

    await act(async () => {
      pending[0]!.resolve(jsonResponse({ sessions: [rpcItem()] }));
      await pending[0]!.promise;
    });
    expect(rendered()).toEqual([
      expect.objectContaining({ sessionId: "rpc-5", status: "idle" }),
    ]);

    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(fetchCount()).toBe(2);
    await act(async () => {
      pending[1]!.resolve(jsonResponse({ sessions: [rpcItem()] }));
      await pending[1]!.promise;
    });

    act(() => root.unmount());
    await act(async () => { await vi.advanceTimersByTimeAsync(12000); });
    expect(fetchCount()).toBe(2);
  });

  it("keeps the previous snapshot when a poll fails", async () => {
    act(() => { root.render(<SessionsProbe enabled />); });
    await act(async () => {
      pending[0]!.resolve(jsonResponse({ sessions: [rpcItem()] }));
      await pending[0]!.promise;
    });

    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    await act(async () => {
      pending[1]!.resolve(new Response("boom", { status: 500 }));
      await pending[1]!.promise.catch(() => undefined);
    });
    expect(rendered()).toEqual([
      expect.objectContaining({ sessionId: "rpc-5" }),
    ]);

    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    await act(async () => {
      pending[2]!.resolve(jsonResponse({ sessions: [rpcItem({ sessionId: "rpc-9" })] }));
      await pending[2]!.promise;
    });
    expect(rendered()).toEqual([
      expect.objectContaining({ sessionId: "rpc-9" }),
    ]);
    expect(fetchCount()).toBe(3);
  });

  it("issues no requests while disabled", async () => {
    act(() => { root.render(<SessionsProbe enabled={false} />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(12000); });
    expect(fetchCount()).toBe(0);
    expect(rendered()).toEqual([]);
  });

  it("drops malformed items before publishing", async () => {
    act(() => { root.render(<SessionsProbe enabled />); });
    await act(async () => {
      pending[0]!.resolve(jsonResponse({ sessions: [rpcItem(), { sessionId: "" }, null] }));
      await pending[0]!.promise;
    });
    expect(rendered()).toEqual([
      expect.objectContaining({ sessionId: "rpc-5" }),
    ]);
  });
});

describe("useRpcSessionOpenAttempts", () => {
  let container: HTMLDivElement;
  let root: Root;

  const workspace: Workspace = { id: "ws-1", name: "Workspace", path: "/work", chats: [] };
  const rpc: RpcSessionInfo = {
    sessionId: "rpc-5",
    durableSessionId: "01a1durable",
    sessionPath: "/abs/x.jsonl",
    cwd: "/work",
    name: "Headless fix",
    status: "idle",
    questions: [],
    messageCount: 1,
    updatedAt: 0,
    workspaceId: "ws-1",
  };

  function AttemptsProbe({ onOpen }: { readonly onOpen: (ws: Workspace, rpc: RpcSessionInfo) => Promise<"opened" | "failed" | void> }) {
    const { attempts, open } = useRpcSessionOpenAttempts(onOpen);
    return (
      <button
        type="button"
        data-testid="open"
        data-state={attempts.get(rpcSessionAttemptKey("ws-1", "rpc-5")) ?? "none"}
        onClick={() => void open(workspace, rpc)}
      >
        open
      </button>
    );
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("marks opening, settles, and records failed for a rejected open", async () => {
    let reject!: (error: Error) => void;
    const gate = new Promise<"opened">((_resolve, done) => { reject = done; });
    const onOpen = vi.fn(() => gate);
    act(() => { root.render(<AttemptsProbe onOpen={onOpen} />); });

    const button = (): HTMLButtonElement => container.querySelector<HTMLButtonElement>('[data-testid="open"]')!;
    act(() => { button().click(); button().click(); });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(button().dataset["state"]).toBe("opening");

    await act(async () => { reject(new Error("open failed")); await gate.catch(() => undefined); });
    expect(button().dataset["state"]).toBe("failed");

    let resolveRetry!: (result: "opened") => void;
    const retry = new Promise<"opened">((done) => { resolveRetry = done; });
    onOpen.mockImplementation(() => retry);
    act(() => { button().click(); });
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(button().dataset["state"]).toBe("opening");
    await act(async () => { resolveRetry("opened"); await retry; });
    expect(button().dataset["state"]).toBe("none");
  });
});
