import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { connectChat, parseChatServerFrame } from "../../lib/chatWs";
import type { ChatHandlers } from "../../lib/chatWs";
import type { SessionsActivityFrame } from "../../lib/contract/types_gen";
import {
  __resetLiveBadgeStoreForTests, canonicalLiveSessionId, ingestExtensionEvent,
  useLiveAgentAggregates, useLiveBadgeOverrides,
} from "./liveBadgeStore";
import { liveDurableOwner } from "./liveSessionIdentity";
import type { LiveBadgeOverride } from "./liveBadgeStore";
import { useLiveSessionInfos } from "./useLiveSessions";
import type { LiveSessionInfo } from "./useLiveSessionsLean";

vi.mock("../../lib/chatWs", async (original) => ({
  ...await original<typeof import("../../lib/chatWs")>(),
  connectChat: vi.fn(),
}));

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let handlers: ChatHandlers | undefined;
let infos: readonly LiveSessionInfo[];
let aggregates: ReadonlyMap<string, { readonly running: number }>;
let overrides: ReadonlyMap<string, LiveBadgeOverride>;
let response: Promise<Response>;
let resolveResponse: (value: Response) => void = () => undefined;

function pendingResponse(): Promise<Response> {
  return new Promise((resolve) => { resolveResponse = resolve; });
}

function Host(): null {
  infos = useLiveSessionInfos(true);
  aggregates = useLiveAgentAggregates();
  overrides = useLiveBadgeOverrides();
  return null;
}

function push(id: string, durable: string, at: number, tasks: number, overflow: boolean, replaces?: string): void {
  const frame: SessionsActivityFrame = {
    type: "sessions.activity", sessionId: id, durableSessionId: durable,
    title: id, active: false, overflow, last_activity_ms: at,
    running: { agents: tasks, tasks, dag: 0 },
    ...(replaces === undefined ? {} : { replacesSessionId: replaces }),
  };
  const parsed = parseChatServerFrame(frame);
  if (parsed === null || handlers === undefined) throw new Error("Missing parsed frame or mounted hook");
  const target = handlers;
  act(() => target.onFrame(parsed));
}

function authority(id: string, revision: number): void {
  act(() => ingestExtensionEvent(id, "omo.dag.updated", { agent_running_count: 9, agent_total_count: 9 }, undefined, revision));
}

function rows(): readonly { readonly id: string; readonly tasks?: number }[] {
  return infos.map((info) => ({ id: info.id,
    ...(info.lean?.running?.tasks === undefined ? {} : { tasks: info.lean.running.tasks }),
  }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function settle(sessions: readonly unknown[]): Promise<void> {
  await act(async () => {
    resolveResponse(new Response(JSON.stringify({ sessions })));
    await response;
  });
}

async function beginNextPoll(): Promise<void> {
  response = pendingResponse();
  await act(async () => vi.advanceTimersToNextTimerAsync());
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  __resetLiveBadgeStoreForTests();
  handlers = undefined;
  infos = [];
  aggregates = new Map();
  overrides = new Map();
  response = pendingResponse();
  vi.stubGlobal("fetch", vi.fn(() => response));
  vi.mocked(connectChat).mockImplementation((next) => {
    handlers = next;
    return { send: vi.fn(), close: vi.fn() };
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(Host)));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  __resetLiveBadgeStoreForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each([false, true])("moves newer provisional ownership and authority (overflow=%s)", (overflow) => {
  push("X", "X", 100, 1, overflow);
  authority("X", 101);
  push("A", "X", 101, 1, overflow, "X");

  expect(rows()).toEqual([{ id: "A", tasks: 1 }]);
  expect(canonicalLiveSessionId("X")).toBe("A");
  expect(liveDurableOwner("X")).toBe("A");
  expect(aggregates.get("A")?.running).toBe(9);
});

it.each([false, true])("claims a provisional source missed by the overview (overflow=%s)", (overflow) => {
  authority("X", 1);
  push("A", "X", 200, 1, overflow, "X");

  expect(rows()).toEqual([{ id: "A", tasks: 1 }]);
  // PR #197 server contract: replacesSessionId names an unseen provisional
  // of the SAME durable when attached badge authority was observed at X.
  expect(canonicalLiveSessionId("X")).toBe("A");
  expect(liveDurableOwner("X")).toBe("A");
  expect(aggregates.get("A")?.running).toBe(9);
  expect(overrides.has("X")).toBe(false);
});

it.each([false, true])("keeps the higher-revision owner after a bare foreign row (overflow=%s)", async (overflow) => {
  push("A", "X", 100, 1, false);
  await settle([{ id: "A", title: "A", last_activity_ms: 300,
    running: { agents: 3, tasks: 3, dag: 0 } }]);
  authority("A", 301);
  push("B", "X", 200, 2, overflow);

  // The server's manager-wide clock makes A:X@300 newer than B:X@200,
  // even though B's own row has no previous receipt.
  expect(rows()).toEqual([{ id: "A", tasks: 3 }, { id: "B", tasks: 2 }]);
  expect(canonicalLiveSessionId("X")).toBe("X");
  expect(liveDurableOwner("X")).toBe("A");
  expect(aggregates.get("A")?.running).toBe(9);
  expect(aggregates.has("B")).toBe(false);
});

it.each([false, true])("fences pending provisional REST after same-durable claim (overflow=%s)", async (overflow) => {
  push("P", "P", 100, 5, false);
  await settle([{ id: "P", title: "P", last_activity_ms: 100, running: { tasks: 5 } }]);
  await beginNextPoll();
  // PR #197 server contract: P:P -> A:X replaces P is cross-durable and
  // rejected; claim the SAME durable P, then fence the in-flight P-era REST.
  push("A", "P", 200, 2, overflow, "P");
  await settle([{ id: "P", title: "P", last_activity_ms: 100, running: { tasks: 5 } }]);

  expect(rows()).toEqual([{ id: "A", tasks: 2 }]);
  expect(liveDurableOwner("P")).toBe("A");
  expect(canonicalLiveSessionId("P")).toBe("A");
});
