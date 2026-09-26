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
import type { LiveSessionInfo } from "./useLiveSessionsLean";
import { useLiveSessionSummaries } from "./useLiveSessionSummaries";
import type { Workspace } from "./workspace";

vi.mock("../../lib/chatWs", async (original) => ({
  ...await original<typeof import("../../lib/chatWs")>(),
  connectChat: vi.fn(),
}));

// Abridged authenticated wire capture from /tmp/t4-evidence/r9/epoch-wire.json.
const fresh = {
  id: "SWCIF5JU5IA5XVT4UWAQYZYYLM", durable: "Y", tasks: 2, revision: 1790428999935,
} as const;
const old = {
  id: "YRENH3BPZXAPDR3JYPJ5UJV5Q4", durable: "X", tasks: 7, revision: 1790428999886,
} as const;
type Epoch = typeof fresh | typeof old;
const row = (epoch: Epoch) => ({
  id: "A", durableSessionId: epoch.durable, title: "A", active: false,
  last_activity_ms: epoch.revision, running: { agents: epoch.tasks, tasks: epoch.tasks, dag: 0 },
});
const frame = (epoch: Epoch, overflow: boolean) => parseChatServerFrame({
  ...row(epoch), type: "sessions.activity", sessionId: "A", overflow,
});
const workspaces: readonly Workspace[] = [{
  id: "workspace", name: "Workspace", path: "/tmp",
  chats: [{ id: "A", name: "A", provider: "omo" }],
}];

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
    summaries, workspaces, sessionLists: new Map(),
    onSelect: () => undefined, onOpen: async () => "opened" as const,
  };
  return createElement("div", null,
    createElement(LiveSessionList, { ...props, listClassName: "pinned" }),
    createElement(LiveSessionList, { ...props, listClassName: "home" }));
}

function push(epoch: Epoch, overflow: boolean, connection?: number): void {
  const parsed = frame(epoch, overflow);
  if (parsed === null) throw new TypeError("Invalid captured activity");
  act(() => handlers.onFrame(parsed, connection));
}

function snapshot() {
  return {
    rows: infos.map((info) => ({
      id: info.id, durable: info.durableSessionId,
      tasks: info.lean?.running?.tasks, revision: info.lean?.last_activity_ms,
    })),
    identity: __liveIdentitySnapshotForTests(),
    authority: [...aggregates],
    badges: [...container.querySelectorAll(".th-overview-card-running")].map((el) => el.textContent),
  };
}

async function settle(epoch: Epoch): Promise<void> {
  await act(async () => {
    resolveResponse(new Response(JSON.stringify({ instanceId: epoch.id, sessions: [row(epoch)] })));
    await response;
  });
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  __resetLiveBadgeStoreForTests();
  deferResponse();
  vi.stubGlobal("fetch", vi.fn(() => response));
  vi.mocked(connectChat).mockImplementation((next) => {
    handlers = next;
    return { send: vi.fn(), close: vi.fn() };
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(Host)));
  act(() => {
    handlers.onAttempt?.(1);
    handlers.onOpen?.(1);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  __resetLiveBadgeStoreForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each([false, true])("rejects late unseen old REST after new hello (overflow=%s)", async (overflow) => {
  act(() => handlers.onHello?.(fresh.id));
  push(fresh, overflow);
  act(() => ingestExtensionEvent("A", "omo.dag.updated", { agent_running_count: 9 },
    undefined, fresh.revision + 1));
  const before = snapshot();
  expect(before.badges).toEqual(["2", "2"]);

  await settle(old);
  const after = snapshot();
  push(fresh, overflow);
  expect(after).toEqual(before);
  expect(snapshot()).toEqual(before);
});

it.each([false, true])("rejects queued unseen old hello after new REST (overflow=%s)", async (overflow) => {
  // The old socket's hello was queued before the replacement connected.
  act(() => handlers.onClose?.(1006, 1));
  act(() => handlers.onAttempt?.(2));
  act(() => handlers.onOpen?.(2));
  act(() => handlers.onHello?.(fresh.id, 2));
  await settle(old); // Initial request predates both socket generations.
  deferResponse();
  await act(async () => vi.advanceTimersToNextTimerAsync());
  await settle(fresh); // This request started after the current hello.
  act(() => ingestExtensionEvent("A", "omo.dag.updated", { agent_running_count: 9 },
    undefined, fresh.revision + 1));
  const before = snapshot();
  expect(before.badges).toEqual(["2", "2"]);

  act(() => handlers.onHello?.(old.id, 1));
  push(old, overflow, 1);
  expect(snapshot()).toEqual(before);
});

it.each([false, true])("revalidates an unfamiliar REST request started before the current hello (overflow=%s)", async (overflow) => {
  // Start a request on the open connection before its hello is processed.
  await settle(old); // The mount request belongs to the previous generation.
  deferResponse();
  await act(async () => vi.advanceTimersByTimeAsync(4000));
  expect(fetch).toHaveBeenCalledTimes(2);
  act(() => handlers.onHello?.(fresh.id, 1));
  push(fresh, overflow, 1);
  const before = snapshot();
  expect(before.badges).toEqual(["2", "2"]);

  await settle(old);
  expect(snapshot()).toEqual(before);
  deferResponse();
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(fetch).toHaveBeenCalledTimes(3);
  await settle(fresh);
  expect(snapshot()).toEqual(before);
});

it("starts a fresh poll when hello follows an ambiguous REST response", async () => {
  await settle(old); // The mount request belongs to the previous generation.
  deferResponse();
  await act(async () => vi.advanceTimersByTimeAsync(4000));
  expect(fetch).toHaveBeenCalledTimes(2);
  await settle(old); // Current generation, but the socket has not sent hello.
  expect(infos).toEqual([]);

  deferResponse();
  act(() => handlers.onHello?.(fresh.id, 1));
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(fetch).toHaveBeenCalledTimes(3);
  await settle(fresh);
  expect(infos.map((info) => [info.durableSessionId, info.lean?.running?.tasks])).toEqual([["Y", 2]]);
});

it("accepts the new hello and its post-handshake REST after a real restart", async () => {
  act(() => handlers.onHello?.(old.id, 1));
  push(old, false, 1);
  await settle(old); // Initial request is fenced, the old push remains visible.
  act(() => handlers.onClose?.(1006, 1));
  act(() => handlers.onAttempt?.(2));
  act(() => handlers.onOpen?.(2));
  act(() => handlers.onHello?.(fresh.id, 2));
  push(fresh, false, 2);
  deferResponse();
  await act(async () => vi.advanceTimersToNextTimerAsync());
  await settle(fresh);
  const before = snapshot();
  expect(before.badges).toEqual(["2", "2"]);

  push(old, false, 1);
  expect(snapshot()).toEqual(before);
});
