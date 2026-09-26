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
import { wire } from "./liveSession.readyOrder.fixture";
import type { Workspace } from "./workspace";

// Native network deliveries only are controlled; connectors and stores are real.
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
}
const session = { id: "A", name: "A", wsId: "ws-counts", cwd: "/tmp", provider: "omo" } as const;
const workspaces: readonly Workspace[] = [{
  id: "workspace", name: "Workspace", path: "/tmp",
  chats: [{ id: "A", name: "A", provider: "omo" }],
}];
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let infos: ReturnType<typeof useLiveSessionInfos>;
let aggregates: ReturnType<typeof useLiveAgentAggregates>;
let overrides: ReturnType<typeof useLiveBadgeOverrides>;
let response: Promise<Response>;
function FreshAttached() {
  useChatSession(session, connectChat);
  return null;
}
function Host({ fresh = false }: { readonly fresh?: boolean }) {
  useChatSession(session, connectChat);
  infos = useLiveSessionInfos(true);
  aggregates = useLiveAgentAggregates();
  overrides = useLiveBadgeOverrides();
  const summaries = useMergedLiveSummaries(useLiveSessionSummaries(true));
  const props = { summaries, workspaces, sessionLists: new Map(),
    onSelect: () => undefined, onOpen: async () => "opened" as const };
  return createElement("div", null,
    createElement(LiveSessionList, { ...props, listClassName: "pinned" }),
    createElement(LiveSessionList, { ...props, listClassName: "home" }),
    fresh ? createElement(FreshAttached) : null);
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
  response = new Promise<Response>(() => undefined);
  vi.stubGlobal("fetch", vi.fn((url: string) => url === "/api/sessions/live"
    ? response : Promise.resolve(new Response(JSON.stringify({ goal: null, tasks: [], runs: [] })))));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(Host)));
  await act(async () => { for (const socket of Socket.instances) socket.open(); });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  __resetLiveBadgeStoreForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const feeds = ["task", "dag", "activity"] as const;

it.each(feeds.flatMap(feed => [false, true].flatMap(lateReady =>
  [false, true].map(overflow => ({ feed, lateReady, overflow })))))
  ("never revives buffered old ready: feed=$feed lateReady=$lateReady overflow=$overflow", async ({ feed, lateReady, overflow }) => {
    // Given the original binding, with its ready optionally delayed on its own stream.
    const { overview, attached } = streams();
    await act(async () => {
      overview.message(wire.hello);
      attached.message(wire.hello);
      if (!lateReady) attached.message(wire.ready);
      for (const frame of wire.firstOverview) overview.message(frame);
      for (const frame of [...wire.movedOverview, ...wire.returnedOverview]) overview.message({ ...frame, overflow });
    });
    const before = snapshot();
    expect(before.badges).toEqual(["2", "2"]);
    expect(before.authority).toEqual([]);
    // When the buffered original ready and following old events arrive in socket order.
    await act(async () => {
      if (lateReady) attached.message(wire.ready);
      for (const earlier of feeds.slice(0, feeds.indexOf(feed))) {
        attached.message({ ...wire[earlier], revision: 1790443356247 + feeds.indexOf(earlier) });
      }
    });
    const beforeFeed = snapshot();
    const beforeOverrideReference = overrides;
    await act(async () => attached.message({ ...wire[feed], revision: 1790443356250 }));
    const after = snapshot();
    // Then the superseded seven-task binding cannot acquire authority again.
    expect(overrides).toBe(beforeOverrideReference);
    expect(after).toEqual(beforeFeed);
  });

it.each(feeds.flatMap(feed => [false, true].flatMap(readyBeforeOverview =>
  [false, true].map(overflow => ({ feed, readyBeforeOverview, overflow })))))
  ("accepts new ready independently of overview timing: feed=$feed readyBeforeOverview=$readyBeforeOverview overflow=$overflow",
    async ({ feed, readyBeforeOverview, overflow }) => {
    // Given the original X binding, then the captured Y transition.
    const { overview, attached } = streams();
    await act(async () => {
      overview.message(wire.hello);
      attached.message(wire.hello);
      attached.message(wire.ready);
      for (const frame of wire.firstOverview) overview.message(frame);
      for (const key of feeds) attached.message(wire[key]);
      for (const frame of wire.movedOverview) overview.message({ ...frame, overflow });
    });
    await act(async () => root.render(createElement(Host, { fresh: true })));
    const fresh = Socket.instances[2];
    if (fresh === undefined) throw new TypeError("Missing new attached client");
    await act(async () => {
      fresh.open();
      fresh.message(wire.hello);
      if (readyBeforeOverview) fresh.message(wire.newReady);
      for (const frame of wire.returnedOverview) overview.message({ ...frame, overflow });
      if (!readyBeforeOverview) fresh.message(wire.newReady);
    });
    const before = snapshot();
    expect(before.badges).toEqual(["2", "2"]);
    expect(before.authority).toEqual([]);
    // When current-binding events follow the ready on the new attached socket.
    const currentFeeds = { task: wire.freshTask, dag: wire.freshDag, activity: wire.freshActivity };
    await act(async () => {
      for (const frame of wire.freshAttachedFrames) {
        if (JSON.stringify(frame) === JSON.stringify(currentFeeds[feed])) break;
        fresh.message(frame);
      }
    });
    const beforeFeed = snapshot();
    const beforeOverrideReference = overrides;
    await act(async () => fresh.message(currentFeeds[feed]));
    const after = snapshot();
    // Then a legitimate current binding remains writable in either cross-stream ordering.
    expect(overrides).not.toBe(beforeOverrideReference);
    expect(aggregates.get("A")).toEqual({ running: 2, total: 2 });
    expect(overrides.has("A")).toBe(true);
    expect(after.badges).toEqual(before.badges);
  });

