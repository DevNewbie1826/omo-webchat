import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { connectChat } from "../../lib/chatWs";
import { useChatSession } from "../split/useChatSession";
import { LiveSessionList } from "./LiveSessionList";
import {
  __resetLiveBadgeStoreForTests, bindAttachedBadgeSource, ingestExtensionEvent, projectLiveTaskInfo, useLiveAgentAggregates,
  useLiveBadgeOverrides, useMergedLiveSummaries,
} from "./liveBadgeStore";
import { __liveIdentitySnapshotForTests } from "./liveSessionIdentity";
import { useLiveSessionInfos } from "./useLiveSessions";
import { useLiveSessionSummaries } from "./useLiveSessionSummaries";
import type { LiveSessionInfo } from "./useLiveSessionsLean";
import type { Workspace } from "./workspace";

// Authenticated old/new manager capture from the r15 attached-epoch review.
const oldInstance = "TWIBK2RXKJDTQRTZT2SJISXPJU";
const freshInstance = "2I7KL6OFMCI64W3ESK46DYIOM5";
const durable = "durable-00000001-4f2a-9c31";
const row = (count: number, revision: number) => ({
  id: "A", sessionId: "A", bindingId: "binding-X", durableSessionId: durable, title: "A", active: false,
  last_activity_ms: revision, running: { agents: count, tasks: count, dag: 0 },
  done: 0, dag_done: 0, dag_total: 0, truncated: { task: false, dag: false },
});
const oldRow = row(7, 1790438426074);
const freshRow = row(2, 1790438426125);
const oldExtension = {
  type: "extensionEvent", bindingId: "binding-X", name: "omo.task.updated", sessionId: "A",
  data: {
    parent_session_id: durable, truncated_tasks: false,
    running_count: 7, total_count: 7, agent_running_count: 7, agent_total_count: 7,
    tasks: Array.from({ length: 7 }, (_, index) => ({
      task_id: `attached-task-${index}`, status: "running",
      created_at: "2026-09-26T00:00:00Z", updated_at: "2026-09-26T00:00:01Z",
    })),
  },
};
const oldDag = {
  type: "extensionEvent", bindingId: "binding-X", name: "omo.dag.updated", sessionId: "A",
  data: { parent_session_id: durable, runs: [], running_count: 0, run_running_count: 0,
    agent_running_count: 7, agent_total_count: 7 },
};
const oldActivity = {
  type: "extensionEvent", bindingId: "binding-X", name: "omo.dag.activity", sessionId: "A",
  data: { runId: "run-old", nodeId: "node-old", taskId: "attached-task-0",
    at: "2026-09-26T00:00:02Z", lastAssistantLine: "old durable activity" },
};
const feeds = [oldExtension, oldDag, oldActivity];
const versioned = (feed: typeof feeds[number], overviewRevision: number) => ({
  ...feed, revision: overviewRevision + feeds.indexOf(feed) + 1,
});

// Only network delivery is controlled; both connectors and all hooks are real.
class Socket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: Socket[] = [];
  readyState = Socket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readonly sent: string[] = [];
  constructor(_url: string) { Socket.instances.push(this); }
  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = Socket.CLOSED; }
  open(): void {
    this.readyState = Socket.OPEN;
    this.onopen?.(new Event("open"));
  }
  message(input: object): void {
    if (this.readyState === Socket.OPEN) {
      this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(input) }));
    }
  }
  disconnect(): void {
    this.readyState = Socket.CLOSED;
    this.onclose?.(new CloseEvent("close", { code: 1006 }));
  }
}

const workspaces: readonly Workspace[] = [{
  id: "workspace", name: "Workspace", path: "/tmp",
  chats: ["A", "B"].map((id) => ({ id, name: id, provider: "omo" })),
}];
const attachedSession = { id: "A", name: "A", wsId: "ws-counts", cwd: "/tmp", provider: "omo" } as const;
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let infos: readonly LiveSessionInfo[];
let aggregates: ReadonlyMap<string, { readonly running: number }>;
let badgeOverrides: ReturnType<typeof useLiveBadgeOverrides>;
let response: Promise<Response>;
let resolveResponse: (value: Response) => void;

function deferResponse(): void {
  response = new Promise((resolve) => { resolveResponse = resolve; });
}

function Host() {
  useChatSession(attachedSession, connectChat);
  infos = useLiveSessionInfos(true);
  aggregates = useLiveAgentAggregates();
  badgeOverrides = useLiveBadgeOverrides();
  const summaries = useMergedLiveSummaries(useLiveSessionSummaries(true));
  const props = {
    summaries, workspaces, sessionLists: new Map(),
    onSelect: () => undefined, onOpen: async () => "opened" as const,
  };
  return createElement("div", null,
    createElement(LiveSessionList, { ...props, listClassName: "pinned" }),
    createElement(LiveSessionList, { ...props, listClassName: "home" }));
}

function snapshot() {
  return {
    rows: infos.map((info) => ({
      id: info.id, durable: info.durableSessionId,
      tasks: info.lean?.running?.tasks, revision: info.lean?.last_activity_ms,
    })),
    identity: __liveIdentitySnapshotForTests(),
    authority: [...aggregates],
    overrides: [...badgeOverrides],
    taskInfo: projectLiveTaskInfo({ id: "A" }),
    badges: [...container.querySelectorAll(".th-overview-card-running")].map((el) => el.textContent),
  };
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("WebSocket", Socket);
  Socket.instances = [];
  __resetLiveBadgeStoreForTests();
  deferResponse();
  vi.stubGlobal("fetch", vi.fn((url: string) => url === "/api/sessions/live"
    ? response : Promise.resolve(new Response(JSON.stringify({ goal: null, tasks: [], runs: [] })))));
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

it.each([false, true].flatMap((late) => [false, true].map((overflow) => ({ late, overflow }))))(
  "rejects attached old-instance delivery after overview adoption (late=$late overflow=$overflow)",
  async ({ late, overflow }) => {
    act(() => { for (const current of Socket.instances) current.open(); });
    const overview = Socket.instances.find((current) => current.sent.some((data) => JSON.parse(data).type === "sessions.subscribe"));
    const attached = Socket.instances.find((current) => current.sent.some((data) => JSON.parse(data).type === "chat.create"));
    if (overview === undefined || attached === undefined) throw new TypeError("Expected separate overview and attached transports");
    act(() => {
      overview.message({ type: "hello", instanceId: oldInstance, serverVersion: "1.2.3", version: 3 });
      attached.message({ type: "hello", instanceId: oldInstance, serverVersion: "1.2.3", version: 3 });
      attached.message({ type: "ready", sessionId: "A", bindingId: "binding-X", piSessionId: durable, resumed: false });
      overview.message({ ...oldRow, type: "sessions.activity", overflow: false });
      if (!late) attached.message(versioned(oldExtension, oldRow.last_activity_ms));
    });
    await act(async () => {
      resolveResponse(new Response(JSON.stringify({ instanceId: oldInstance, sessions: [oldRow] })));
      await response;
    });
    act(() => overview.disconnect());
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    const fresh = Socket.instances[2];
    if (fresh === undefined) throw new TypeError("Expected overview reconnect");
    act(() => {
      fresh.open();
      fresh.message({ type: "hello", instanceId: freshInstance, serverVersion: "1.2.3", version: 3 });
      fresh.message({ ...freshRow, type: "sessions.activity", overflow });
    });
    const before = snapshot();
    expect(infos[0]?.lean?.running?.agents).toBe(2);
    expect(aggregates.get("A")).toBeUndefined();
    act(() => { if (late) attached.message(versioned(oldExtension, freshRow.last_activity_ms)); });
    expect(snapshot()).toEqual(before);
  },
);

it.each(feeds)("rejects a superseded attempt and accepts the current one for $name", (feed) => {
  act(() => { for (const current of Socket.instances) current.open(); });
  const overview = Socket.instances.find((current) => current.sent.some((data) => JSON.parse(data).type === "sessions.subscribe"));
  if (overview === undefined) throw new TypeError("Expected overview transport");
  act(() => {
    overview.message({ type: "hello", instanceId: oldInstance, serverVersion: "1.2.3", version: 3 });
    overview.message({ ...oldRow, type: "sessions.activity", overflow: false });
  });
  const before = snapshot();
  const attemptToken = {};
  bindAttachedBadgeSource("A", {
    attemptToken, bindingId: "binding-X", instanceId: oldInstance,
    connection: 2, currentConnection: 2, durableSessionId: durable,
  });
  act(() => ingestExtensionEvent("A", feed.name, feed.data, {
    attemptToken, bindingId: "binding-X", instanceId: oldInstance,
    connection: 1, currentConnection: 2, durableSessionId: durable,
  }, oldRow.last_activity_ms + 1));
  expect(snapshot()).toEqual(before);
  act(() => ingestExtensionEvent("A", feed.name, feed.data, {
    attemptToken, bindingId: "binding-X", instanceId: oldInstance,
    connection: 2, currentConnection: 2, durableSessionId: durable,
  }, oldRow.last_activity_ms + 1));
  if (feed.name === "omo.dag.activity") expect(badgeOverrides.get("A")).toBeDefined();
  else expect(aggregates.get("A")).toEqual({ running: 7, total: 7 });
});

it.each(feeds.flatMap((feed) => [false, true].flatMap((late) => [false, true].map((overflow) => ({ feed, late, overflow })))))(
  "fences old durable attached $feed.name after same-instance move (late=$late overflow=$overflow)",
  async ({ feed, late, overflow }) => {
    // Given two current transports and an attached stream bound to durable X.
    act(() => { for (const current of Socket.instances) current.open(); });
    const overview = Socket.instances.find((current) => current.sent.some((data) => JSON.parse(data).type === "sessions.subscribe"));
    const attached = Socket.instances.find((current) => current.sent.some((data) => JSON.parse(data).type === "chat.create"));
    if (overview === undefined || attached === undefined) throw new TypeError("Expected separate overview and attached transports");
    act(() => {
      overview.message({ type: "hello", instanceId: oldInstance, serverVersion: "1.2.3", version: 3 });
      attached.message({ type: "hello", instanceId: oldInstance, serverVersion: "1.2.3", version: 3 });
      attached.message({ type: "ready", sessionId: "A", bindingId: "binding-X", piSessionId: durable, resumed: false });
      overview.message({ ...oldRow, type: "sessions.activity", overflow: false });
      for (const earlier of feeds.slice(0, feeds.indexOf(feed))) attached.message(versioned(earlier, oldRow.last_activity_ms));
      if (!late) attached.message(versioned(feed, oldRow.last_activity_ms));
    });
    await act(async () => {
      resolveResponse(new Response(JSON.stringify({ instanceId: oldInstance, sessions: [oldRow] })));
      await response;
    });
    // When the overview accepts the new durable without replacing the instance or socket.
    act(() => overview.message({
      ...row(2, oldRow.last_activity_ms + 13), durableSessionId: "Y", bindingId: "binding-Y",
      type: "sessions.activity", overflow,
    }));
    const before = snapshot();
    expect(infos[0]?.durableSessionId).toBe("Y");
    expect(before.badges).toEqual(["2", "2"]);
    expect(aggregates.get("A")).toBeUndefined();
    act(() => { if (late) attached.message(versioned(feed, oldRow.last_activity_ms + 13)); });
    // Then buffered X authority cannot overwrite Y; pre-move deliveries are settled.
    expect(snapshot()).toEqual(before);
  },
);

it.each(feeds.flatMap((feed) => [false, true].flatMap((late) => [false, true].map((overflow) => ({ feed, late, overflow })))))(
  "keeps the superseded X binding fenced after X-Y-X for $feed.name (late=$late overflow=$overflow)",
  async ({ feed, late, overflow }) => {
    // Captured order: seven tasks on X, A moves to Y, then reopens X with two.
    act(() => { for (const current of Socket.instances) current.open(); });
    const overview = Socket.instances.find((current) => current.sent.some((data) => JSON.parse(data).type === "sessions.subscribe"));
    const attached = Socket.instances.find((current) => current.sent.some((data) => JSON.parse(data).type === "chat.create"));
    if (overview === undefined || attached === undefined) throw new TypeError("Expected separate overview and attached transports");
    const initial = row(7, 1790441809458);
    act(() => {
      overview.message({ type: "hello", instanceId: oldInstance, serverVersion: "1.2.3", version: 3 });
      attached.message({ type: "hello", instanceId: oldInstance, serverVersion: "1.2.3", version: 3 });
      attached.message({ type: "ready", sessionId: "A", bindingId: "binding-X", piSessionId: durable, resumed: false });
      overview.message({ ...initial, type: "sessions.activity", overflow: false });
      for (const earlier of feeds.slice(0, feeds.indexOf(feed))) attached.message(versioned(earlier, initial.last_activity_ms));
      if (!late) attached.message(versioned(feed, initial.last_activity_ms));
    });
    await act(async () => {
      resolveResponse(new Response(JSON.stringify({ instanceId: oldInstance, sessions: [initial] })));
      await response;
    });
    act(() => {
      overview.message({ ...initial, type: "sessions.activity", overflow });
      overview.message({ ...row(2, 1790441809471), durableSessionId: "Y", bindingId: "binding-Y", type: "sessions.activity", overflow });
      overview.message({ ...row(0, 1790441809481), bindingId: "binding-X-new", type: "sessions.activity", overflow });
      overview.message({ ...row(2, 1790441809484), bindingId: "binding-X-new", type: "sessions.activity", overflow });
    });
    const before = snapshot();
    expect(before.rows).toMatchObject([{ id: "A", durable, tasks: 2 }]);
    expect(before.badges).toEqual(["2", "2"]);
    expect(before.authority).toEqual([]);
    act(() => { if (late) attached.message(versioned(feed, 1790441809484)); });
    expect(snapshot()).toEqual(before);
  },
);

it.each(feeds)("accepts a fresh ready on the returned X durable for $name", (feed) => {
  act(() => { for (const current of Socket.instances) current.open(); });
  const overview = Socket.instances.find((current) => current.sent.some((data) => JSON.parse(data).type === "sessions.subscribe"));
  const attached = Socket.instances.find((current) => current.sent.some((data) => JSON.parse(data).type === "chat.create"));
  if (overview === undefined || attached === undefined) throw new TypeError("Expected separate overview and attached transports");
  act(() => {
    overview.message({ type: "hello", instanceId: oldInstance, serverVersion: "1.2.3", version: 3 });
    attached.message({ type: "hello", instanceId: oldInstance, serverVersion: "1.2.3", version: 3 });
    attached.message({ type: "ready", sessionId: "A", bindingId: "binding-X", piSessionId: durable, resumed: false });
    overview.message({ ...row(7, 1790441809458), type: "sessions.activity", overflow: false });
    overview.message({ ...row(2, 1790441809471), durableSessionId: "Y", bindingId: "binding-Y", type: "sessions.activity", overflow: false });
    overview.message({ ...row(2, 1790441809484), bindingId: "binding-X-new", type: "sessions.activity", overflow: false });
  });
  const before = snapshot();
  act(() => {
    attached.message({ type: "ready", sessionId: "A", bindingId: "binding-X-new", piSessionId: durable, resumed: true });
    attached.message({ ...versioned(feed, 1790441809484), bindingId: "binding-X-new" });
  });
  expect(snapshot()).not.toEqual(before);
  if (feed.name === "omo.dag.activity") expect(badgeOverrides.get("A")).toBeDefined();
  else expect(aggregates.get("A")).toEqual({ running: 7, total: 7 });
});

it.each(feeds)("never readmits the older $name binding after a fresh X rebind", (feed) => {
  act(() => { for (const current of Socket.instances) current.open(); });
  const overview = Socket.instances.find((current) => current.sent.some((data) => JSON.parse(data).type === "sessions.subscribe"));
  if (overview === undefined) throw new TypeError("Expected overview transport");
  const attemptToken = {};
  act(() => {
    overview.message({ type: "hello", instanceId: oldInstance, serverVersion: "1.2.3", version: 3 });
    overview.message({ ...row(7, 1790441809458), type: "sessions.activity", overflow: false });
    bindAttachedBadgeSource("A", {
      attemptToken, bindingId: "binding-X", instanceId: oldInstance,
      connection: 1, currentConnection: 1, durableSessionId: durable,
    });
    overview.message({ ...row(2, 1790441809471), durableSessionId: "Y", bindingId: "binding-Y", type: "sessions.activity", overflow: false });
    overview.message({ ...row(2, 1790441809484), bindingId: "binding-X-new", type: "sessions.activity", overflow: false });
    bindAttachedBadgeSource("A", {
      attemptToken, bindingId: "binding-X-new", instanceId: oldInstance,
      connection: 1, currentConnection: 1, durableSessionId: durable,
    });
  });
  const before = snapshot();
  act(() => ingestExtensionEvent("A", feed.name, feed.data, {
    attemptToken, bindingId: "binding-X", instanceId: oldInstance,
    connection: 1, currentConnection: 1, durableSessionId: durable,
  }, 1790441809485));
  expect(snapshot()).toEqual(before);
  act(() => ingestExtensionEvent("A", feed.name, feed.data, {
    attemptToken, bindingId: "binding-X-new", instanceId: oldInstance,
    connection: 1, currentConnection: 1, durableSessionId: durable,
  }, 1790441809485));
  expect(snapshot()).not.toEqual(before);
});

it.each(feeds)("accepts $name when attached ready precedes overview adoption", (feed) => {
  act(() => { for (const current of Socket.instances) current.open(); });
  const overview = Socket.instances.find((current) => current.sent.some((data) => JSON.parse(data).type === "sessions.subscribe"));
  const attached = Socket.instances.find((current) => current.sent.some((data) => JSON.parse(data).type === "chat.create"));
  if (overview === undefined || attached === undefined) throw new TypeError("Expected separate overview and attached transports");
  act(() => {
    attached.message({ type: "hello", instanceId: oldInstance, serverVersion: "1.2.3", version: 3 });
    attached.message({ type: "ready", sessionId: "A", bindingId: "binding-X", piSessionId: durable, resumed: false });
    overview.message({ type: "hello", instanceId: oldInstance, serverVersion: "1.2.3", version: 3 });
    overview.message({ ...row(2, 1790441809458), type: "sessions.activity", overflow: false });
  });
  const before = snapshot();
  act(() => attached.message(versioned(feed, 1790441809458)));
  expect(snapshot()).not.toEqual(before);
});

it.each(feeds)("drops $name after the attached route unloads", (feed) => {
  // Given an overview row and its attached route, then the route unloads.
  act(() => { for (const current of Socket.instances) current.open(); });
  const overview = Socket.instances.find((current) => current.sent.some((data) => JSON.parse(data).type === "sessions.subscribe"));
  const attached = Socket.instances.find((current) => current.sent.some((data) => JSON.parse(data).type === "chat.create"));
  if (overview === undefined || attached === undefined) throw new TypeError("Expected separate overview and attached transports");
  act(() => {
    overview.message({ type: "hello", instanceId: oldInstance, serverVersion: "1.2.3", version: 3 });
    attached.message({ type: "hello", instanceId: oldInstance, serverVersion: "1.2.3", version: 3 });
    attached.message({ type: "ready", sessionId: "A", bindingId: "binding-X", piSessionId: durable, resumed: false });
    overview.message({ ...oldRow, type: "sessions.activity", overflow: false });
    attached.message({ type: "error", sessionId: "A", code: "session_unloaded", message: "Route unloaded" });
  });
  const before = snapshot();
  // When an old frame arrives on the same still-open socket, it cannot write.
  act(() => attached.message(versioned(feed, oldRow.last_activity_ms)));
  expect(snapshot()).toEqual(before);
});

it("accepts the new attached durable after its own ready frame", () => {
  act(() => { for (const current of Socket.instances) current.open(); });
  const overview = Socket.instances.find((current) => current.sent.some((data) => JSON.parse(data).type === "sessions.subscribe"));
  const attached = Socket.instances.find((current) => current.sent.some((data) => JSON.parse(data).type === "chat.create"));
  if (overview === undefined || attached === undefined) throw new TypeError("Expected separate overview and attached transports");
  act(() => {
    overview.message({ type: "hello", instanceId: oldInstance, serverVersion: "1.2.3", version: 3 });
    attached.message({ type: "hello", instanceId: oldInstance, serverVersion: "1.2.3", version: 3 });
    overview.message({ ...row(2, oldRow.last_activity_ms + 13), durableSessionId: "Y", bindingId: "binding-Y", type: "sessions.activity", overflow: false });
    attached.message({ type: "ready", sessionId: "A", bindingId: "binding-Y", piSessionId: "Y", resumed: true });
  });
  act(() => attached.message({
    ...versioned(oldExtension, oldRow.last_activity_ms + 13), bindingId: "binding-Y",
    data: { ...oldExtension.data, parent_session_id: "Y",
      agent_running_count: 3, agent_total_count: 3 },
  }));
  expect(aggregates.get("A")).toEqual({ running: 3, total: 3 });
});

it.each([false, true])("retires A's attached authority when B replaces its durable under another binding (overflow=%s)", async (overflow) => {
  // The authenticated cross-chat capture retains the durable and instance,
  // but A's seven agents belong to an older binding than B's two agents.
  act(() => { for (const current of Socket.instances) current.open(); });
  const overview = Socket.instances.find((current) => current.sent.some((data) => JSON.parse(data).type === "sessions.subscribe"));
  const attached = Socket.instances.find((current) => current.sent.some((data) => JSON.parse(data).type === "chat.create"));
  if (overview === undefined || attached === undefined) throw new TypeError("Expected separate overview and attached transports");
  await act(async () => {
    overview.message({ type: "hello", instanceId: oldInstance, serverVersion: "1.2.3", version: 3 });
    attached.message({ type: "hello", instanceId: oldInstance, serverVersion: "1.2.3", version: 3 });
    attached.message({ type: "ready", sessionId: "A", bindingId: "binding-X", piSessionId: durable, resumed: false });
    overview.message({ ...row(7, 1790447282176), type: "sessions.activity", overflow: false });
    for (const feed of feeds) attached.message(versioned(feed, 1790447282176));
  });
  expect(aggregates.get("A")).toEqual({ running: 7, total: 7 });
  expect(badgeOverrides.has("A")).toBe(true);

  await act(async () => {
    overview.message({ ...row(7, 1790447282176), type: "sessions.activity", overflow });
    overview.message({
      ...row(0, 1790447282237), id: "B", sessionId: "B", title: "B", bindingId: "binding-Y",
      replacesSessionId: "A", type: "sessions.activity", overflow,
    });
    overview.message({
      ...row(2, 1790447282243), id: "B", sessionId: "B", title: "B", bindingId: "binding-Y",
      type: "sessions.activity", overflow,
    });
  });

  expect(infos.map(({ id }) => id)).toEqual(["B"]);
  expect([...container.querySelectorAll(".th-overview-card-running")].map((el) => el.textContent))
    .toEqual(["2", "2"]);
  expect(aggregates.has("A")).toBe(false);
  expect(aggregates.get("B")).toBeUndefined();
  expect(badgeOverrides.has("A")).toBe(false);
  expect(badgeOverrides.has("B")).toBe(false);
});
