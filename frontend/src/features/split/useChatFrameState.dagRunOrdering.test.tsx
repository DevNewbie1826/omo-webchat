import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n";
import { parseChatServerFrame, type ChatServerFrame } from "../../lib/chatWs";
import { ACTIVITY_HYDRATION_SIDE_LIMIT } from "./activityState";
import { ActivityShelf } from "./ActivityShelf";
import { i18n, requireElement } from "./chatPaneTestHarness";
import { useChatFrameState } from "./useChatFrameState";

interface ProbeState {
  readonly activities: ReturnType<typeof useChatFrameState>["activities"] & {
    readonly dagRunRunningCount?: number;
    readonly dagRunTotalCount?: number;
  };
  readonly handleFrame: (frame: ChatServerFrame) => void;
  readonly beginActivityHydration: () => number;
  readonly hydrateActivities: (
    token: number, task: unknown, dag: unknown, taskDigest?: unknown, taskOversized?: boolean, dagDigest?: unknown,
  ) => void;
}

let captured: ProbeState | null = null;

/** The real product boundary: the frame-state hook rendering the actual
 * shelf through the same dagSource binding ChatPane always supplies. */
function Probe() {
  const state = useChatFrameState();
  captured = {
    activities: state.activities,
    handleFrame: state.handleFrame,
    beginActivityHydration: state.beginActivityHydration,
    hydrateActivities: state.hydrateActivities,
  };
  return (
    <I18nContext.Provider value={i18n}>
      <ActivityShelf activities={state.activities} dagSource={{ wsId: "workspace-1", chatId: "chat-1", connected: true }} />
    </I18nContext.Provider>
  );
}

let container: HTMLDivElement;
let root: Root;

function deliver(frame: unknown): void {
  const parsed = parseChatServerFrame(frame);
  expect(parsed).not.toBeNull();
  act(() => {
    captured?.handleFrame(parsed!);
  });
}

function dagSnapshotFrame(scalars: Record<string, unknown>) {
  return {
    type: "extensionEvent",
    sessionId: "chat-1",
    name: "omo.dag.updated",
    data: { parent_session_id: "chat-1", truncated_runs: false, runs: [], ...scalars },
  };
}

function taskCountFrame(): Record<string, unknown> {
  return {
    type: "extensionEvent",
    sessionId: "chat-1",
    name: "omo.task.updated",
    data: {
      parent_session_id: "chat-1",
      truncated_tasks: true,
      tasks: [{ task_id: "t1", status: "running", updated_at: "2026-09-09T10:00:00Z" }],
      running_count: 50,
      total_count: 600,
      agent_running_count: 50,
      agent_total_count: 600,
    },
  };
}

function dagActivityFrame(index: number): Record<string, unknown> {
  return {
    type: "extensionEvent",
    sessionId: "chat-1",
    name: "omo.dag.activity",
    data: { runId: "r1", nodeId: `n${index}`, at: "2026-09-10T10:03:00Z" },
  };
}

/** Exactly the side limit of distinct valid activity events evicts the
 * buffered DAG snapshot from the bounded hydration buffer. */
function evictBufferedDagSnapshot(): void {
  for (let i = 0; i < ACTIVITY_HYDRATION_SIDE_LIMIT; i += 1) deliver(dagActivityFrame(i));
}

function dagTab(): HTMLButtonElement {
  return requireElement(
    container.querySelector<HTMLButtonElement>('[data-activity-tab="dag"]'),
    "DAG tab",
  );
}

/** The collapsed DAG tab renders exactly its label plus the exact pair —
 * no approximate marker, "?" or "+" may appear instead. */
function expectDagTabPair(expected: string): void {
  expect([...dagTab().querySelectorAll("span")].map(span => span.textContent))
    .toEqual(["activity.dag", expected]);
}

/** An older hydration response resolving after these deliveries must never
 * move the tab off the accepted live pair. */
const STALE_DAG_DIGEST = {
  runs: [],
  truncated: true,
  run_running_count: 1,
  run_total_count: 2,
};

/** The DAG-run scalar pair must keep its own accepted ordering across
 * unrelated deliveries and bounded-buffer eviction: a later-arriving older
 * hydration response can never lower the collapsed DAG tab. Both failing
 * sequences run through the real hook, the wire frame parser, and the
 * mounted shelf with the product dagSource binding. */
describe("useChatFrameState DAG run scalar ordering", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    captured = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(<Probe />);
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  function run(id: string, minute: string, status = "running") {
    return { run_id: id, run_key: id, name: id, status,
      updated_at: `2026-09-09T10:${minute}:00Z`, nodes: [], edges: [], waves: [], truncated_nodes: true };
  }

  function expectNoPair() {
    expect([...dagTab().querySelectorAll("span")].map(span => span.textContent)).toEqual(["activity.dag"]);
  }

  const exact = () => dagSnapshotFrame({
    runs: [run("done", "01", "completed"), run("live", "02")],
    run_running_count: 1, run_total_count: 2,
  });
  // Observed engine behavior/contract: the unknown-clock inventory retains
  // the last accepted rich row, while withdrawing its exact count authority.
  const withdrawal = () => dagSnapshotFrame({
    runs: [run("done", "01", "completed")], run_counts_unavailable: true,
  });
  const withdrawalDigest = {
    runs: [{ run_id: "done", status: "completed", running_task_ids: [] }],
    truncated: false, run_counts_unavailable: true,
  };

  it.each(["live", "history"])("%s omission cannot certify a stale complete inventory", source => {
    deliver(dagSnapshotFrame({ truncated_runs: true, runs: [run("r", "02"), run("other", "02")] }));
    const frame = dagSnapshotFrame({ runs: [run("r", "01", "completed")] });
    if (source === "live") deliver(frame);
    else {
      const token = captured!.beginActivityHydration();
      act(() => captured!.hydrateActivities(token, null, frame.data));
    }
    expectNoPair();
  });

  it.each(["live", "history"])("%s mixed row acceptance cannot certify complete membership", source => {
    deliver(dagSnapshotFrame({ truncated_runs: true, runs: [run("r", "02"), run("other", "02")] }));
    const frame = dagSnapshotFrame({ runs: [run("r", "01", "completed"), run("other", "03", "completed")] });
    if (source === "live") deliver(frame);
    else {
      const token = captured!.beginActivityHydration();
      act(() => captured!.hydrateActivities(token, null, frame.data));
    }
    expectNoPair();
  });

  it.each(["live", "history"])("%s equal-row subset withdraws scalar-less membership authority", source => {
    deliver(dagSnapshotFrame({ runs: [run("r", "02"), run("other", "02")] }));
    expectDagTabPair("2/2");
    const frame = dagSnapshotFrame({ runs: [run("r", "02")] });
    if (source === "live") deliver(frame);
    else {
      const token = captured!.beginActivityHydration();
      act(() => captured!.hydrateActivities(token, null, frame.data));
    }
    expectNoPair();
  });

  it.each(["live", "history"])("%s partially accepted truncated inventory withdraws completeness", source => {
    deliver(dagSnapshotFrame({ runs: [run("r", "02"), run("other", "02")] }));
    expectDagTabPair("2/2");
    const frame = dagSnapshotFrame({ truncated_runs: true,
      runs: [run("r", "01", "completed"), run("other", "03", "completed")] });
    if (source === "live") deliver(frame);
    else {
      const token = captured!.beginActivityHydration();
      act(() => captured!.hydrateActivities(token, null, frame.data));
    }
    expectNoPair();
  });

  describe.each(["live", "history"] as const)("%s unresolved membership", source => {
    function snapshot(runs: ReturnType<typeof run>[]) {
      const frame = dagSnapshotFrame({ runs });
      if (source === "live") deliver(frame);
      else {
        const token = captured!.beginActivityHydration();
        act(() => captured!.hydrateActivities(token, null, frame.data));
      }
    }

    it("does not restore counting after rich-row deletion and a below-fence advance", () => {
      snapshot([run("r", "02"), run("other", "05")]);
      expectDagTabPair("2/2");
      snapshot([run("r", "03")]);
      expectNoPair();
      expect(captured!.activities.dags.has("other")).toBe(false);
      snapshot([run("r", "04")]);
      expectNoPair();
      snapshot([run("r", "06"), run("other", "05")]);
      expectDagTabPair("2/2");
    });

    it("does not resolve an equal-subset omission by matching retained rows", () => {
      snapshot([run("r", "02"), run("other", "05")]);
      expectDagTabPair("2/2");
      snapshot([run("r", "02")]);
      expectNoPair();
      expect(captured!.activities.dags.has("other")).toBe(true);
      snapshot([run("r", "03"), run("other", "05")]);
      expectNoPair();
      snapshot([run("r", "06"), run("other", "05")]);
      expectDagTabPair("2/2");
      snapshot([run("r", "01")]);
      expectDagTabPair("2/2");
    });
  });

  it.each([false, true])("raw-only history withdraws authority in an established=%s pane", established => {
    if (established) { deliver(exact()); expectDagTabPair("1/2"); }
    const token = captured!.beginActivityHydration();
    act(() => captured!.hydrateActivities(token, null, withdrawal().data));
    expectNoPair();
  });

  it("raw-only history admits exact scalars before a later older withdrawal loses to live authority", () => {
    const initial = captured!.beginActivityHydration();
    act(() => captured!.hydrateActivities(initial, null, dagSnapshotFrame({
      runs: [run("done", "01", "completed")], run_running_count: 1, run_total_count: 2,
    }).data));
    expectDagTabPair("1/2");
    const token = captured!.beginActivityHydration();
    deliver(dagSnapshotFrame({ run_running_count: 4, run_total_count: 9 }));
    evictBufferedDagSnapshot();
    act(() => captured!.hydrateActivities(token, null, withdrawal().data));
    expectDagTabPair("4/9");
  });

  it("a supplied exact digest supersedes a rich withdrawal", () => {
    const token = captured!.beginActivityHydration();
    act(() => captured!.hydrateActivities(token, null, withdrawal().data, undefined, false, {
      runs: [], truncated: true, run_running_count: 4, run_total_count: 9,
    }));
    expectDagTabPair("4/9");
  });

  it.each([false, true])("withdraws exact authority in an established=%s pane", established => {
    if (established) { deliver(exact()); expectDagTabPair("1/2"); }
    deliver(withdrawal());
    expectNoPair();
    deliver(taskCountFrame());
    deliver(dagSnapshotFrame({ runs: [run("done", "03", "completed")] }));
    expectNoPair();
  });

  it.each([false, true])("live withdrawal defeats an older hydration with buffer eviction=%s", evict => {
    deliver(exact());
    const token = captured!.beginActivityHydration();
    deliver(withdrawal());
    if (evict) evictBufferedDagSnapshot();
    deliver(taskCountFrame());
    act(() => captured!.hydrateActivities(token, null, null, undefined, false, STALE_DAG_DIGEST));
    expectNoPair();
  });

  it("a current hydrated withdrawal clears the pair and a later exact delivery restores it", () => {
    deliver(exact());
    const token = captured!.beginActivityHydration();
    act(() => captured!.hydrateActivities(token, null, withdrawal().data, undefined, false, withdrawalDigest));
    expectNoPair();
    deliver(exact());
    expectDagTabPair("1/2");
  });

  it("an older hydrated withdrawal loses to newer exact authority after buffer eviction", () => {
    deliver(withdrawal());
    expectNoPair();
    const token = captured!.beginActivityHydration();
    deliver(exact());
    evictBufferedDagSnapshot();
    act(() => captured!.hydrateActivities(token, null, withdrawal().data, undefined, false, withdrawalDigest));
    expectDagTabPair("1/2");
  });

  it("keeps the live DAG pair when an ordinary task frame and buffer eviction precede the older hydration response", () => {
    const token = captured!.beginActivityHydration();
    deliver(dagSnapshotFrame({
      run_running_count: 4, run_total_count: 9, agent_running_count: 3, agent_total_count: 7,
    }));
    expectDagTabPair("4/9");
    deliver(taskCountFrame());
    expectDagTabPair("4/9");
    evictBufferedDagSnapshot();
    expectDagTabPair("4/9");
    act(() => {
      captured!.hydrateActivities(token, null, null, undefined, false, STALE_DAG_DIGEST);
    });
    expectDagTabPair("4/9");
    expect(captured?.activities.dagRunRunningCount).toBe(4);
    expect(captured?.activities.dagRunTotalCount).toBe(9);
  });

  it("keeps a run-only scalar pair across buffer eviction and the older hydration response", () => {
    const token = captured!.beginActivityHydration();
    deliver(dagSnapshotFrame({ run_running_count: 4, run_total_count: 9 }));
    expectDagTabPair("4/9");
    evictBufferedDagSnapshot();
    expectDagTabPair("4/9");
    act(() => {
      captured!.hydrateActivities(token, null, null, undefined, false, STALE_DAG_DIGEST);
    });
    expectDagTabPair("4/9");
    expect(captured?.activities.dagRunRunningCount).toBe(4);
    expect(captured?.activities.dagRunTotalCount).toBe(9);
  });

  it("a hydration response registered after the live delivery still advances the DAG pair", () => {
    deliver(dagSnapshotFrame({ run_running_count: 4, run_total_count: 9 }));
    expectDagTabPair("4/9");
    const token = captured!.beginActivityHydration();
    act(() => {
      captured!.hydrateActivities(token, null, null, undefined, false, {
        runs: [],
        truncated: true,
        run_running_count: 5,
        run_total_count: 9,
      });
    });
    expectDagTabPair("5/9");
    expect(captured?.activities.dagRunRunningCount).toBe(5);
    expect(captured?.activities.dagRunTotalCount).toBe(9);
  });
});
