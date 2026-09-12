import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectChat, parseChatServerFrame, type ChatHandlers, type ChatServerFrame } from "../../lib/chatWs";
import { Sidebar } from "../../components/Sidebar";
import { useLiveSessionInfos } from "./useLiveSessions";
import { useLiveSessionSummaries, type LiveSessionSummary } from "./useLiveSessionSummaries";
import { __resetLiveBadgeStoreForTests, ingestExtensionEvent, useMergedLiveSummaries } from "./liveBadgeStore";
import { listLiveSessions, type LiveSessionInfo } from "./workspace";

vi.mock("../../lib/chatWs", async (original) => ({
  ...await original<typeof import("../../lib/chatWs")>(), connectChat: vi.fn(),
}));
vi.mock("../../lib/useMediaQuery", () => ({ useMediaQuery: () => false }));

function response(sessions: unknown[]): Response {
  return new Response(JSON.stringify({ sessions }), { headers: { "Content-Type": "application/json" } });
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
const wire: ActivityFrame = { type: "sessions.activity", sessionId: "s1", durableSessionId: "s1", snapshots: [], overflow: false };

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
        onOpenSession={async () => undefined} onAddWorkspace={() => undefined} onAddTerminal={() => undefined}
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
    push({ snapshots: [{ name: "omo.task.updated", data: { tasks: [], agent_running_count: 3 }, oversized: false }] });
    expect(active()).toBe(value);
    await act(async () => { poll.resolve(response([{ ...base, active: !value }])); await poll.promise; });
    expect(active()).toBe(value);
    expect(summaries[0]).toMatchObject({ active: value, runningCount: 3 });
  });

  it("pins main-only work, settles it, and never adds the main to exact child counts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response([{ ...base, active: false }])));
    await mount(true);
    expect(container.querySelector(".th-sidebar-live")).toBeNull();
    push({ active: true });
    expect(container.querySelectorAll(".th-overview-card")).toHaveLength(1);
    expect(container.querySelector(".th-tree-children .th-tree-running")).not.toBeNull();
    expect(container.querySelector(".th-tree-running--workspace")).not.toBeNull();
    expect(container.querySelector(".th-overview-card-running")).not.toBeNull();
    expect(container.querySelector(".th-sidebar-live-count")?.textContent).toBe("0");
    expect(summaries[0]).toMatchObject({ active: true, runningCount: 0 });
    expect(container.querySelector(".th-tree-live")).not.toBeNull();
    expect(container.querySelector(".th-tree-placed--on")).not.toBeNull();
    act(() => ingestExtensionEvent("s1", "omo.task.updated", { tasks: [], agent_running_count: 7 }));
    expect(summaries[0]).toMatchObject({ active: true, runningCount: 7 });
    for (const selector of [".th-sidebar-live-count", ".th-overview-card-running", ".th-tree-children .th-tree-running", ".th-tree-running--workspace"]) {
      expect(container.querySelector(selector)?.textContent).toBe("7");
    }
    push({ active: false });
    expect(summaries[0]).toMatchObject({ active: false, runningCount: 7 });
    expect(container.querySelector(".th-overview-card-running")?.textContent).toBe("7");
    push({ snapshots: [{ name: "omo.task.updated", data: { tasks: [], agent_running_count: 0 }, oversized: false }] });
    expect(container.querySelector(".th-sidebar-live")).toBeNull();
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
    push({ sessionId: "s1", durableSessionId: "s1", snapshots: [{ name: "omo.dag.updated", data: { runs: [] }, oversized: false }] });
    push({ replacesSessionId: "durable" });
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
});
