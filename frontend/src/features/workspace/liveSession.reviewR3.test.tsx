import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { connectChat, parseChatServerFrame } from "../../lib/chatWs";
import type { ChatHandlers } from "../../lib/chatWs";
import type { SessionsActivityFrame } from "../../lib/contract/types_gen";
import {
  __resetLiveBadgeStoreForTests, canonicalLiveSessionId, ingestExtensionEvent,
  nextLiveActivitySequence, useLiveAgentAggregates,
} from "./liveBadgeStore";
import { liveDurableOwner } from "./liveSessionIdentity";
import { LiveSessionMembership } from "./liveSessionMembership";
import { useLiveSessionInfos } from "./useLiveSessions";
import type { LiveSessionInfo } from "./useLiveSessionsLean";

vi.mock("../../lib/chatWs", async (original) => ({
  ...await original<typeof import("../../lib/chatWs")>(),
  connectChat: vi.fn(),
}));

const frame = (fields: Partial<SessionsActivityFrame> = {}): SessionsActivityFrame => ({
  type: "sessions.activity", sessionId: "A", durableSessionId: "X",
  overflow: false, title: "A", active: false, last_activity_ms: 100,
  running: { agents: 1, tasks: 1, dag: 0 }, ...fields,
});
const row = (fields: Partial<LiveSessionInfo> = {}): LiveSessionInfo => ({
  id: "A", title: "A", active: false, task: null, dag: null,
  lean: { last_activity_ms: 100, running: { agents: 1, tasks: 1, dag: 0 } }, ...fields,
});
let membership: LiveSessionMembership;
let root: Root;
let container: HTMLDivElement;
let handlers: ChatHandlers;
let infos: readonly LiveSessionInfo[];
let aggregates: ReadonlyMap<string, { readonly running: number }>;

function Host({ live = false }: { readonly live?: boolean }): null {
  infos = useLiveSessionInfos(live);
  aggregates = useLiveAgentAggregates();
  return null;
}

function push(fields: Partial<SessionsActivityFrame> = {}): void {
  act(() => membership.push(frame(fields), nextLiveActivitySequence()));
}

function hookPush(fields: Partial<SessionsActivityFrame> = {}): void {
  const parsed = parseChatServerFrame(frame(fields));
  if (parsed === null) throw new Error("Invalid activity frame");
  act(() => handlers.onFrame(parsed));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  __resetLiveBadgeStoreForTests();
  membership = new LiveSessionMembership();
  infos = [];
  aggregates = new Map();
  vi.mocked(connectChat).mockImplementation((next) => {
    handlers = next;
    return { send: vi.fn(), close: vi.fn() };
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Host />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  __resetLiveBadgeStoreForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each([false, true])("admits a newer named replacement without migrating another owner's authority (overflow=%s)", (overflow) => {
  push({ sessionId: "P", durableSessionId: "P" });
  // PR #197 server contract: replacesSessionId names a provisional of the
  // SAME durable. P:P -> A:X is invalid, so A claims P instead.
  push({ durableSessionId: "P", replacesSessionId: "P", last_activity_ms: 200 });
  act(() => ingestExtensionEvent("A", "omo.dag.updated", { agent_running_count: 9, agent_total_count: 9 }, undefined, 201));

  push({ sessionId: "B", durableSessionId: "P", replacesSessionId: "P", last_activity_ms: 300, overflow });

  expect(membership.values().map((value) => value.id)).toEqual(["B", "A"]);
  expect(canonicalLiveSessionId("P")).toBe("B");
  expect(liveDurableOwner("P")).toBe("B");
  expect(aggregates.get("A")?.running).toBe(9);
  expect(aggregates.has("B")).toBe(false);
});

it.each([false, true])("does not transfer unrelated durable authority on a newer replacement (overflow=%s)", (overflow) => {
  push();
  push({ durableSessionId: "Y", last_activity_ms: 150 });
  act(() => ingestExtensionEvent("A", "omo.dag.updated", { agent_running_count: 9, agent_total_count: 9 }, undefined, 151));

  push({ sessionId: "B", durableSessionId: "X", replacesSessionId: "A", last_activity_ms: 200, overflow });

  expect(membership.values().map((value) => value.id)).toEqual(["B"]);
  expect(liveDurableOwner("X")).toBe("B");
  expect(liveDurableOwner("Y")).toBeUndefined();
  expect(aggregates.has("A")).toBe(false);
  expect(aggregates.has("B")).toBe(false);
});

it.each([false, true])("fences a pending REST row for a replaced source (overflow=%s)", (overflow) => {
  push();
  const pending = nextLiveActivitySequence();
  push({ sessionId: "B", replacesSessionId: "A", last_activity_ms: 200, overflow });

  act(() => membership.poll([row()], pending));

  expect(membership.values().map((value) => value.id)).toEqual(["B"]);
});

it.each([false, true])("fences a replaced source through the mounted hook (overflow=%s)", async (overflow) => {
  vi.useFakeTimers();
  let resolveResponse: (value: Response) => void = () => undefined;
  const pending = new Promise<Response>((resolve) => { resolveResponse = resolve; });
  vi.stubGlobal("fetch", vi.fn(() => pending));
  await act(async () => root.render(<Host live />));
  hookPush();
  hookPush({ sessionId: "B", replacesSessionId: "A", last_activity_ms: 200, overflow });

  await act(async () => {
    resolveResponse(new Response(JSON.stringify({ sessions: [{
      id: "A", title: "A", last_activity_ms: 100, running: { tasks: 1 },
    }] })));
    await pending;
  });

  expect(infos.map((value) => value.id)).toEqual(["B"]);
});

it.each([false, true])("does not transfer provisional authority from a stale REST parent (overflow=%s)", (overflow) => {
  push();
  const pending = nextLiveActivitySequence();
  push({ last_activity_ms: 200, running: { tasks: 2 }, overflow });
  act(() => {
    ingestExtensionEvent("P", "omo.dag.updated", { agent_running_count: 9, agent_total_count: 9 }, undefined, 201);
    membership.poll([row({ task: { parent_session_id: "P", tasks: [] } })], pending);
  });

  expect(canonicalLiveSessionId("P")).toBe("P");
  expect(liveDurableOwner("X")).toBe("A");
  expect(aggregates.get("P")?.running).toBe(9);
  expect(aggregates.has("A")).toBe(false);
});

it.each([false, true])("rejects an older REST receipt even from a later request (overflow=%s)", (overflow) => {
  push();
  push({ last_activity_ms: 200, running: { tasks: 2 }, overflow });
  const pending = nextLiveActivitySequence();

  act(() => membership.poll([row()], pending));

  expect(membership.values()[0]?.lean?.last_activity_ms).toBe(200);
  expect(membership.values()[0]?.lean?.running?.tasks).toBe(2);
});

it("migrates provisional durable authority through the mounted WS hook", async () => {
  act(() => ingestExtensionEvent("X", "omo.dag.updated", { agent_running_count: 9, agent_total_count: 9 }, undefined, 1));
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
  await act(async () => root.render(<Host live />));

  hookPush();

  expect(infos.map((value) => value.id)).toEqual(["A"]);
  // PR #197 server contract: unseen attached badge authority X is an observed
  // provisional source; bare A:X claims it and migrates its alias and counts.
  expect(canonicalLiveSessionId("X")).toBe("A");
  expect(liveDurableOwner("X")).toBe("A");
  expect(aggregates.get("A")?.running).toBe(9);
  expect(aggregates.has("X")).toBe(false);
});
