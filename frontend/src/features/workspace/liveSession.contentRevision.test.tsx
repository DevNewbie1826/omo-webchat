import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { connectChat } from "../../lib/chatWs";
import { useChatSession } from "../split/useChatSession";
import { useLiveSessionInfos } from "./useLiveSessions";
import {
  __resetLiveBadgeStoreForTests, useLiveAgentAggregates, useLiveBadgeOverrides,
  useMergedLiveSummaries, projectLiveTaskInfo,
} from "./liveBadgeStore";
import { __liveIdentitySnapshotForTests } from "./liveSessionIdentity";
import { useLiveSessionSummaries } from "./useLiveSessionSummaries";
import { LiveSessionList } from "./LiveSessionList";

// Port of the authenticated r19/r21 same-binding capture: seven agents, then
// two, with the newer overview delivered before the queued attached content.
const bindingId = "binding-A";
const durable = "durable-A";
const hello = { type: "hello", instanceId: "instance", serverVersion: "1.2.3", version: 3 };
const ready = { type: "ready", sessionId: "A", bindingId, piSessionId: durable, resumed: false };
const overviewRow = (count: number, revision?: number) => ({
  type: "sessions.activity", sessionId: "A", id: "A", durableSessionId: durable, bindingId,
  title: "A", active: false, overflow: false, last_activity_ms: revision,
  running: { agents: count, tasks: count, dag: 0 },
});
const feeds = ["task", "dag", "activity"] as const;
type Feed = typeof feeds[number];
function extension(feed: Feed, count: number, revision?: number) {
  const common = { type: "extensionEvent", sessionId: "A", bindingId, revision };
  switch (feed) {
    case "task": return { ...common, name: "omo.task.updated", data: {
      parent_session_id: durable, agent_running_count: count, agent_total_count: count,
      truncated_tasks: false, tasks: Array.from({ length: count }, (_, index) => ({
        task_id: `task-${index}`, status: "running", created_at: "2026-09-26T00:00:00Z",
        updated_at: `2026-09-26T00:00:0${count === 7 ? 1 : 4}Z`,
      })),
    } };
    case "dag": return { ...common, name: "omo.dag.updated", data: {
      parent_session_id: durable, runs: [], agent_running_count: count, agent_total_count: count,
    } };
    case "activity": return { ...common, name: "omo.dag.activity", data: {
      runId: "run", nodeId: "node", taskId: "task-0",
      at: `2026-09-26T00:00:0${count === 7 ? 2 : 5}Z`, lastAssistantLine: `activity at count ${count}`,
    } };
  }
}

// Only native network delivery is controlled; hooks, parsers and stores are real.
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
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(input) }));
  }
}
const session = { id: "A", name: "A", wsId: "ws-counts", cwd: "/tmp", provider: "omo" } as const;
const workspaces = [{
  id: "workspace", name: "Workspace", path: "/tmp",
  chats: [{ id: "A", name: "A", provider: "omo" as const }],
}];
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let infos: ReturnType<typeof useLiveSessionInfos>;
let aggregates: ReturnType<typeof useLiveAgentAggregates>;
let overrides: ReturnType<typeof useLiveBadgeOverrides>;
let resolveResponse: (value: Response) => void;
function Host() {
  useChatSession(session, connectChat);
  infos = useLiveSessionInfos(true);
  aggregates = useLiveAgentAggregates();
  overrides = useLiveBadgeOverrides();
  const summaries = useMergedLiveSummaries(useLiveSessionSummaries(true));
  const props = { summaries, workspaces, sessionLists: new Map(),
    onSelect: () => undefined, onOpen: async () => "opened" as const };
  return createElement("div", null,
    createElement(LiveSessionList, { ...props, listClassName: "pinned" }),
    createElement(LiveSessionList, { ...props, listClassName: "home" }));
}
function snapshot() {
  return {
    rows: infos, identity: __liveIdentitySnapshotForTests(),
    authority: [...aggregates], overrides: [...overrides],
    taskInfo: projectLiveTaskInfo({ id: "A" }),
    badges: [...container.querySelectorAll(".th-overview-card-running")].map(el => el.textContent),
  };
}
function streams() {
  const overview = Socket.instances.find(s => s.sent.some(data => JSON.parse(data).type === "sessions.subscribe"));
  const attached = Socket.instances.find(s => s.sent.some(data => JSON.parse(data).type === "chat.create"));
  if (overview === undefined || attached === undefined) throw new TypeError("Missing production streams");
  return { overview, attached };
}
beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("WebSocket", Socket);
  Socket.instances = [];
  __resetLiveBadgeStoreForTests();
  const response = new Promise<Response>(resolve => { resolveResponse = resolve; });
  vi.stubGlobal("fetch", vi.fn((url: string) => url === "/api/sessions/live"
    ? response : Promise.resolve(new Response(JSON.stringify({ goal: null, tasks: [], runs: [] })))));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(Host)));
  act(() => {
    for (const socket of Socket.instances) socket.open();
    const { overview, attached } = streams();
    overview.message(hello);
    attached.message(hello);
    attached.message(ready);
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

const cases = feeds.flatMap(feed => [false, true].map(overflow => ({ feed, overflow })));
it.each(cases)("rejects stale same-binding $feed content (overflow=$overflow)", ({ feed, overflow }) => {
  const { overview, attached } = streams();
  act(() => {
    overview.message({ ...overviewRow(7, 100), overflow });
    overview.message({ ...overviewRow(2, 200), overflow });
    for (const prior of feeds.slice(0, feeds.indexOf(feed))) attached.message(extension(prior, 7, 150));
  });
  const before = snapshot();
  const reference = overrides;
  expect(before.badges).toEqual(["2", "2"]);
  act(() => attached.message(extension(feed, 7, 150)));
  expect(overrides).toBe(reference);
  expect(snapshot()).toEqual(before);
});

it.each(cases)("accepts fresh same-binding $feed content (overflow=$overflow)", ({ feed, overflow }) => {
  const { overview, attached } = streams();
  act(() => {
    overview.message({ ...overviewRow(2, 200), overflow });
    attached.message(extension("task", 2, 201));
  });
  const reference = overrides;
  act(() => attached.message(extension(feed, 2, 202)));
  expect(overrides).not.toBe(reference);
  expect(aggregates.get("A")).toEqual({ running: 2, total: 2 });
  expect(snapshot().badges).toEqual(["2", "2"]);
});

it.each(feeds)("makes equal-revision $feed replay idempotent", feed => {
  const { overview, attached } = streams();
  act(() => {
    overview.message(overviewRow(2, 200));
    attached.message(extension(feed, 2, 201));
  });
  const before = snapshot();
  const reference = overrides;
  act(() => attached.message(extension(feed, 2, 201)));
  expect(overrides).toBe(reference);
  expect(snapshot()).toEqual(before);
});

it.each(feeds)("rejects unversioned $feed after REST revision acceptance", async feed => {
  const { overview, attached } = streams();
  // Finish the pre-hello request, then drive the overflow-requested fallback.
  act(() => overview.message({ ...overviewRow(2), overflow: true }));
  await act(async () => resolveResponse(new Response(JSON.stringify({
    instanceId: "instance", sessions: [overviewRow(2, 200)],
  }))));
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({
    instanceId: "instance", sessions: [overviewRow(2, 200)],
  })))));
  await act(async () => vi.advanceTimersToNextTimerAsync());
  expect(infos[0]?.lean?.last_activity_ms).toBe(200);
  const before = snapshot();
  act(() => attached.message(extension(feed, 7)));
  expect(snapshot()).toEqual(before);
});

it.each(feeds)("allows legacy $feed before any revision is accepted", feed => {
  const { overview, attached } = streams();
  act(() => overview.message(overviewRow(2)));
  const reference = overrides;
  act(() => attached.message(extension(feed, 7)));
  expect(overrides).not.toBe(reference);
});

it.each(feeds.flatMap(source => feeds.map(feed => ({ source, feed }))))(
  "uses newer attached $source authority to fence delayed $feed", ({ source, feed }) => {
  const { overview, attached } = streams();
  act(() => {
    overview.message(overviewRow(2, 100));
    attached.message(extension(source, 2, 300));
    overview.message(overviewRow(2, 200));
  });
  const before = snapshot();
  act(() => attached.message(extension(feed, 7, 250)));
  expect(snapshot()).toEqual(before);
});

it.each(feeds)("treats an overview-equal %s revision as idempotent", feed => {
  const { overview, attached } = streams();
  act(() => overview.message(overviewRow(2, 200)));
  const before = snapshot();
  act(() => attached.message(extension(feed, 2, 200)));
  expect(snapshot()).toEqual(before);
});
