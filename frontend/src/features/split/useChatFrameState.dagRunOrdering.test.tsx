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

function dagSnapshotFrame(scalars: Record<string, unknown>): Record<string, unknown> {
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
