import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectChat, parseChatServerFrame } from "../../lib/chatWs";
import type { ChatHandlers } from "../../lib/chatWs";
import { useLiveSessionSummaries } from "./useLiveSessionSummaries";
import type { LiveSessionSummary } from "./useLiveSessionSummaries";
import { __resetLiveBadgeStoreForTests, useMergedLiveSummaries } from "./liveBadgeStore";

vi.mock("../../lib/chatWs", async original => ({ ...await original<object>(), connectChat: vi.fn() }));

const addition = { last_activity_ms: 100, running: { agents: 2, tasks: 80, dag: 70 },
  done: 0, dag_done: 0, dag_total: 1, truncated: { task: true, dag: true } };
const completion = { ...addition, last_activity_ms: 200, running: { agents: 0, tasks: 0, dag: 0 }, done: 1 };
// Removed keys may be ignored at a JSON boundary but can never enter a live row.
const discarded = { task: { tasks: [], agent_running_count: 99 }, dag: { runs: [], agent_running_count: 88 },
  task_digest: { tasks: [], agent_running_count: 99 }, dag_digest: { runs: [], agent_running_count: 88 },
  snapshots: [{ name: "omo.task.updated", data: { tasks: [], agent_running_count: 99 }, oversized: false }],
  taskDigest: { tasks: [], agent_running_count: 99 }, dagDigest: { runs: [], agent_running_count: 88 } };

describe.each(["REST", "WS"] as const)("lean envelope authority through %s", path => {
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
  async function deliver(fields: object): Promise<void> {
    switch (path) {
      case "REST":
        await act(async () => settle(new Response(JSON.stringify({ sessions: [{ id: "s", title: "Counts", ...fields }] }))));
        return;
      case "WS": {
        const frame = parseChatServerFrame({ type: "sessions.activity", sessionId: "s", durableSessionId: "s",
          title: "Counts", overflow: false, ...fields });
        if (frame === null) throw new TypeError("Invalid lean frame");
        act(() => handlers.onFrame(frame));
        return;
      }
      default: {
        const unreachable: never = path;
        throw new TypeError(`Unexpected transport: ${unreachable}`);
      }
    }
  }
  it.each([addition, completion])("keeps exact scalars when discarded fields conflict at revision $last_activity_ms", async fields => {
    // Given a valid lean envelope beside obsolete, conflicting payload keys.
    // When it traverses the transport's real parse boundary and mounted hooks.
    await deliver({ ...fields, ...discarded });
    // Then both consumers expose only the server's deduplicated aggregate.
    for (const summaries of [overview, merged]) {
      expect(summaries[0]).toMatchObject({ runningCount: fields.running.agents, doneCount: fields.done,
        dagDone: fields.dag_done, dagTotal: fields.dag_total, taskSideOversized: true, dagSideOversized: true });
      expect(summaries[0]).not.toHaveProperty("task");
      expect(summaries[0]).not.toHaveProperty("dagDigest");
    }
  });
  it("does not reconstruct counts when only removed payload fields are supplied", async () => {
    // Given membership with unknown counts and obsolete topology.
    // When the boundary ignores those unknown JSON keys.
    await deliver(discarded);
    // Then missing server counts do not become fabricated work.
    expect(overview[0]).toMatchObject({ runningCount: 0, doneCount: 0 });
    expect(merged[0]).toMatchObject({ runningCount: 0, doneCount: 0 });
  });
});
