import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { connectChat, type ChatHandlers, type ChatServerFrame } from "../../lib/chatWs";
import { useLiveSessionSummaries, type LiveSessionSummary } from "./useLiveSessionSummaries";
import { __resetLiveBadgeStoreForTests, ingestExtensionEvent, useMergedLiveSummaries } from "./liveBadgeStore";
vi.mock("../../lib/chatWs", async importOriginal => ({ ...await importOriginal<object>(), connectChat: vi.fn() }));
const t1 = "2026-09-07T10:01:00Z", t2 = "2026-09-07T10:02:00Z", t3 = "2026-09-07T10:03:00Z";
const row = (status: string, updated_at: string, task_id = "child-1", extra = {}) => ({ task_id, name: task_id, status, updated_at, ...extra });
const payload = (status: string, at: string) => ({ tasks: [row(status, at)] });

describe("canonical task authority through all sidebar sources", () => {
  let root: Root, container: HTMLDivElement, handlers: ChatHandlers;
  let requests: ((response: Response) => void)[];
  let overview: readonly LiveSessionSummary[], merged: readonly LiveSessionSummary[];
  function Host() { overview = useLiveSessionSummaries(true); merged = useMergedLiveSummaries(overview); return null; }
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-07T10:03:00Z"));
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); __resetLiveBadgeStoreForTests(); requests = [];
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => requests.push(resolve))));
    vi.mocked(connectChat).mockImplementation(h => { handlers = h; return { send: () => true, close: () => undefined }; });
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    act(() => root.render(<Host />));
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
  async function poll(task: unknown, id = "s", extra = {}) {
    const resolve = requests.shift(); expect(resolve).toBeTypeOf("function");
    await act(async () => resolve!(new Response(JSON.stringify({ sessions: [{ id, title: id, task, dag: null, ...extra }] }))));
  }
  function push(task: unknown, id = "s", extra = {}) {
    act(() => handlers.onFrame({ type: "sessions.activity", sessionId: id, durableSessionId: id,
      snapshots: [{ name: "omo.task.updated", data: task, oversized: false }], overflow: false, ...extra } as ChatServerFrame));
  }
  function counts(done: number, running: number) {
    expect(overview[0]).toMatchObject({ doneCount: done, runningCount: running });
    expect(merged[0]).toMatchObject({ doneCount: done, runningCount: running });
  }
  it.each(["REST first", "WS first"])("rejects stale input in both source orders: %s, including close and TTL", async order => {
    if (order === "REST first") { await poll(payload("completed", t2)); push(payload("running", t1)); }
    else { push(payload("completed", t2)); await poll(payload("running", t1)); }
    counts(1, 0);
    act(() => ingestExtensionEvent("s", "omo.task.updated", payload("running", t1)));
    counts(1, 0);
    act(() => handlers.onClose?.(1006)); counts(1, 0);
    await act(async () => vi.advanceTimersByTimeAsync(106_000)); counts(1, 0);
  });
  it("shares attached correction and revival with overview rather than electing a whole side", async () => {
    await poll(payload("running", t1));
    act(() => ingestExtensionEvent("s", "omo.task.updated", { tasks: [row("completed", t1, "child-1", { raw_status: "running" })] }));
    counts(1, 0); push(payload("running", t1)); counts(1, 0);
    push(payload("running", t2)); counts(0, 1);
    act(() => ingestExtensionEvent("s", "omo.task.updated", { tasks: [row("completed", t1, "child-1", { raw_status: "running" })] }));
    counts(0, 1);
  });
  it("takes the server running scalar as the badge authority through the REST authority chain", async () => {
    await poll(null, "s", { task_oversized: true, task_digest: { tasks: [
      { task_id: "child-1", status: "running", updated_at: t3 }], truncated: true, running_count: 3, total_count: 9 } });
    counts(0, 3);
    expect(merged[0]).toMatchObject({ runningCount: 3 });
  });

  it("keeps compact correction authority over stale/equal rich enrichment", async () => {
    await poll(null, "s", { task_oversized: true, task_digest: { tasks: [
      { task_id: "child-1", status: "completed", raw_status: "running", updated_at: t2 }], truncated: true } });
    counts(1, 0); push(payload("running", t1)); counts(1, 0);
    push({ tasks: [row("running", t2, "child-1", { name: "Enriched", task_summary: "details" })] });
    counts(1, 0);
    expect(merged[0]?.task).toMatchObject({ tasks: [expect.objectContaining({ name: "Enriched", status: "completed" })] });
    push(payload("running", t3)); counts(0, 1);
  });
  it("merges alias chains and conflicting rows per ID, retaining old aliases", async () => {
    await poll(null, "route");
    act(() => ingestExtensionEvent("durable", "omo.task.updated", { tasks: [row("completed", t2), row("running", t1, "other")] }));
    act(() => ingestExtensionEvent("route", "omo.task.updated", { tasks: [row("running", t1), row("completed", t2, "other")] }));
    push({ tasks: [], truncated_tasks: true }, "route", { durableSessionId: "durable", replacesSessionId: "durable" });
    counts(2, 0);
    push({ tasks: [], truncated_tasks: true }, "new-route", { durableSessionId: "route", replacesSessionId: "route" });
    act(() => ingestExtensionEvent("durable", "omo.task.updated", { tasks: [row("running", t3)], truncated_tasks: true }));
    const summary = merged.find(item => item.id === "new-route");
    expect(summary).toMatchObject({ doneCount: 1, runningCount: 1 });
  });
  it("keeps exact activity touches through a complete REST omission", async () => {
    await poll({ tasks: [row("running", t1, "active"), row("completed", t2, "untouched")] });
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    act(() => ingestExtensionEvent("s", "omo.dag.activity", { runId: "r", nodeId: "n", taskId: "active", at: t3, activity: "work" }));
    await poll({ tasks: [] });
    counts(0, 1);
  });

  it("retains omission watermarks across alias migration and admits only newer reappearance", async () => {
    await poll(payload("running", t2), "route");
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    await poll({ tasks: [] }, "route"); counts(0, 0);
    act(() => ingestExtensionEvent("durable", "omo.task.updated", payload("completed", t1)));
    push({ tasks: [], truncated_tasks: true }, "route", { durableSessionId: "durable", replacesSessionId: "durable" });
    counts(0, 0);
    push(payload("running", t2), "durable"); counts(0, 0);
    push(payload("running", t3), "durable"); counts(0, 1);
  });

  it("routes overview pushes through old multi-hop aliases without duplicating session membership", async () => {
    await poll(null, "route");
    push(payload("completed", t2), "route", { durableSessionId: "durable", replacesSessionId: "durable" });
    push({ tasks: [], truncated_tasks: true }, "new-route", { durableSessionId: "route", replacesSessionId: "route" });
    push(payload("running", t3), "durable");
    expect(overview.map(item => item.id)).toEqual(["new-route"]);
    counts(0, 1);
  });

  it.each([null, 42, {}, [], false, "2026-02-30T00:00:00Z"].map(updated_at => ({ updated_at })))("keeps complete poll membership with malformed raw clock $updated_at", async ({ updated_at }) => {
    await poll(payload("completed", t2));
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    await poll({ tasks: [{ ...row("running", t1), updated_at }] }); counts(1, 0);
  });

  it("uses complete compact membership even when the rich projection cannot fit", async () => {
    await poll(payload("running", t2));
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    await poll(null, "s", { task_oversized: true, task_digest: { tasks: [], truncated: false } });
    counts(0, 0);
    push(payload("running", t2)); counts(0, 0);
    push(payload("running", t3)); counts(0, 1);
  });

  it("keeps oversized-without-digest pushes inert over a stale rich replay", async () => {
    await poll(payload("running", t2));
    push(null, "s", { snapshots: [{ name: "omo.task.updated", data: null, oversized: true }] });
    counts(0, 0);
    push(payload("running", t1));
    counts(0, 0);
    push(payload("running", t3));
    counts(0, 1);
  });

  it("does not retire canonical task authority when a replaced alias receives its tombstone", async () => {
    await poll(payload("completed", t2), "route");
    push(payload("completed", t2), "route", { durableSessionId: "durable", replacesSessionId: "durable" });
    act(() => ingestExtensionEvent("route", "omo.task.updated", payload("running", t3)));
    counts(0, 1);
    push(null, "durable", { snapshots: [], tombstone: true });
    counts(0, 1);
  });

  it.each(["completed", "failed"])("keeps canonical %s correction over an equal-raw conflicting alias correction", async status => {
    const correction = (effective: string, name: string) => ({ tasks: [row(effective, t2, "child-1", { name, raw_status: "running" })] });
    await poll(correction(status, "Canonical"), "route");
    act(() => ingestExtensionEvent("durable", "omo.task.updated", correction(status === "completed" ? "failed" : "completed", "Alias")));
    push({ tasks: [], truncated_tasks: true }, "route", { durableSessionId: "durable", replacesSessionId: "durable" });
    expect(overview[0]?.task).toMatchObject({ tasks: [expect.objectContaining({ status, name: "Canonical", raw_status: "running", updated_at: t2 })] });
    expect(merged[0]?.task).toMatchObject({ tasks: [expect.objectContaining({ status, name: "Canonical", raw_status: "running", updated_at: t2 })] });
  });

});
