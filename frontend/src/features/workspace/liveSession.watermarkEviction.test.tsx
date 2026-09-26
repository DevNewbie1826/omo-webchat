import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { __resetLiveBadgeStoreForTests, ingestExtensionEvent, useLiveAgentAggregates, useMergedLiveSummaries } from "./liveBadgeStore";
import { __liveIdentitySnapshotForTests, admitCurrentLiveFrame } from "./liveSessionIdentity";
import { LiveSessionList } from "./LiveSessionList";
import { useLiveSessionInfos } from "./useLiveSessions";
import { useLiveSessionSummaries } from "./useLiveSessionSummaries";
import type { LiveSessionInfo } from "./useLiveSessionsLean";
import type { Workspace } from "./workspace";

class Socket {
  static readonly OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  constructor(_url: string) { Socket.instances.push(this); }
  send(_data: string): void {}
  close(): void { this.readyState = 3; }
  open(): void {
    this.readyState = Socket.OPEN;
    this.onopen?.(new Event("open"));
  }
  message(input: object): void {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(input) }));
  }
}

const instanceId = "2UKWK472TABDRBYGBP4CRJZXXZ";
const workspaces: readonly Workspace[] = [{
  id: "workspace", name: "Workspace", path: "/tmp",
  chats: ["A", "B"].map((id) => ({ id, name: id, provider: "omo" })),
}];
const row = (id: string, durable: string, revision: number, tasks = 1) => ({
  id, durableSessionId: durable, last_activity_ms: revision, title: id, active: false,
  running: { agents: tasks, tasks, dag: 0 },
});
const frame = (id: string, durable: string, revision: number, overflow: boolean) => ({
  type: "sessions.activity", sessionId: id, ...row(id, durable, revision, 2), overflow,
  done: 0, dag_done: 0, dag_total: 0, truncated: { dag: false, task: false },
});
function snapshotRows(count: number): readonly object[] {
  const start = Math.max(0, count - 255);
  return [row("B", "X", 1020, 2),
    ...Array.from({ length: count - start }, (_, n) =>
      row(`churn-${start + n}`, `churn-${start + n}`, 1030 + start + n))];
}
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
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
function socket(): Socket {
  const current = Socket.instances[0];
  if (current === undefined) throw new TypeError("Expected current socket");
  return current;
}
async function settle(sessions: readonly object[]): Promise<void> {
  await act(async () => {
    resolveResponse(new Response(JSON.stringify({ instanceId, sessions })));
    await response;
  });
}
async function poll(sessions: readonly object[]): Promise<void> {
  deferResponse();
  await act(async () => vi.advanceTimersByTimeAsync(4000));
  await settle(sessions);
}
function badges(): (string | null)[] {
  return [...container.querySelectorAll(".th-overview-card-running")].map((el) => el.textContent);
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("WebSocket", Socket);
  Socket.instances = [];
  __resetLiveBadgeStoreForTests();
  deferResponse();
  vi.stubGlobal("fetch", vi.fn(() => response));
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

it.each([400, 600].flatMap((count) => [false, true].map((overflow) => ({ count, overflow }))))(
  "rejects queued A:X after $count newer REST identities (overflow=$overflow)", async ({ count, overflow }) => {
  // Given the captured sequence: A:X, newer REST A:Y, then B:X and up to
  // 600 newer identities across full REST snapshots on one current connection.
  act(() => { socket().open(); socket().message({ type: "hello", version: 3, serverVersion: "1.2.3", instanceId }); });
  await settle([]);
  deferResponse();
  await act(async () => vi.advanceTimersByTimeAsync(4000));
  act(() => socket().message(frame("A", "X", 1000, false)));
  await settle([row("A", "Y", 1010, 3)]);
  for (let size = 200; size <= count; size += 200) {
    await poll(snapshotRows(size));
  }
  expect(Socket.instances).toHaveLength(1);
  expect(socket().readyState).toBe(Socket.OPEN);
  expect(infos.some((info) => info.id === "A")).toBe(false);
  act(() => ingestExtensionEvent("B", "omo.dag.updated", { agent_running_count: 9 }, undefined, 1021));
  const beforeBadges = badges();
  expect(beforeBadges).toEqual(["2", "2"]);
  expect(__liveIdentitySnapshotForTests().owners["X"]).toBe("B");

  // When the older A:X publication arrives on that same socket.
  act(() => socket().message(frame("A", "X", 1005, overflow)));

  // Then neither pinned/home cards nor the durable's authority roll back.
  expect(infos.some((info) => info.id === "A")).toBe(false);
  expect(__liveIdentitySnapshotForTests().owners["X"]).toBe("B");
  expect(badges()).toEqual(beforeBadges);
  expect(aggregates.get("B")?.running).toBe(9);
});

it.each([255, 256, 600].flatMap((count) => [false, true].map((overflow) => ({ count, overflow }))))(
  "keeps REST-retained A:X resident after $count unrelated pushes (overflow=$overflow)", async ({ count, overflow }) => {
  // Given a REST row followed by its first WS publication and DAG authority.
  act(() => { socket().open(); socket().message({ type: "hello", version: 3, serverVersion: "1.2.3", instanceId }); });
  await settle([]);
  await poll([row("A", "X", 1000)]);
  act(() => {
    socket().message(frame("A", "X", 1000, false));
    ingestExtensionEvent("A", "omo.dag.updated", { agent_running_count: 9 }, undefined, 1001);
  });
  const retained = infos.find((info) => info.id === "A");
  expect(__liveIdentitySnapshotForTests().owners["X"]).toBe("A");
  expect(aggregates.get("A")?.running).toBe(9);

  // When socket-ordered publications exceed the former 256-entry limit.
  act(() => {
    for (let index = 0; index < count; index += 1) {
      socket().message(frame(`churn-${index}`, `churn-${index}`, 1100 + index,
        index === count - 1 && overflow));
    }
  });

  // Then the rendered REST row retains its identity and task authority.
  expect(infos.find((info) => info.id === "A")).toEqual(retained);
  expect(__liveIdentitySnapshotForTests().owners["X"]).toBe("A");
  expect(aggregates.get("A")?.running).toBe(9);
  expect(admitCurrentLiveFrame({
    kind: "push", chatId: "A", durableId: "X", receipt: 1000, sequence: 10000,
  }).accept).toBe(true);
});

it.each([255, 256, 600].flatMap((count) => [false, true].map((overflow) => ({ count, overflow }))))(
  "keeps a newer A publication past a pending empty REST after $count pushes (overflow=$overflow)", async ({ count, overflow }) => {
  // Given A is REST-retained, then a request captures its temporary absence.
  act(() => { socket().open(); socket().message({ type: "hello", version: 3, serverVersion: "1.2.3", instanceId }); });
  await settle([]);
  await poll([row("A", "X", 1000)]);
  act(() => socket().message(frame("A", "X", 1000, false)));
  deferResponse();
  await act(async () => vi.advanceTimersByTimeAsync(4000));

  // When A reopens and newer ordered publications overtake that response.
  act(() => {
    socket().message(frame("A", "X", 1010, false));
    ingestExtensionEvent("A", "omo.dag.updated", { agent_running_count: 9 }, undefined, 1011);
    for (let index = 0; index < count; index += 1) {
      socket().message(frame(`fence-churn-${index}`, `fence-churn-${index}`, 1012 + index,
        index === count - 1 && overflow));
    }
  });
  const before = infos.find((info) => info.id === "A");
  expect(before?.lean?.running?.tasks).toBe(2);
  expect(aggregates.get("A")?.running).toBe(9);
  expect(Socket.instances).toHaveLength(1);
  await settle([]);

  // Then the stale omission cannot retire the row, its owner or authority.
  expect(infos.find((info) => info.id === "A")).toEqual(before);
  expect(__liveIdentitySnapshotForTests().owners["X"]).toBe("A");
  expect(aggregates.get("A")?.running).toBe(9);
  expect(badges()).toEqual(["2", "2"]);

  // An unchanged fresh REST observation still acknowledges that same row.
  await poll([row("A", "X", 1010, 2)]);
  expect(infos.find((info) => info.id === "A")?.lean?.running?.tasks).toBe(2);
});

it("keeps authority for a resident row after 600 other resident authorities", async () => {
  // Given A owns X and its attached DAG reports nine running agents.
  act(() => { socket().open(); socket().message({ type: "hello", version: 3, serverVersion: "1.2.3", instanceId }); });
  await settle([]);
  act(() => {
    socket().message(frame("A", "X", 1000, false));
    ingestExtensionEvent("A", "omo.dag.updated", { agent_running_count: 9 }, undefined, 1001);
  });

  // When other rendered, durable-owning rows publish their own DAG authority.
  act(() => {
    for (let index = 0; index < 600; index += 1) {
      const id = `resident-${index}`;
      socket().message(frame(id, id, 1010 + index, false));
      ingestExtensionEvent(id, "omo.dag.updated", { agent_running_count: 1 }, undefined, 1011 + index);
    }
  });

  // Then the bounded authority cache cannot discard A while it remains resident.
  expect(infos.some((info) => info.id === "A")).toBe(true);
  expect(__liveIdentitySnapshotForTests().owners["X"]).toBe("A");
  expect(aggregates.get("A")?.running).toBe(9);
});

it("accepts a newly exposed retired row above the eviction floor", async () => {
  // Given A:Y has retired and 600 newer resident identities have evicted its
  // watermark, while B:X remains the resident durable owner.
  act(() => { socket().open(); socket().message({ type: "hello", version: 3, serverVersion: "1.2.3", instanceId }); });
  await settle([]);
  await poll([row("A", "Y", 1010)]);
  for (const count of [200, 400, 600]) await poll(snapshotRows(count));
  expect(infos.some((info) => info.id === "A")).toBe(false);
  expect(__liveIdentitySnapshotForTests().owners["X"]).toBe("B");

  // B's resident watermark permits its identical replay even though the
  // global eviction floor has advanced beyond B's original revision.
  expect(admitCurrentLiveFrame({
    kind: "push", chatId: "B", durableId: "X", receipt: 1020, sequence: 1,
  }).accept).toBe(true);

  // An older third claimant cannot bypass the eviction floor.
  act(() => socket().message(frame("C", "X", 1015, false)));
  expect(infos.some((info) => info.id === "C")).toBe(false);
  expect(__liveIdentitySnapshotForTests().owners["X"]).toBe("B");

  // When the server re-exposes A with a newly issued revision above the floor.
  act(() => socket().message(frame("A", "Y", 2000, false)));

  // Then its new identity is admitted without rolling back B:X.
  expect(infos.find((info) => info.id === "A")?.durableSessionId).toBe("Y");
  expect(infos.find((info) => info.id === "A")?.lean?.last_activity_ms).toBe(2000);
  expect(__liveIdentitySnapshotForTests().owners).toMatchObject({ X: "B", Y: "A" });
});
