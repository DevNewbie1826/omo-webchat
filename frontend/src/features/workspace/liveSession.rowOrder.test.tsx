import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { connectChat, parseChatServerFrame } from "../../lib/chatWs";
import type { ChatHandlers } from "../../lib/chatWs";
import { __resetLiveBadgeStoreForTests, canonicalLiveSessionId, ingestExtensionEvent, useLiveAgentAggregates, useMergedLiveSummaries } from "./liveBadgeStore";
import { __liveIdentitySnapshotForTests } from "./liveSessionIdentity";
import { LiveSessionList } from "./LiveSessionList";
import { useLiveSessionSummaries } from "./useLiveSessionSummaries";
import { useLiveSessionInfos } from "./useLiveSessions";
import type { LiveSessionInfo } from "./useLiveSessionsLean";
import type { Workspace } from "./workspace";

vi.mock("../../lib/chatWs", async (original) => ({
  ...await original<typeof import("../../lib/chatWs")>(),
  connectChat: vi.fn(),
}));

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let handlers: ChatHandlers | undefined;
let infos: readonly LiveSessionInfo[];
let aggregates: ReadonlyMap<string, { readonly running: number }>;
let resolveResponse: (value: Response) => void = () => undefined;
let response: Promise<Response>;
const workspaces: readonly Workspace[] = [{
  id: "workspace", name: "Workspace", path: "/tmp",
  chats: [{ id: "A", name: "A", provider: "omo" }, { id: "B", name: "B", provider: "omo" }],
}];

function pendingResponse(): Promise<Response> {
  return new Promise((resolve) => { resolveResponse = resolve; });
}

function Host() {
  infos = useLiveSessionInfos(true);
  aggregates = useLiveAgentAggregates();
  const summaries = useMergedLiveSummaries(useLiveSessionSummaries(true));
  const props = {
    summaries, workspaces, sessionLists: new Map(),
    onSelect: () => undefined, onOpen: async () => "opened" as const,
  };
  return createElement("div", null,
    createElement(LiveSessionList, { ...props, listClassName: "pinned" }),
    createElement(LiveSessionList, { ...props, listClassName: "home" }));
}

function push(id: string, durable: string, revision: number, tasks: number, overflow: boolean, replaces?: string): void {
  const parsed = parseChatServerFrame({
    type: "sessions.activity", sessionId: id, durableSessionId: durable,
    last_activity_ms: revision, title: id, active: false, overflow,
    running: { agents: tasks, tasks, dag: 0 },
    ...(replaces === undefined ? {} : { replacesSessionId: replaces }),
  });
  if (parsed === null || handlers === undefined) throw new Error("Missing captured publication or mounted hook");
  const target = handlers;
  act(() => target.onFrame(parsed));
}

async function settle(sessions: readonly unknown[]): Promise<void> {
  await act(async () => {
    resolveResponse(new Response(JSON.stringify({ sessions })));
    await response;
  });
}

function snapshot() {
  return {
    rows: infos.map((info) => ({
      id: info.id, durable: info.durableSessionId,
      tasks: info.lean?.running?.tasks, receipt: info.lean?.last_activity_ms,
    })),
    identity: __liveIdentitySnapshotForTests(),
    authority: [...aggregates],
    badges: [...container.querySelectorAll(".th-overview-card-running")].map((element) => element.textContent),
  };
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  __resetLiveBadgeStoreForTests();
  infos = [];
  aggregates = new Map();
  handlers = undefined;
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

it.each([false, true])("rejects a delayed different-durable publication after REST (overflow=%s)", async (overflow) => {
  // Server ordering: A:X -> queued A:Y -> cursor X -> REST A:X -> delayed A:Y.
  push("A", "X", 1790422906297, 1, false);
  await settle([{ id: "A", durableSessionId: "X", title: "A", active: false,
    last_activity_ms: 1790422906323, running: { agents: 1, tasks: 1 } }]);
  act(() => ingestExtensionEvent("A", "omo.dag.updated", { agent_running_count: 9 }, undefined, 1790422906324));
  const before = snapshot();
  expect(before.badges).toEqual(["1", "1"]);

  push("A", "Y", 1790422906311, 2, overflow);

  expect(snapshot()).toEqual(before);
});

it.each([false, true])("REST cursor change releases provisional alias and authority (overflow=%s)", async (overflow) => {
  // Captured server order: Y:Y, X:X, A:X replaces X; REST alone moves A to Y.
  push("Y", "Y", 1790422906368, 2, overflow);
  push("X", "X", 1790422906369, 1, overflow);
  push("A", "X", 1790422906384, 1, overflow, "X");
  await settle([]);
  response = pendingResponse();
  await act(async () => vi.advanceTimersToNextTimerAsync());
  act(() => ingestExtensionEvent("A", "omo.dag.updated", { agent_running_count: 9 }, undefined, 1790422906385));

  await settle([{ id: "A", durableSessionId: "Y", title: "A", active: false,
    last_activity_ms: 1790422906397, running: { agents: 2, tasks: 2 } }]);

  const state = snapshot();
  expect(state.rows[0]?.tasks).toBe(2);
  expect({ durable: state.rows[0]?.durable, owners: state.identity.owners,
    alias: canonicalLiveSessionId("X"), authority: state.authority,
  }).toEqual({ durable: "Y", owners: { Y: "A" }, alias: "X", authority: [] });
  expect(state.badges).toEqual(["2", "2"]);
});

it.each([false, true])("accepts newer REST rows from requests preceding a cursor change (overflow=%s)", async (overflow) => {
  push("A", "X", 1790424517367, 1, false);
  push("A", "Y", 1790424517376, 2, overflow);
  expect(snapshot().rows[0]?.tasks).toBe(2);

  await settle([{ id: "A", durableSessionId: "Y", title: "A", active: false,
    last_activity_ms: 1790424517378, running: { agents: 3, tasks: 3, dag: 0 } }]);

  expect(snapshot().rows[0]?.tasks).toBe(3);
  expect(snapshot().badges).toEqual(["3", "3"]);
});

it.each([false, true])("rejects a replacement superseded by REST returning its source (overflow=%s)", async (overflow) => {
  push("A", "X", 1790425044797, 1, false);
  await settle([{ id: "A", durableSessionId: "X", title: "A", active: false,
    last_activity_ms: 1790425044831, running: { agents: 2, tasks: 2, dag: 0 } }]);
  act(() => ingestExtensionEvent("A", "omo.dag.updated", { agent_running_count: 9 }, undefined, 1790425044832));
  const before = snapshot();

  push("B", "X", 1790425044815, 2, overflow, "A");

  expect(snapshot()).toEqual(before);
});

it.each([false, true])("retains a retired row watermark against queued publications (overflow=%s)", async (overflow) => {
  push("A", "X", 1790424775295, 1, false);
  await settle([]);
  response = pendingResponse();
  await act(async () => vi.advanceTimersToNextTimerAsync());
  await settle([{ id: "A", durableSessionId: "Y", title: "A", active: false,
    last_activity_ms: 1790424775305, running: { agents: 3, tasks: 3, dag: 0 } }]);
  expect(snapshot().rows[0]?.tasks).toBe(3);
  response = pendingResponse();
  await act(async () => vi.advanceTimersToNextTimerAsync());
  await settle([{ id: "B", durableSessionId: "X", title: "B", active: false,
    last_activity_ms: 1790424775327, running: { agents: 2, tasks: 2, dag: 0 } }]);
  act(() => ingestExtensionEvent("B", "omo.dag.updated", { agent_running_count: 9 }, undefined, 1790424775328));
  const before = snapshot();
  expect(before.rows.map((row) => row.id)).toEqual(["B"]);

  push("A", "X", 1790424775297, 2, overflow);

  expect(snapshot()).toEqual(before);
});
