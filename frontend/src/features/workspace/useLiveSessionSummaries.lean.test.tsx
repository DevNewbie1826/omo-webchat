import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectChat, parseChatServerFrame } from "../../lib/chatWs";
import type { ChatHandlers } from "../../lib/chatWs";
import { useLiveSessionSummaries } from "./useLiveSessionSummaries";
import type { LiveSessionSummary } from "./useLiveSessionSummaries";
import { __resetLiveBadgeStoreForTests, ingestExtensionEvent, useMergedLiveSummaries } from "./liveBadgeStore";

vi.mock("../../lib/chatWs", async original => ({ ...await original<object>(), connectChat: vi.fn() }));

const lean = {
  id: "s", title: "Lean", active: true, last_activity_ms: 200,
  running: { agents: 7, tasks: 5, dag: 4 }, done: 11, dag_done: 13, dag_total: 19,
  truncated: { task: true, dag: true }, last_line: "server progress",
};
const expected = {
  id: "s", title: "Lean", active: true, runningCount: 7, doneCount: 11,
  dagDone: 13, dagTotal: 19, dagRunning: 4, lastLine: "server progress",
  taskSideOversized: true, dagSideOversized: true,
};

describe("lean live-summary authority", () => {
  let root: Root;
  let container: HTMLDivElement;
  let handlers: ChatHandlers;
  let settle: (response: Response) => void;
  let overview: readonly LiveSessionSummary[];
  let merged: readonly LiveSessionSummary[];
  function Host(): null {
    overview = useLiveSessionSummaries(true);
    merged = useMergedLiveSummaries(overview);
    return null;
  }
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    __resetLiveBadgeStoreForTests();
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { settle = resolve; })));
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
    vi.unstubAllGlobals();
    __resetLiveBadgeStoreForTests();
  });
  async function poll(rows: readonly unknown[]): Promise<void> {
    await act(async () => settle(new Response(JSON.stringify({ sessions: rows }))));
  }
  function push(fields: object): void {
    const frame = parseChatServerFrame({ type: "sessions.activity", sessionId: "s", durableSessionId: "s",
      overflow: false, ...fields });
    if (frame === null) throw new TypeError("Invalid activity fixture");
    act(() => handlers.onFrame(frame));
  }
  it("flows exact counts and truncation through both consumers when REST contains only lean fields", async () => {
    // Given a mounted poller with no task or DAG payloads.
    // When the lean-only REST row settles.
    await poll([lean]);
    // Then the server values are numeric, unqualified counts, with truncation retained separately.
    expect(overview).toEqual([expect.objectContaining(expected)]);
    expect(merged).toEqual([expect.objectContaining(expected)]);
  });
  it("flows exact counts when the overview socket sends only lean fields", () => {
    // Given the mounted live subscription; when a lean-only frame arrives.
    push(lean);
    // Then both consumers receive the same exact server values.
    expect(overview).toEqual([expect.objectContaining(expected)]);
    expect(merged).toEqual([expect.objectContaining(expected)]);
  });
  it("keeps a completed lean revision when an older running WS frame arrives later", async () => {
    // Given the server's completed revision, including authoritative zeros.
    await poll([{ ...lean, active: false, running: { agents: 0, tasks: 0, dag: 0 } }]);
    // When a stale frame attempts to resurrect ended work.
    push({ ...lean, last_activity_ms: 199 });
    // Then neither surface moves backwards.
    expect(overview[0]).toMatchObject({ runningCount: 0, active: false, doneCount: 11 });
    expect(merged[0]).toMatchObject({ runningCount: 0, active: false, doneCount: 11 });
  });
  it("rejects a stale REST response when a newer lean WS revision was already accepted", async () => {
    // Given a push that overtook the in-flight REST request.
    push({ ...lean, active: false, running: { agents: 0, tasks: 0, dag: 0 } });
    // When the older running response settles.
    await poll([{ ...lean, last_activity_ms: 199 }]);
    // Then the server revision, not response arrival, elects counts.
    expect(overview[0]).toMatchObject({ runningCount: 0, active: false });
    expect(merged[0]).toMatchObject({ runningCount: 0, active: false });
  });
  it("accepts a newer server revision even when its REST request predates a push", async () => {
    // Given an earlier pushed snapshot during the request.
    push({ ...lean, last_activity_ms: 199 });
    // When REST supplies the later completion.
    await poll([{ ...lean, active: false, running: { agents: 0, tasks: 0, dag: 0 } }]);
    // Then no admission-sequence fallback masks the newer server revision.
    expect(overview[0]).toMatchObject({ runningCount: 0, active: false });
    expect(merged[0]).toMatchObject({ runningCount: 0, active: false });
  });
  it("does not degrade lean scalars when attached task and DAG snapshots disagree", async () => {
    // Given exact server-side deduplication and truncation qualification.
    await poll([lean]);
    // When legacy attached deliveries advertise conflicting aggregates.
    act(() => {
      ingestExtensionEvent("s", "omo.task.updated", { tasks: [], agent_running_count: 99 });
      ingestExtensionEvent("s", "omo.dag.updated", { runs: [], agent_running_count: 88 });
    });
    // Then both surfaces retain all lean scalars verbatim.
    expect(overview).toEqual([expect.objectContaining(expected)]);
    expect(merged).toEqual([expect.objectContaining(expected)]);
  });
  it("orders sessions by accepted last_activity_ms rather than transport order", async () => {
    // Given an older pushed revision for s.
    push(lean);
    // When REST lists a newer other session after an older s revision.
    await poll([{ ...lean, last_activity_ms: 100 }, { ...lean, id: "other", last_activity_ms: 150 }]);
    // Then accepted recency keeps s first (200, not 100).
    expect(overview.map(summary => summary.id)).toEqual(["s", "other"]);
    expect(merged.map(summary => summary.id)).toEqual(["s", "other"]);
  });
  it("keeps socket-close inactivity when an in-flight lean poll settles", async () => {
    // Given a lean push during the in-flight request (typed handler seam).
    act(() => handlers.onFrame({ type: "sessions.activity", sessionId: "s", durableSessionId: "s",
      overflow: false, ...lean }));
    act(() => handlers.onClose?.(1006));
    // When the outstanding response repeats the earlier active state.
    await poll([lean]);
    // Then the lifecycle fence still clears main work without changing child counts.
    expect(overview[0]).toMatchObject({ active: false, runningCount: 7 });
    expect(merged[0]).toMatchObject({ active: false, runningCount: 7 });
  });
  it("keeps lean authority when a frame omits all lean scalars", async () => {
    // Given a lean row.
    await poll([lean]);
    // When a metadata-only delivery has no count revision.
    push({});
    // Then the already accepted scalars remain authoritative.
    expect(overview).toEqual([expect.objectContaining(expected)]);
    expect(merged).toEqual([expect.objectContaining(expected)]);
  });
});
