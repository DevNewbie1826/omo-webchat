import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { connectChat } from "../../lib/chatWs";
import { useChatSession } from "../split/useChatSession";
import { LiveSessionList } from "./LiveSessionList";
import {
  __resetLiveBadgeStoreForTests, projectLiveTaskInfo, useLiveAgentAggregates,
  useLiveBadgeOverrides, useMergedLiveSummaries,
} from "./liveBadgeStore";
import { __liveIdentitySnapshotForTests } from "./liveSessionIdentity";
import { crossChatWire as wire } from "./liveSession.crossChat.fixture";
import { useLiveSessionInfos } from "./useLiveSessions";
import { useLiveSessionSummaries } from "./useLiveSessionSummaries";
import type { Workspace } from "./workspace";

// Only network delivery is controlled; both connectors and stores are real.
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
  chats: [{ id: "A", name: "A", provider: "omo" }, { id: "B", name: "B", provider: "omo" }],
}];
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let infos: ReturnType<typeof useLiveSessionInfos>;
let aggregates: ReturnType<typeof useLiveAgentAggregates>;
let overrides: ReturnType<typeof useLiveBadgeOverrides>;

function FreshAttached() {
  useChatSession({ ...session, id: "B", name: "B" }, connectChat);
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
    badges: [...container.querySelectorAll(".th-overview-card-running")].map((el) => el.textContent),
  };
}
function streams() {
  const overview = Socket.instances.find((s) => s.sent.some((data) => JSON.parse(data).type === "sessions.subscribe"));
  const attached = Socket.instances.find((s) => s.sent.some((data) => JSON.parse(data).type === "chat.create"));
  if (overview === undefined || attached === undefined) throw new TypeError("Missing production streams");
  return { overview, attached };
}
beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("WebSocket", Socket);
  Socket.instances = [];
  __resetLiveBadgeStoreForTests();
  const response = new Promise<Response>(() => undefined);
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

it.each(feeds.flatMap((feed) => [false, true].flatMap((lateReady) =>
  [false, true].map((overflow) => ({ feed, lateReady, overflow })))))
  ("rejects replaced chat A source: feed=$feed lateReady=$lateReady overflow=$overflow",
    async ({ feed, lateReady, overflow }) => {
      // Given A's accepted binding, followed by B's newer replacement on X.
      const { overview, attached } = streams();
      await act(async () => {
        overview.message(wire.hello);
        attached.message(wire.hello);
        if (!lateReady) attached.message(wire.ready);
        for (const frame of wire.firstOverview) overview.message(frame);
        for (const frame of wire.returnedOverview) overview.message({ ...frame, overflow });
      });
      expect(infos.map((row) => row.id)).toEqual(["B"]);
      expect(snapshot().badges).toEqual(["2", "2"]);
      expect(aggregates.has("A")).toBe(false);
      expect(__liveIdentitySnapshotForTests().rows["A"]?.removed).toBe(true);
      // When A's buffered ready and task/DAG/activity events arrive afterward.
      await act(async () => {
        if (lateReady) attached.message(wire.ready);
        for (const prior of feeds.slice(0, feeds.indexOf(feed))) {
          attached.message({ ...wire[prior], revision: 1790446082818 + feeds.indexOf(prior) });
        }
      });
      const before = snapshot();
      const reference = overrides;
      await act(async () => attached.message({ ...wire[feed], revision: 1790446082820 }));
      // Then neither the authority nor either visible badge is replaced by A.
      expect(overrides).toBe(reference);
      expect(snapshot()).toEqual(before);
    });

it.each(feeds.flatMap((feed) => [false, true].flatMap((readyBeforeOverview) =>
  [false, true].map((overflow) => ({ feed, readyBeforeOverview, overflow })))))
  ("accepts current chat B source: feed=$feed readyBeforeOverview=$readyBeforeOverview overflow=$overflow",
    async ({ feed, readyBeforeOverview, overflow }) => {
      const { overview, attached } = streams();
      await act(async () => {
        overview.message(wire.hello);
        attached.message(wire.hello);
        attached.message(wire.ready);
        for (const frame of wire.firstOverview) overview.message(frame);
      });
      await act(async () => root.render(createElement(Host, { fresh: true })));
      const fresh = Socket.instances[2];
      if (fresh === undefined) throw new TypeError("Missing replacement chat socket");
      // Given B's own binding and ready, on either side of the overview update.
      await act(async () => {
        fresh.open();
        fresh.message(wire.hello);
        if (readyBeforeOverview) fresh.message(wire.newReady);
        for (const frame of wire.returnedOverview) overview.message({ ...frame, overflow });
        if (!readyBeforeOverview) fresh.message(wire.newReady);
      });
      const currentFeeds = { task: wire.freshTask, dag: wire.freshDag, activity: wire.freshActivity };
      await act(async () => {
        for (const frame of wire.freshAttachedFrames) {
          if (JSON.stringify(frame) === JSON.stringify(currentFeeds[feed])) break;
          fresh.message(frame);
        }
      });
      const reference = overrides;
      // When B publishes attached data, it retains the two-task authority.
      await act(async () => fresh.message(currentFeeds[feed]));
      expect(overrides).not.toBe(reference);
      expect(aggregates.get("B")).toEqual({ running: 2, total: 2 });
      expect(aggregates.has("A")).toBe(false);
      expect(snapshot().badges).toEqual(["2", "2"]);
    });
