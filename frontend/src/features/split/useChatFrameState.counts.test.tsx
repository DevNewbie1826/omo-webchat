import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseChatServerFrame, type ChatServerFrame } from "../../lib/chatWs";
import { ACTIVITY_HYDRATION_SIDE_LIMIT } from "./activityState";
import { useChatFrameState } from "./useChatFrameState";

interface ProbeState {
  readonly activities: ReturnType<typeof useChatFrameState>["activities"] & {
    readonly taskRunningCount?: number;
    readonly taskTotalCount?: number;
    readonly taskAgentRunningCount?: number;
    readonly taskAgentTotalCount?: number;
  };
  readonly handleFrame: (frame: ChatServerFrame) => void;
  readonly beginActivityHydration: () => number;
  readonly cancelActivityHydration: (token: number) => void;
  readonly hydrateActivities: (
    token: number, task: unknown, dag: unknown, taskDigest?: unknown, taskOversized?: boolean, dagDigest?: unknown,
  ) => void;
}

let captured: ProbeState | null = null;

function Probe(): null {
  const state = useChatFrameState();
  captured = {
    activities: state.activities,
    handleFrame: state.handleFrame,
    beginActivityHydration: state.beginActivityHydration,
    cancelActivityHydration: state.cancelActivityHydration,
    hydrateActivities: state.hydrateActivities,
  };
  return null;
}

function deliver(frame: unknown): void {
  const parsed = parseChatServerFrame(frame);
  if (parsed) captured?.handleFrame(parsed);
}

function taskSnapshot(scalars: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "extensionEvent",
    sessionId: "chat-1",
    name: "omo.task.updated",
    data: {
      parent_session_id: "chat-1",
      truncated_tasks: true,
      tasks: [{ task_id: "t1", status: "running", updated_at: "2026-09-09T10:00:00Z" }],
      ...scalars,
    },
  };
}

function dagSnapshot(scalars: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "extensionEvent",
    sessionId: "chat-1",
    name: "omo.dag.updated",
    data: { parent_session_id: "chat-1", truncated_runs: false, runs: [], ...scalars },
  };
}

/** Count-only authority must reach the pane state through live and replayed
 * snapshot frames and through hydration, while tabs stay closed and without
 * pinning initial zeros. */
describe("useChatFrameState count authority", () => {
  let container: HTMLDivElement;
  let root: Root;

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

  it("starts without pinned scalars, then takes the live task frame authority", () => {
    expect(captured?.activities.taskAgentRunningCount).toBeUndefined();
    expect(captured?.activities.taskAgentTotalCount).toBeUndefined();
    act(() => {
      deliver(taskSnapshot({
        running_count: 50, total_count: 600, agent_running_count: 50, agent_total_count: 600,
      }));
    });
    expect(captured?.activities).toMatchObject({
      taskRunningCount: 50,
      taskTotalCount: 600,
      taskAgentRunningCount: 50,
      taskAgentTotalCount: 600,
    });
  });

  it("updates the aggregate from a live DAG frame without touching task scalars", () => {
    act(() => {
      deliver(taskSnapshot({ running_count: 1, total_count: 2, agent_running_count: 1, agent_total_count: 2 }));
      deliver(dagSnapshot({ running_count: 9, agent_running_count: 4, agent_total_count: 8 }));
    });
    expect(captured?.activities).toMatchObject({
      taskRunningCount: 1,
      taskTotalCount: 2,
      taskAgentRunningCount: 4,
      taskAgentTotalCount: 8,
    });
  });

  it("keeps scalars of rows-only frames instead of resetting them", () => {
    act(() => {
      deliver(taskSnapshot({ running_count: 1, total_count: 2, agent_running_count: 1, agent_total_count: 2 }));
      deliver(taskSnapshot({}));
    });
    expect(captured?.activities).toMatchObject({
      taskRunningCount: 1,
      taskAgentRunningCount: 1,
      taskAgentTotalCount: 2,
    });
  });

  it("plants the digest authority through hydration from either digest side", () => {
    act(() => {
      deliver(taskSnapshot({ running_count: 1, total_count: 2, agent_running_count: 1, agent_total_count: 2 }));
    });
    const token = captured!.beginActivityHydration();
    act(() => {
      captured!.hydrateActivities(
        token,
        null,
        null,
        {
          tasks: [{ task_id: "t9", status: "running", updated_at: "2026-09-09T10:01:00Z" }],
          truncated: true,
          running_count: 50,
          total_count: 600,
          agent_running_count: 50,
          agent_total_count: 600,
        },
        true,
        {
          runs: [],
          truncated: true,
          running_count: 50,
          agent_running_count: 50,
          agent_total_count: 600,
        },
      );
    });
    expect(captured?.activities).toMatchObject({
      taskRunningCount: 50,
      taskTotalCount: 600,
      taskAgentRunningCount: 50,
      taskAgentTotalCount: 600,
    });
  });

  it("backfills the agent aggregate from the DAG digest when hydration lacks a task digest", () => {
    const token = captured!.beginActivityHydration();
    act(() => {
      captured!.hydrateActivities(
        token,
        null,
        null,
        undefined,
        false,
        { runs: [], truncated: true, running_count: 9, agent_running_count: 4, agent_total_count: 8 },
      );
    });
    expect(captured?.activities).toMatchObject({ taskAgentRunningCount: 4, taskAgentTotalCount: 8 });
    expect(captured?.activities.taskRunningCount).toBeUndefined();
  });

  it("does not let a stale hydration digest pin zeros over buffered live authority", () => {
    const token = captured!.beginActivityHydration();
    act(() => {
      // The live frame lands while hydration is in flight and is buffered as
      // a superseded snapshot; the slower digest must not overwrite it.
      deliver(taskSnapshot({ running_count: 50, total_count: 600, agent_running_count: 50, agent_total_count: 600 }));
      captured!.hydrateActivities(
        token,
        null,
        null,
        { tasks: [], truncated: false, running_count: 0, total_count: 0, agent_running_count: 0, agent_total_count: 0 },
      );
    });
    expect(captured?.activities).toMatchObject({
      taskRunningCount: 50,
      taskTotalCount: 600,
      taskAgentRunningCount: 50,
      taskAgentTotalCount: 600,
    });
  });

  it("ignores a stale hydration token instead of applying its scalars", () => {
    const token = captured!.beginActivityHydration();
    act(() => {
      captured!.cancelActivityHydration(token);
      captured!.hydrateActivities(
        token,
        null,
        null,
        { tasks: [], truncated: true, agent_running_count: 4, agent_total_count: 8 },
      );
    });
    expect(captured?.activities.taskAgentRunningCount).toBeUndefined();
  });

  it("a deferred hydration response cannot resurrect counts after the live snapshot leaves the bounded buffer", () => {
    const dagUpdated = (status: string, running: number, updatedAt: string): Record<string, unknown> => ({
      type: "extensionEvent",
      sessionId: "chat-1",
      name: "omo.dag.updated",
      data: {
        parent_session_id: "chat-1",
        truncated_runs: false,
        running_count: running,
        agent_running_count: running,
        agent_total_count: 1,
        runs: [{
          run_id: "r",
          run_key: "r",
          name: "Graph",
          status,
          updated_at: updatedAt,
          counts: {
            total: 1, pending: 0, blocked: 0, scheduled: 0, running,
            completed: 1 - running, failed: 0, cancelled: 0, skipped: 0,
          },
          nodes: [{ id: "n", prompt: "Work", depends_on: [], state: status }],
          edges: [],
          waves: [],
        }],
      },
    });
    act(() => {
      deliver(dagUpdated("running", 1, "2026-09-10T10:01:00Z"));
    });
    // The hydration request registers the older aggregate before the live
    // completion is accepted, so its slower response is the deferred one.
    const token = captured!.beginActivityHydration();
    act(() => {
      deliver(dagUpdated("completed", 0, "2026-09-10T10:02:00Z"));
    });
    expect(captured?.activities.taskAgentRunningCount).toBe(0);
    act(() => {
      // Exactly the side limit of distinct valid activity frames evicts the
      // buffered completion snapshot from the bounded hydration buffer.
      for (let i = 0; i < ACTIVITY_HYDRATION_SIDE_LIMIT; i += 1) {
        deliver({
          type: "extensionEvent",
          sessionId: "chat-1",
          name: "omo.dag.activity",
          data: { runId: "r", nodeId: `unretained-${i}`, at: "2026-09-10T10:03:00Z" },
        });
      }
    });
    act(() => {
      captured!.hydrateActivities(token, null, null, undefined, false, {
        runs: [{ run_id: "r", status: "running", running_task_ids: [] }],
        truncated: true,
        running_count: 1,
        agent_running_count: 1,
        agent_total_count: 1,
      });
    });
    expect(captured?.activities.dags.get("r")?.status).toBe("completed");
    expect(captured?.activities.taskAgentRunningCount).toBe(0);
  });

  it("a deferred hydration response cannot resurrect counts a live frame changed without a retained-row mutation", () => {
    const scalarsOnly = (running: number): Record<string, unknown> => ({
      type: "extensionEvent",
      sessionId: "chat-1",
      name: "omo.dag.updated",
      data: {
        parent_session_id: "chat-1",
        truncated_runs: false,
        running_count: running,
        agent_running_count: running,
        agent_total_count: 1,
        runs: [{
          run_id: "r",
          run_key: "r",
          name: "Graph",
          status: "running",
          updated_at: "2026-09-10T10:01:00Z",
          counts: {
            total: 1, pending: 0, blocked: 0, scheduled: 0, running: 1,
            completed: 0, failed: 0, cancelled: 0, skipped: 0,
          },
          nodes: [{ id: "n", prompt: "Work", depends_on: [], state: "running" }],
          edges: [],
          waves: [],
        }],
      },
    });
    act(() => {
      deliver(scalarsOnly(1));
    });
    const token = captured!.beginActivityHydration();
    act(() => {
      // Same run revision: the retained row never mutates, only the scalars move.
      deliver(scalarsOnly(0));
    });
    expect(captured?.activities.taskAgentRunningCount).toBe(0);
    act(() => {
      for (let i = 0; i < ACTIVITY_HYDRATION_SIDE_LIMIT; i += 1) {
        deliver({
          type: "extensionEvent",
          sessionId: "chat-1",
          name: "omo.dag.activity",
          data: { runId: "r", nodeId: `unretained-${i}`, at: "2026-09-10T10:03:00Z" },
        });
      }
    });
    act(() => {
      captured!.hydrateActivities(token, null, null, undefined, false, {
        runs: [{ run_id: "r", status: "running", running_task_ids: [] }],
        truncated: true,
        running_count: 1,
        agent_running_count: 1,
        agent_total_count: 1,
      });
    });
    expect(captured?.activities.taskAgentRunningCount).toBe(0);
  });
});
