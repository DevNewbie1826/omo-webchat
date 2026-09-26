import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { connectChat, parseChatServerFrame } from "../../lib/chatWs";
import type { ChatHandlers } from "../../lib/chatWs";
import type { SessionsActivityFrame } from "../../lib/contract/types_gen";
import { parseTaskUpdated } from "../split/activityParse";
import {
  __resetLiveBadgeStoreForTests, canonicalLiveSessionId, ingestExtensionEvent,
  nextLiveActivitySequence, projectLiveTaskInfo, useLiveAgentAggregates,
} from "./liveBadgeStore";
import { LiveSessionMembership } from "./liveSessionMembership";
import { liveDurableOwner } from "./liveSessionIdentity";
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
let response: Promise<Response>;
let resolveResponse: (value: Response) => void = () => undefined;

function pendingResponse(): Promise<Response> {
  return new Promise((resolve) => { resolveResponse = resolve; });
}

function Host(): null {
  infos = useLiveSessionInfos(true);
  aggregates = useLiveAgentAggregates();
  return null;
}

function push(id: string, durable: string | undefined, at: number, tasks: number, overflow: boolean, replaces?: string): void {
  const input = {
    type: "sessions.activity", sessionId: id,
    ...(durable === undefined ? {} : { durableSessionId: durable }),
    title: id, active: false, overflow, last_activity_ms: at,
    running: { agents: tasks, tasks, dag: 0 },
    ...(replaces === undefined ? {} : { replacesSessionId: replaces }),
  };
  const parsed = parseChatServerFrame(input);
  if (parsed === null || handlers === undefined) throw new Error("Missing parsed frame or mounted hook");
  const target = handlers;
  act(() => target.onFrame(parsed));
}

function authority(id: string, revision: number, count = 9): void {
  act(() => ingestExtensionEvent(id, "omo.dag.updated", { agent_running_count: count, agent_total_count: count }, undefined, revision));
}

function snapshot(): object {
  return {
    rows: infos.map((info) => ({ id: info.id, tasks: info.lean?.running?.tasks })).sort((a, b) => a.id.localeCompare(b.id)),
    aliases: Object.fromEntries(["A", "B", "P", "X", "Y", "Z"].map((id) => [id, canonicalLiveSessionId(id)])),
    aggregates: [...aggregates],
  };
}

async function settle(sessions: readonly unknown[]): Promise<void> {
  await act(async () => {
    resolveResponse(new Response(JSON.stringify({ sessions })));
    await response;
  });
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  __resetLiveBadgeStoreForTests();
  handlers = undefined;
  infos = [];
  aggregates = new Map();
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

it.each([false, true])("newer REST revision settles an unobserved replacement destination (overflow=%s)", async (overflow) => {
  authority("X", 1);
  push("A", "X", 200, 2, overflow, "X");
  await settle([{ id: "A", title: "A old", last_activity_ms: 500, running: { tasks: 5 } }]);
  // A@500 is newer than the replacement A@200 regardless of request start.
  expect(infos.map((info) => ({ id: info.id, tasks: info.lean?.running?.tasks }))).toEqual([{ id: "A", tasks: 5 }]);
  expect(aggregates.get("A")?.running).toBe(9);
});

it.each([false, true])("bare rebind expires a formerly provisional alias without moving chat authority (overflow=%s)", (overflow) => {
  push("X", "X", 100, 1, false);
  push("A", "X", 200, 2, false, "X");
  authority("A", 201);
  push("B", "X", 300, 3, overflow);
  authority("X", 301, 7);
  // PR #197 contract: an alias lasts only while its claimed durable keeps
  // that owner. An attached X event is not a chat-keyed B overview frame.
  expect(canonicalLiveSessionId("X")).toBe("X");
  expect(liveDurableOwner("X")).toBe("B");
  expect(aggregates.get("A")?.running).toBe(9);
  expect(aggregates.has("B")).toBe(false);
  expect(aggregates.get("X")?.running).toBe(7);
});

it.each([false, true])("historical replacement without a durable cannot transfer another chat authority (overflow=%s)", (overflow) => {
  push("P", "P", 100, 1, false);
  push("A", "P", 200, 2, false, "P");
  authority("A", 201);
  const before = snapshot();
  const parsed = parseChatServerFrame({
    type: "sessions.activity", sessionId: "B", replacesSessionId: "P",
    overflow, last_activity_ms: 300, running: { tasks: 3 },
  });
  expect(parsed).toBeNull();
  if (parsed !== null && handlers !== undefined) {
    const target = handlers;
    act(() => target.onFrame(parsed));
  }
  expect(snapshot()).toEqual(before);
});

it.each([false, true])("historical bare durable REST cannot overwrite the current durable row (overflow=%s)", async (overflow) => {
  push("A", "X", 100, 1, false);
  push("A", "Y", 200, 2, overflow);
  await settle([{ id: "A", title: "A", last_activity_ms: 200, running: { tasks: 2 } }]);
  response = pendingResponse();
  await act(async () => vi.advanceTimersToNextTimerAsync());
  // PR #197: unowned X is its own provisional row. REST is a full list, so
  // include A to test its preservation rather than its membership removal.
  await settle([
    { id: "A", durableSessionId: "Y", title: "A", last_activity_ms: 200, running: { tasks: 2 } },
    { id: "X", durableSessionId: "X", title: "old durable X", last_activity_ms: 500, running: { tasks: 5 } },
  ]);
  expect(infos.map((info) => ({ id: info.id, tasks: info.lean?.running?.tasks }))
    .sort((a, b) => a.id.localeCompare(b.id))).toEqual([{ id: "A", tasks: 2 }, { id: "X", tasks: 5 }]);
  expect(liveDurableOwner("Y")).toBe("A");
  expect(liveDurableOwner("X")).toBe("X");
  expect(canonicalLiveSessionId("X")).toBe("X");
});

it.each([false, true])("rejects an owned durable REST identity and stale same-row push (overflow=%s)", async (overflow) => {
  push("A", "X", 100, 1, false);
  // PR #197 never emits X for a chat-owned X. The invalid row cannot update
  // A; its valid chat-keyed peer commits A's receipt independently.
  await settle([
    { id: "X", durableSessionId: "X", title: "invalid", last_activity_ms: 500, running: { tasks: 5 } },
    { id: "A", durableSessionId: "X", title: "A", last_activity_ms: 300, running: { tasks: 3 } },
  ]);
  expect(infos.map((info) => ({ id: info.id, tasks: info.lean?.running?.tasks }))).toEqual([{ id: "A", tasks: 3 }]);
  authority("A", 301);
  push("A", "X", 200, 2, overflow);
  expect(infos.map((info) => ({ id: info.id, tasks: info.lean?.running?.tasks }))).toEqual([{ id: "A", tasks: 3 }]);
  expect(liveDurableOwner("X")).toBe("A");
  expect(canonicalLiveSessionId("X")).toBe("X");
});

it.each([false, true])("commits provisional durable REST freshness before stale same-row push (overflow=%s)", async (overflow) => {
  push("X", "X", 100, 1, false);
  await settle([{ id: "X", durableSessionId: "X", title: "X",
    last_activity_ms: 300, running: { tasks: 3 } }]);
  authority("X", 301);
  push("X", "X", 200, 2, overflow);
  expect(infos.map((info) => ({ id: info.id, tasks: info.lean?.running?.tasks })))
    .toEqual([{ id: "X", tasks: 3 }]);
  expect(aggregates.get("X")?.running).toBe(9);
  expect(aggregates.has("A")).toBe(false);
  expect(liveDurableOwner("X")).toBe("X");
});

it.each([false, true])("r1 rich pending Y settlement cannot replace X task authority (overflow=%s)", (overflow) => {
  const membership = new LiveSessionMembership();
  const localPush = (durableSessionId: string, at: number): void => {
    const frame: SessionsActivityFrame = {
      type: "sessions.activity", sessionId: "A", durableSessionId,
      title: "A", active: false, overflow, last_activity_ms: at,
    };
    act(() => membership.push(frame, nextLiveActivitySequence()));
  };
  const richRow = (at: number, count: number): LiveSessionInfo => ({
    id: "A", title: "A", dag: null, lean: { last_activity_ms: at },
    task: { tasks: Array.from({ length: count }, (_, index) => ({
      task_id: `task-${index}`, name: `Task ${index}`, status: "running",
      updated_at: "2026-09-26T10:00:00.000Z",
    })) },
  });
  const taskCount = (): number => {
    const info = projectLiveTaskInfo({ id: "A", title: "A", task: null });
    return parseTaskUpdated(info.task)?.tasks.length ?? 0;
  };
  localPush("X", 100);
  localPush("Y", 200);
  const pending = nextLiveActivitySequence();
  localPush("X", 300);
  act(() => membership.poll([richRow(200, 2)], pending));
  expect(taskCount()).toBe(0);
  act(() => membership.poll([richRow(400, 1)], nextLiveActivitySequence()));
  expect(taskCount()).toBe(1);
});
