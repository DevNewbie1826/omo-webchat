import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectChat, parseChatServerFrame, type ChatHandlers, type ChatServerFrame } from "../../lib/chatWs";
import { Sidebar } from "../../components/Sidebar";
import { useLiveSessionInfos } from "./useLiveSessions";
import { useLiveSessionSummaries, type LiveSessionSummary } from "./useLiveSessionSummaries";
import { __resetLiveBadgeStoreForTests, useMergedLiveSummaries } from "./liveBadgeStore";
import { listLiveSessions } from "./workspace";
import type { LiveSessionInfo } from "./useLiveSessionsLean";

vi.mock("../../lib/chatWs", async (original) => ({
  ...await original<typeof import("../../lib/chatWs")>(), connectChat: vi.fn(),
}));
vi.mock("../../lib/useMediaQuery", () => ({ useMediaQuery: () => false }));

function response(sessions: unknown[]): Response {
  return new Response(JSON.stringify({ sessions }), { headers: { "Content-Type": "application/json" } });
}
function jsonBody(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}
function deferred<T>() {
  let complete: ((value: T) => void) | undefined;
  const promise = new Promise<T>((done) => { complete = done; });
  return { promise, resolve(value: T) {
    if (complete === undefined) throw new Error("Deferred promise was not initialized");
    complete(value);
  } };
}
const base = { id: "s1", title: "Main", task: null, dag: null };
type ActivityFrame = Extract<ChatServerFrame, { readonly type: "sessions.activity" }>;
const wire: ActivityFrame = { type: "sessions.activity", sessionId: "s1", durableSessionId: "s1", overflow: false };

describe("main running transport and sidebar", () => {
  let root: Root;
  let container: HTMLDivElement;
  let handlers: ChatHandlers;
  let infos: readonly LiveSessionInfo[];
  let summaries: readonly LiveSessionSummary[];
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    __resetLiveBadgeStoreForTests();
    vi.mocked(connectChat).mockImplementation((next) => {
      handlers = next;
      return { send: vi.fn(), close: vi.fn() };
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    infos = []; summaries = [];
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    __resetLiveBadgeStoreForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  function Probe() {
    infos = useLiveSessionInfos(true);
    summaries = useMergedLiveSummaries(useLiveSessionSummaries(true));
    return null;
  }
  async function mount(sidebar = false) {
    await act(async () => {
      root.render(<><Probe />{sidebar && <Sidebar
        collapsed={false} onToggleCollapse={() => undefined}
        workspaces={[{ id: "w1", name: "Workspace", path: "/work", chats: [{ id: "s1", name: "Main", provider: "omo" }] }]}
        activeTerminalId={null} placedSessions={new Set(["s1"])} liveSessions={new Set(["s1"])} expanded={new Set(["w1"])}
        sessionLists={new Map([["w1", [{ id: "s1", name: "Main", source: "stored", recencyMs: 1 }]]])} sessionPages={new Map()}
        onToggleExpanded={() => undefined} onLoadMoreSessions={() => undefined} onSelectTerminal={() => undefined}
        onAddWorkspace={() => undefined} onAddTerminal={() => undefined}
        onDeleteWorkspace={() => undefined} onDeleteTerminal={() => undefined} onRenameWorkspace={async () => undefined}
        onRenameTerminal={async () => undefined} onLogout={() => undefined} notify={() => undefined}
      />}</>);
    });
  }
  function push(fields: Record<string, unknown>) {
    const parsed = parseChatServerFrame({ ...wire, ...fields });
    if (parsed === null) throw new Error("Activity frame did not parse");
    act(() => handlers.onFrame(parsed));
  }
  function active(): boolean | undefined { return infos[0]?.active; }

  it("parses optional booleans without inferring main activity from process membership", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response([
      { ...base, active: true }, { ...base, id: "s2", active: false }, { ...base, id: "s3", active: "yes" }, "legacy",
    ])));
    const parsed = await listLiveSessions();
    expect(parsed[0]).toMatchObject({ active: true });
    expect(parsed[1]).toMatchObject({ active: false });
    expect(parsed[2]).not.toHaveProperty("active");
    expect(parsed[3]).not.toHaveProperty("active");
    for (const value of [true, false]) expect(parseChatServerFrame({ ...wire, active: value })).toMatchObject({ active: value });
    expect(parseChatServerFrame(wire)).not.toHaveProperty("active");
    expect(parseChatServerFrame({ ...wire, active: "yes" })).toBeNull();
  });

  it.each([true, false])("protects active=%s from a late stale poll independently of task and DAG updates", async (value) => {
    const poll = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(() => poll.promise));
    await mount();
    push({ active: value });
    push({ running: { agents: 3 } });
    expect(active()).toBe(value);
    await act(async () => { poll.resolve(response([{ ...base, active: !value }])); await poll.promise; });
    expect(active()).toBe(value);
    expect(summaries[0]).toMatchObject({ active: value, runningCount: 3 });
  });

  it("pins main-only work, settles it, and never adds the main to exact child counts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response([{ ...base, active: false }])));
    await mount(true);
    // Idle live sessions keep their tree row; only the running indicators
    // disappear.
    expect(container.querySelector(".th-tree-children .th-tree-node")).not.toBeNull();
    expect(container.querySelector(".th-tree-children .th-tree-running")).toBeNull();
    push({ active: true });
    expect(container.querySelector(".th-tree-children .th-tree-running")).not.toBeNull();
    expect(container.querySelector(".th-tree-running--workspace")).not.toBeNull();
    expect(container.querySelector(".th-sidebar-live")).toBeNull();
    // Main-only work runs zero child agents: the chip falls back to the
    // main-running label instead of a misleading zero count.
    expect(summaries[0]).toMatchObject({ active: true, runningCount: 0 });
    expect(container.querySelector(".th-tree-live")).not.toBeNull();
    expect(container.querySelector(".th-tree-placed--on")).not.toBeNull();
    push({ running: { agents: 7 } });
    expect(summaries[0]).toMatchObject({ active: true, runningCount: 7 });
    for (const selector of [".th-tree-children .th-tree-running", ".th-tree-running--workspace"]) {
      expect(container.querySelector(selector)?.textContent).toBe("7");
    }
    // The visible count carries an accessible name saying what it counts.
    expect(container.querySelector(".th-tree-children .th-tree-running")?.getAttribute("aria-label"))
      .toBe("sidebar.tm.runningAgents");
    push({ active: false });
    expect(summaries[0]).toMatchObject({ active: false, runningCount: 7 });
    expect(container.querySelector(".th-tree-children .th-tree-running")?.textContent).toBe("7");
    push({ running: { agents: 0 } });
    expect(container.querySelector(".th-tree-children .th-tree-running")).toBeNull();
    push({ active: true });
    push({ active: false });
    expect(container.querySelector(".th-sidebar-live")).toBeNull();
    expect(container.querySelector(".th-tree-live")).not.toBeNull();
  });

  it("preserves activity across provisional remaps and one-sided updates", async () => {
    const poll = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(() => poll.promise));
    await mount();
    push({ sessionId: "durable", durableSessionId: "durable", active: true });
    // PR #197 server contract: replacesSessionId names a provisional of the
    // SAME durable, so s1 must claim durable before its one-sided update.
    push({ sessionId: "s1", durableSessionId: "durable", running: { dag: 0 }, replacesSessionId: "durable" });
    push({ sessionId: "s1", durableSessionId: "durable", running: { agents: 2 } });
    expect(infos).toHaveLength(1);
    expect(infos[0]).toMatchObject({ id: "s1", active: true });
    await act(async () => { poll.resolve(response([{ ...base, active: false }])); await poll.promise; });
    expect(active()).toBe(true);
  });

  it.each(["tombstone", "disconnect"])("authoritatively clears polled activity on %s and fences an in-flight poll", async (kind) => {
    vi.useFakeTimers();
    const stale = deferred<Response>();
    const fetchMock = vi.fn().mockResolvedValueOnce(response([{ ...base, active: true }])).mockReturnValueOnce(stale.promise);
    vi.stubGlobal("fetch", fetchMock);
    await mount();
    expect(active()).toBe(true);
    // Trigger the poller's scheduled request, not a timing-based wait for state.
    await act(async () => { await vi.advanceTimersToNextTimerAsync(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    if (kind === "tombstone") {
      // Tombstones are an existing internal transport identity extension.
      const tombstone: ActivityFrame & { readonly tombstone: true } = { ...wire, tombstone: true };
      act(() => handlers.onFrame(tombstone));
    } else act(() => handlers.onClose?.(1006));
    expect(active()).toBe(false);
    await act(async () => { stale.resolve(response([{ ...base, active: true }])); await stale.promise; });
    expect(active()).toBe(false);
  });

  // PR #197 server contract: stored rows use chat IDs; durable-keyed rows
  // exist only while unowned. A stale P-era REST row is ignored while the
  // full response retains s1's chat row with its known `active`.
  it.each([true, false])("keeps known active=%s when a claimed durable's stale REST row arrives", async (value) => {
    vi.useFakeTimers();
    const next = deferred<Response>();
    const pollResponses: readonly (Response | Promise<Response>)[] = [
      response([{ ...base, id: "durable", active: value }]), next.promise,
    ];
    let liveCalls = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL): Promise<Response> | Response => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      // The sidebar's membership crawl uses the per-workspace catalog endpoint,
      // not the shared live-sessions poll queue.
      if (!url.includes("/api/sessions/live")) return jsonBody({ items: [], nextCursor: "" });
      const responded = pollResponses[liveCalls];
      liveCalls += 1;
      if (responded === undefined) throw new Error("Unexpected /api/sessions/live fetch");
      return responded;
    }));
    await mount(true);
    expect(infos).toMatchObject([{ id: "durable", active: value }]);
    push({ sessionId: "s1", durableSessionId: "durable" });
    expect(infos).toMatchObject([{ id: "s1", active: value }]);
    // Trigger the poller's scheduled request, then settle it deterministically.
    await act(async () => { await vi.advanceTimersToNextTimerAsync(); });
    expect(liveCalls).toBe(2);
    await act(async () => {
      next.resolve(response([{ ...base }, { ...base, id: "durable" }]));
      await next.promise;
    });
    expect(infos).toMatchObject([{ id: "s1", active: value }]);
    expect(summaries[0]).toMatchObject({ id: "s1", active: value, runningCount: 0 });
    if (value) {
      expect(container.querySelector(".th-tree-children .th-tree-running")).not.toBeNull();
      expect(container.querySelector(".th-tree-running--workspace")).not.toBeNull();
      expect(container.querySelector(".th-sidebar-live")).toBeNull();
    } else {
      // Idle sessions keep their row; they just carry no running badge.
      expect(container.querySelector(".th-tree-children .th-tree-node")).not.toBeNull();
      expect(container.querySelector(".th-tree-children .th-tree-running")).toBeNull();
      expect(container.querySelector(".th-sidebar-live")).toBeNull();
    }
  });

  it.each([true, false])("carries known active=%s across a poll row keyed by the canonical chat id", async (value) => {
    vi.useFakeTimers();
    const next = deferred<Response>();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response([{ ...base, id: "durable", active: value }]))
      .mockReturnValueOnce(next.promise)
      .mockResolvedValue(response([{ ...base }]));
    vi.stubGlobal("fetch", fetchMock);
    await mount();
    expect(infos).toMatchObject([{ id: "durable", active: value }]);
    push({ sessionId: "s1", durableSessionId: "durable" });
    expect(infos).toMatchObject([{ id: "s1", active: value }]);
    await act(async () => { await vi.advanceTimersToNextTimerAsync(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => { next.resolve(response([{ ...base }])); await next.promise; });
    expect(infos).toMatchObject([{ id: "s1", active: value }]);
  });

  it("lets a newer explicit poll value replace the retained main activity", async () => {
    vi.useFakeTimers();
    const second = deferred<Response>();
    const third = deferred<Response>();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response([{ ...base, id: "durable", active: true }]))
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);
    vi.stubGlobal("fetch", fetchMock);
    await mount();
    push({ sessionId: "s1", durableSessionId: "durable" });
    await act(async () => { await vi.advanceTimersToNextTimerAsync(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // PR #197 server contract: after claim REST is chat-keyed, not durable-keyed.
    await act(async () => { second.resolve(response([{ ...base }])); await second.promise; });
    expect(infos).toMatchObject([{ id: "s1", active: true }]);
    await act(async () => { await vi.advanceTimersToNextTimerAsync(); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await act(async () => { third.resolve(response([{ ...base, active: false }])); await third.promise; });
    expect(infos).toMatchObject([{ id: "s1", active: false }]);
  });

  it("lets a newer pushed activity frame replace the retained main activity", async () => {
    vi.useFakeTimers();
    const next = deferred<Response>();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response([{ ...base, id: "durable", active: true }]))
      .mockReturnValueOnce(next.promise);
    vi.stubGlobal("fetch", fetchMock);
    await mount();
    push({ sessionId: "s1", durableSessionId: "durable" });
    expect(infos).toMatchObject([{ id: "s1", active: true }]);
    push({ active: false });
    expect(infos).toMatchObject([{ id: "s1", active: false }]);
    await act(async () => { await vi.advanceTimersToNextTimerAsync(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // PR #197 server contract: the later REST response retains the stored
    // chat ID; this checks pushed activity wins on a tied receipt.
    await act(async () => { next.resolve(response([{ ...base }])); await next.promise; });
    expect(infos).toMatchObject([{ id: "s1", active: false }]);
  });

  it("keeps a newer pushed activity value over an older in-flight poll result", async () => {
    const poll = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(() => poll.promise));
    await mount();
    push({ sessionId: "s1", durableSessionId: "durable", active: true });
    expect(infos).toMatchObject([{ id: "s1", active: true }]);
    // PR #197 server contract: a stored chat's REST row is always chat-keyed.
    await act(async () => { poll.resolve(response([{ ...base, active: false }])); await poll.promise; });
    expect(infos).toMatchObject([{ id: "s1", active: true }]);
    expect(summaries[0]).toMatchObject({ id: "s1", active: true });
  });

  it.each([false, true])("keeps the hook on X after a pending Y-era REST response (overflow=%s)", async (overflow) => {
    vi.useFakeTimers();
    const pending = deferred<Response>();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response([]))
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(response([{ ...base, durableSessionId: "X", last_activity_ms: 301, running: { agents: 1, tasks: 1, dag: 0 } }]));
    vi.stubGlobal("fetch", fetchMock);
    await mount();
    push({ durableSessionId: "X", last_activity_ms: 100, running: { agents: 1, tasks: 1, dag: 0 } });
    push({ durableSessionId: "Y", last_activity_ms: 200, running: { agents: 2, tasks: 2, dag: 0 } });
    await act(async () => { await vi.advanceTimersToNextTimerAsync(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    push({ durableSessionId: "X", last_activity_ms: 300, running: { agents: 1, tasks: 1, dag: 0 }, overflow });
    await act(async () => {
      pending.resolve(response([{ ...base, last_activity_ms: 200, running: { agents: 2, tasks: 2, dag: 0 } }]));
      await pending.promise;
    });
    expect(infos[0]?.lean?.running?.tasks).toBe(1);

    await act(async () => { await vi.advanceTimersToNextTimerAsync(); });
    expect(infos[0]?.lean?.running?.tasks).toBe(1);
  });
});
