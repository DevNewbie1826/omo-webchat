import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { connectChat, parseChatServerFrame } from "../../lib/chatWs";
import type { ChatHandlers } from "../../lib/chatWs";
import {
  __resetLiveBadgeStoreForTests, ingestExtensionEvent, useLiveAgentAggregates, useMergedLiveSummaries,
} from "./liveBadgeStore";
import { __liveIdentitySnapshotForTests } from "./liveSessionIdentity";
import { LiveSessionList } from "./LiveSessionList";
import { useLiveSessionInfos } from "./useLiveSessions";
import { useLiveSessionSummaries } from "./useLiveSessionSummaries";
import type { LiveSessionInfo } from "./useLiveSessionsLean";
import type { Workspace } from "./workspace";

vi.mock("../../lib/chatWs", async (original) => ({
  ...await original<typeof import("../../lib/chatWs")>(),
  connectChat: vi.fn(),
}));

const workspaces: readonly Workspace[] = [{
  id: "workspace", name: "Workspace", path: "/tmp",
  chats: ["A", "B", "C"].map((id) => ({ id, name: id, provider: "omo" })),
}];
const wire = (id: string, revision: number, tasks: number, replaces?: string) => ({
  type: "sessions.activity", sessionId: id, durableSessionId: "X",
  last_activity_ms: revision, active: false, title: id,
  running: { agents: tasks, tasks, dag: 0 },
  ...(replaces === undefined ? {} : { replacesSessionId: replaces }),
});
const rest = (id: string, revision: number) => ({
  id, durableSessionId: "X", last_activity_ms: revision, active: false,
  title: id, running: { agents: 2, tasks: 2, dag: 0 },
});

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let handlers: ChatHandlers;
let infos: readonly LiveSessionInfo[];
let aggregates: ReadonlyMap<string, { readonly running: number }>;
let response: Promise<Response>;
let resolveResponse: (value: Response) => void;
function deferResponse(): void {
  response = new Promise((resolve) => { resolveResponse = resolve; });
}
function Host() {
  infos = useLiveSessionInfos(true);
  aggregates = useLiveAgentAggregates();
  const summaries = useMergedLiveSummaries(useLiveSessionSummaries(true));
  const props = {
    summaries, workspaces, sessionLists: new Map(), onSelect: () => undefined,
    onOpen: async () => "opened" as const,
  };
  return createElement("div", null,
    createElement(LiveSessionList, { ...props, listClassName: "pinned" }),
    createElement(LiveSessionList, { ...props, listClassName: "home" }));
}
function push(fields: object, overflow: boolean): void {
  const parsed = parseChatServerFrame({ ...fields, overflow });
  if (parsed === null) throw new TypeError("Invalid captured publication");
  act(() => handlers.onFrame(parsed, 1));
}
async function settle(sessions: readonly object[], instanceId: string): Promise<void> {
  await act(async () => {
    resolveResponse(new Response(JSON.stringify({ instanceId, sessions })));
    await response;
  });
}
async function start(instanceId: string): Promise<void> {
  act(() => handlers.onHello?.(instanceId, 1));
  await settle([], instanceId);
  deferResponse();
  await act(async () => vi.advanceTimersByTimeAsync(4000));
  expect(fetch).toHaveBeenCalledTimes(2);
}
function snapshot() {
  return {
    rows: infos.map((info) => ({ id: info.id, durable: info.durableSessionId,
      revision: info.lean?.last_activity_ms, tasks: info.lean?.running?.tasks })),
    identity: __liveIdentitySnapshotForTests(),
    authority: [...aggregates],
    badges: [...container.querySelectorAll(".th-overview-card-running")].map((el) => el.textContent),
  };
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  __resetLiveBadgeStoreForTests();
  deferResponse();
  vi.stubGlobal("fetch", vi.fn(() => response));
  vi.mocked(connectChat).mockImplementation((next) => {
    handlers = next;
    next.onAttempt?.(1);
    return { send: vi.fn(), close: vi.fn() };
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(Host)));
  act(() => handlers.onOpen?.(1));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  __resetLiveBadgeStoreForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each([false, true])("keeps newer C ownership after delayed B replaces A (overflow=%s)", async (overflow) => {
  // Captured server order: A:X@7953 -> B:X@7971 replaces A -> REST C:X@7987 -> delayed B.
  await start("L5VWTR7WQLTIFLG7J3MO3NBSIS");
  push(wire("A", 1790432367953, 1), false);
  await settle([rest("C", 1790432367987)], "L5VWTR7WQLTIFLG7J3MO3NBSIS");
  act(() => ingestExtensionEvent("C", "omo.dag.updated", { agent_running_count: 9 },
    undefined, 1790432367988));
  const before = snapshot();
  expect(before.identity.owners).toEqual({ X: "C" });

  push(wire("B", 1790432367971, 2, "A"), overflow);

  expect(snapshot()).toEqual(before);
  expect(aggregates.get("C")?.running).toBe(9);
});

it.each([false, true])("keeps X to A alias when older bare B row arrives (overflow=%s)", async (overflow) => {
  // Captured: X:X@8020 -> A:X@8030 replaces X -> REST A:X@8069 -> delayed B:X@8052.
  await start("I2NKSWUFFD7POXZSLWHYPLDMAR");
  push(wire("X", 1790432368020, 1), false);
  push(wire("A", 1790432368030, 1, "X"), false);
  await settle([rest("A", 1790432368069)], "I2NKSWUFFD7POXZSLWHYPLDMAR");
  act(() => ingestExtensionEvent("A", "omo.dag.updated", { agent_running_count: 9 },
    undefined, 1790432368070));
  const before = snapshot();
  expect(before.identity.owners).toEqual({ X: "A" });
  expect(before.identity.aliases).toEqual({ X: "A" });

  push(wire("B", 1790432368052, 2), overflow);

  const after = snapshot();
  expect(after.identity.owners).toEqual(before.identity.owners);
  expect(after.identity.aliases).toEqual(before.identity.aliases);
  expect(aggregates.get("A")?.running).toBe(9);
});

it.each([false, true])("admits replacement newer than a third durable owner (overflow=%s)", async (overflow) => {
  await start("L5VWTR7WQLTIFLG7J3MO3NBSIS");
  push(wire("A", 1790432367953, 1), false);
  await settle([rest("C", 1790432367987)], "L5VWTR7WQLTIFLG7J3MO3NBSIS");

  push(wire("B", 1790432367988, 2, "A"), overflow);

  expect(snapshot().identity.owners).toEqual({ X: "B" });
  expect(infos[0]?.id).toBe("B");
});
