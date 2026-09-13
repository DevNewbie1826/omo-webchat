import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { connectChat, parseChatServerFrame } from "../../lib/chatWs";
import type { ChatHandlers } from "../../lib/chatWs";
import { useLiveSessionSummaries } from "./useLiveSessionSummaries";
import type { LiveSessionSummary } from "./useLiveSessionSummaries";
import { __resetLiveBadgeStoreForTests, ingestExtensionEvent, useMergedLiveSummaries } from "./liveBadgeStore";

vi.mock("../../lib/chatWs", async original => ({ ...await original<object>(), connectChat: vi.fn() }));
const completed = { last_activity_ms: 200, running: { agents: 0, tasks: 0, dag: 0 }, done: 2, dag_done: 1, dag_total: 1 };
const running = { last_activity_ms: 100, running: { agents: 3, tasks: 2, dag: 2 }, done: 0, dag_done: 0, dag_total: 1 };

describe("lean revision authority through both sidebar sources", () => {
  let root: Root;
  let container: HTMLDivElement;
  let handlers: ChatHandlers;
  let requests: ((response: Response) => void)[];
  let overview: readonly LiveSessionSummary[];
  let merged: readonly LiveSessionSummary[];
  function Host(): null {
    overview = useLiveSessionSummaries(true);
    merged = useMergedLiveSummaries(overview);
    return null;
  }
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    __resetLiveBadgeStoreForTests();
    requests = [];
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => requests.push(resolve))));
    vi.mocked(connectChat).mockImplementation(h => {
      handlers = h;
      return { send: () => true, close: () => undefined };
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(<Host />));
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    __resetLiveBadgeStoreForTests();
  });
  async function poll(fields: object, id = "s"): Promise<void> {
    const resolve = requests.shift();
    if (resolve === undefined) throw new TypeError("No pending live request");
    await act(async () => resolve(new Response(JSON.stringify({ sessions: [{ id, title: id, ...fields }] }))));
  }
  function push(fields: object, id = "s"): void {
    const parsed = parseChatServerFrame({ type: "sessions.activity", sessionId: id, durableSessionId: id,
      overflow: false, ...fields });
    if (parsed === null) throw new TypeError("Invalid lean fixture");
    act(() => handlers.onFrame(parsed));
  }
  function counts(done: number, agents: number): void {
    expect(overview[0]).toMatchObject({ doneCount: done, runningCount: agents });
    expect(merged[0]).toMatchObject({ doneCount: done, runningCount: agents });
  }

  it.each(["REST first", "WS first"])("rejects stale revisions when source order is %s", async order => {
    // Given completed server work; when an older transport delivery arrives.
    if (order === "REST first") { await poll(completed); push(running); }
    else { push(completed); await poll(running); }
    // Then neither consumer resurrects running work.
    counts(2, 0);
  });
  it.each(["omo.task.updated", "omo.dag.updated"])("keeps lean completion when attached %s conflicts", async name => {
    // Given authoritative completion on the live surface.
    await poll(completed);
    // When the attached surface supplies conflicting task/DAG aggregates.
    act(() => ingestExtensionEvent("s", name, { tasks: [], runs: [], agent_running_count: 99 }));
    // Then attached topology cannot recount live work.
    counts(2, 0);
  });
  it.each([3, 50])("retains exact count %s when topology is truncated", async agents => {
    // Given a poll with server-side deduplication and no retained topology.
    // When the lean scalar and qualification are delivered together.
    await poll({ ...running, running: { agents, tasks: 80, dag: 70 }, truncated: { task: true, dag: true } });
    // Then counts stay exact and qualification remains separate.
    counts(0, agents);
    expect(merged[0]).toMatchObject({ taskSideOversized: true, dagSideOversized: true });
  });
  it("accepts completion when its server revision is newer than a running poll", async () => {
    // Given running work accepted from REST.
    await poll(running);
    // When a later complete revision arrives over WS.
    push(completed);
    // Then explicit zeros and completion totals win.
    counts(2, 0);
    expect(merged[0]).toMatchObject({ dagDone: 1, dagTotal: 1 });
  });
  it("admits new work when its revision postdates completion", async () => {
    // Given a completed revision.
    await poll(completed);
    // When a genuinely newer server revision starts new work.
    push({ ...running, last_activity_ms: 300 });
    // Then the completion fence is not a permanent terminal latch.
    counts(0, 3);
  });
  it("routes old multi-hop aliases when a newer lean revision arrives", async () => {
    // Given canonical membership remapped twice.
    await poll(completed, "route");
    push({ ...completed, durableSessionId: "durable" }, "route");
    push({ ...completed, durableSessionId: "route" }, "new-route");
    // When the old durable identity publishes newer work.
    push({ ...running, last_activity_ms: 300 }, "durable");
    // Then a single canonical row advances, without duplicate membership.
    expect(overview.map(item => item.id)).toEqual(["new-route"]);
    counts(0, 3);
  });
  it.each([null, 42, {}, [], false, "invalid"])("ignores removed raw clocks when updated_at=%j", async updated_at => {
    // Given irrelevant legacy keys beside a valid lean revision.
    // When the REST boundary parses the delivery.
    await poll({ ...completed, task: { tasks: [{ task_id: "t", status: "running", updated_at }] } });
    // Then unknown topology cannot corrupt exact counts or membership.
    counts(2, 0);
  });
  it("retains count authority when a replaced alias receives a tombstone", async () => {
    // Given active canonical membership and a known durable alias.
    await poll({ ...running, active: true }, "route");
    push({ ...running, active: true, durableSessionId: "durable" }, "route");
    // When an internal tombstone retires only the replaced identity.
    act(() => handlers.onFrame({ type: "sessions.activity", sessionId: "durable", durableSessionId: "durable",
      overflow: false, ...{ tombstone: true } }));
    // Then canonical work is untouched.
    counts(0, 3);
    expect(overview[0]?.active).toBe(true);
  });
  it("keeps counts after disconnect when only main activity is fenced", async () => {
    // Given completed server counts and active main work.
    await poll({ ...completed, active: true });
    // When the socket disconnects.
    act(() => handlers.onClose?.(1006));
    // Then main activity clears without erasing exact child totals.
    counts(2, 0);
    expect(merged[0]?.active).toBe(false);
  });
  it("keeps unknown counts empty when an attached delivery offers a fallback", async () => {
    // Given membership without server agent scalars.
    await poll({ running: { tasks: 5, dag: 4 }, truncated: { task: true } });
    // When attached topology offers a conflicting aggregate.
    act(() => ingestExtensionEvent("s", "omo.task.updated", { tasks: [], agent_running_count: 99 }));
    // Then neither summation nor attached reconstruction invents agents.
    counts(0, 0);
    expect(merged[0]).toMatchObject({ dagRunning: 4, taskSideOversized: true });
  });
});
