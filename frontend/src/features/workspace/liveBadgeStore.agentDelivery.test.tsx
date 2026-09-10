import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetLiveBadgeStoreForTests,
  ingestExtensionEvent,
  nextLiveActivitySequence,
  settleLiveBadgePoll,
  useMergedLiveSummaries,
} from "./liveBadgeStore";
import { summarizeLiveSession, type LiveSessionSummary } from "./useLiveSessionSummaries";

// Mounted regressions for the accepted-delivery aggregate authority: the
// displayed agent-count aggregate follows the order deliveries were accepted
// by the shared store, never task updated_at / DAG updated_at row clocks,
// and the deferred-REST fence runs through the real sequence-bearing callers.

const T1 = "2026-09-09T10:01:00Z";
const T2 = "2026-09-09T10:02:00Z";
const T3 = "2026-09-09T10:03:00Z";

function taskFrame(
  status: string,
  at: string,
  agentRunning: number,
  agentTotal = agentRunning,
): Record<string, unknown> {
  return {
    truncated_tasks: false,
    tasks: [{ task_id: "t1", name: "Task", status, updated_at: at }],
    running_count: status === "running" ? 1 : 0,
    total_count: 1,
    agent_running_count: agentRunning,
    agent_total_count: agentTotal,
  };
}

function dagFrame(
  at: string,
  agentRunning: number,
  agentTotal = agentRunning,
  nodeState: "running" | "completed" = "running",
): Record<string, unknown> {
  return {
    truncated_runs: false,
    running_count: nodeState === "running" ? 1 : 0,
    agent_running_count: agentRunning,
    agent_total_count: agentTotal,
    runs: [{
      run_id: "r1",
      run_key: "r1",
      name: "Graph",
      status: "running",
      updated_at: at,
      counts: {
        total: 1,
        pending: 0,
        blocked: 0,
        scheduled: 0,
        running: nodeState === "running" ? 1 : 0,
        completed: nodeState === "running" ? 0 : 1,
        failed: 0,
        cancelled: 0,
        skipped: 0,
      },
      nodes: [{ id: "n1", prompt: "DAG only", depends_on: [], state: nodeState }],
      edges: [],
      waves: [],
    }],
  };
}

describe("accepted-delivery agent aggregate authority (review r3 G2/G3)", () => {
  let root: Root;
  let container: HTMLDivElement;
  let result: readonly LiveSessionSummary[];
  let base: readonly LiveSessionSummary[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-09T10:05:00Z"));
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    __resetLiveBadgeStoreForTests();
    base = [summarizeLiveSession({
      id: "s1", title: "s1", task: null, dag: null, taskOversized: false, dagOversized: false,
    })];
    result = [];
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

  function Host(): null {
    result = useMergedLiveSummaries(base);
    return null;
  }

  it("a later accepted DAG delivery wins although its independent row clock is older", () => {
    act(() => ingestExtensionEvent("s1", "omo.task.updated", taskFrame("running", T2, 1)));
    act(() => ingestExtensionEvent("s1", "omo.dag.updated", dagFrame(T1, 2)));
    expect(result[0]?.runningCount).toBe(2);
  });

  it("a later task delivery supersedes an earlier DAG delivery on tied row clocks", () => {
    act(() => ingestExtensionEvent("s1", "omo.dag.updated", dagFrame(T2, 1)));
    act(() => ingestExtensionEvent("s1", "omo.task.updated", taskFrame("running", T2, 2)));
    expect(result[0]?.runningCount).toBe(2);
  });

  it("keeps electing the later delivery when row clocks move with delivery order", () => {
    act(() => ingestExtensionEvent("s1", "omo.task.updated", taskFrame("running", T2, 1)));
    act(() => ingestExtensionEvent("s1", "omo.dag.updated", dagFrame(T3, 2)));
    expect(result[0]?.runningCount).toBe(2);
  });

  it("applies a count-only DAG update whose run clock predates the task rows", () => {
    act(() => ingestExtensionEvent("s1", "omo.task.updated", taskFrame("running", T3, 1)));
    act(() => ingestExtensionEvent("s1", "omo.dag.updated", dagFrame(T1, 2)));
    expect(result[0]?.runningCount).toBe(2);
  });

  it("applies a count-only task update whose rows repeat an already-seen revision", () => {
    act(() => ingestExtensionEvent("s1", "omo.task.updated", taskFrame("running", T1, 1)));
    act(() => ingestExtensionEvent("s1", "omo.dag.updated", dagFrame(T3, 2)));
    expect(result[0]?.runningCount).toBe(2);
    act(() => ingestExtensionEvent("s1", "omo.task.updated", taskFrame("running", T1, 3)));
    expect(result[0]?.runningCount).toBe(3);
  });

  it("counts a DAG-side addition delivered after the task aggregate", () => {
    act(() => ingestExtensionEvent("s1", "omo.task.updated", taskFrame("running", T3, 2)));
    act(() => ingestExtensionEvent("s1", "omo.dag.updated", dagFrame(T1, 3)));
    expect(result[0]?.runningCount).toBe(3);
  });

  it("applies a DAG completion delivered after the task aggregate", () => {
    act(() => ingestExtensionEvent("s1", "omo.task.updated", taskFrame("running", T3, 1)));
    act(() => ingestExtensionEvent("s1", "omo.dag.updated", dagFrame(T1, 0, 1, "completed")));
    expect(result[0]?.runningCount).toBe(0);
  });

  it("a deferred stale REST response cannot resurrect counts over newer live state", async () => {
    act(() => ingestExtensionEvent("s1", "omo.task.updated", taskFrame("running", T2, 1)));
    const requestSequence = nextLiveActivitySequence();
    let resolveResponse!: (value: unknown) => void;
    const pending = new Promise<unknown>((resolve) => {
      resolveResponse = resolve;
    });
    const settled = pending.then(() => {
      settleLiveBadgePoll([{ id: "s1", task: taskFrame("running", T2, 1) }], requestSequence);
    });
    act(() => ingestExtensionEvent("s1", "omo.task.updated", taskFrame("completed", T3, 0)));
    expect(result[0]?.runningCount).toBe(0);
    await act(async () => {
      resolveResponse(undefined);
      await settled;
    });
    expect(result[0]?.task).toMatchObject({
      tasks: [expect.objectContaining({ status: "completed" })],
    });
    expect(result[0]?.runningCount).toBe(0);
  });

  it("a REST response whose request postdates the last live admission still applies", () => {
    act(() => ingestExtensionEvent("s1", "omo.task.updated", taskFrame("running", T2, 1)));
    const requestSequence = nextLiveActivitySequence();
    act(() => settleLiveBadgePoll([{ id: "s1", task: taskFrame("running", T2, 3) }], requestSequence));
    expect(result[0]?.runningCount).toBe(3);
  });
});
