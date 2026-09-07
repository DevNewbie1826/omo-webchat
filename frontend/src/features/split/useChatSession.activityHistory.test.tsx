import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatConnector, ChatServerFrame, JsonObject } from "../../lib/chatWs";
import { ActivityShelf } from "./ActivityShelf";
import { orderingDagRun, UNKNOWN_DAG_TIMESTAMPS } from "./activityState.support";
import { useChatSession } from "./useChatSession";

const session = {
  id: "chat-history",
  name: "History",
  wsId: "workspace-history",
  cwd: "/work",
  provider: "omo",
} as const;

function activityBody(taskName: string, dagName: string): unknown {
  return {
    history: {
      task: {
        parent_session_id: "durable-history",
        truncated_tasks: false,
        tasks: [{ task_id: `task-${taskName}`, name: taskName, status: "completed" }],
      },
      dag: {
        parent_session_id: "durable-history",
        truncated_runs: false,
        runs: [{
          run_id: `dag-${dagName}`,
          run_key: "history",
          name: dagName,
          status: "completed",
          counts: { total: 0, completed: 0 },
          nodes: [], edges: [], waves: [],
        }],
      },
    },
    task_digest: { tasks: [], truncated: false },
    dag_digest: { runs: [], truncated: false },
  };
}

function snapshotFrame(side: "task" | "dag", name: string): ChatServerFrame {
  return side === "task"
    ? {
      type: "extensionEvent", sessionId: session.id, name: "omo.task.updated",
      data: { tasks: [{ task_id: `task-${name}`, name, status: "completed" }] },
    }
    : {
      type: "extensionEvent", sessionId: session.id, name: "omo.dag.updated",
      data: { runs: [{ run_id: `dag-${name}`, run_key: "live", name, status: "completed", nodes: [] }] },
    };
}

describe("useChatSession historical activity hydration", () => {
  let root: Root;
  let container: HTMLDivElement;
  let current: ReturnType<typeof useChatSession> | undefined;
  let deliver: (frame: ChatServerFrame) => void;
  let reopen: () => void;
  let activityResolvers: ((response: Response) => void)[];

  const readyFrame = (): ChatServerFrame => ({
    type: "ready",
    sessionId: session.id,
    piSessionId: "pi-history",
    resumed: true,
  });

  const resolveActivity = async (index: number, body: unknown): Promise<void> => {
    await act(async () => {
      activityResolvers[index]!(new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
      await Promise.resolve();
    });
  };

  const render = (initialFrames: readonly ChatServerFrame[] = []): void => {
    const connect: ChatConnector = (handlers) => {
      deliver = handlers.onFrame;
      reopen = () => handlers.onOpen?.();
      handlers.onOpen?.();
      handlers.onFrame(readyFrame());
      for (const frame of initialFrames) handlers.onFrame(frame);
      return { send: () => true, close: () => undefined };
    };
    function Probe() {
      const chat = useChatSession(session, connect);
      current = chat;
      return <ActivityShelf activities={chat.activities} />;
    }
    act(() => root.render(<Probe />));
  };

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    activityResolvers = [];
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
      if (String(input).endsWith("/activity")) {
        return new Promise<Response>((resolve) => activityResolvers.push(resolve));
      }
      return new Promise<Response>(() => undefined);
    }));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("hydrates the attached shelf and lets REST supersede older pushes per side", async () => {
    render([snapshotFrame("task", "old-task"), snapshotFrame("dag", "old-dag")]);

    await resolveActivity(0, activityBody("history-task", "history-dag"));

    expect(fetch).toHaveBeenCalledWith(
      "/api/workspaces/workspace-history/chats/chat-history/activity",
      expect.objectContaining({ credentials: "same-origin" }),
    );
    expect(current?.activities.tasks.has("task-history-task")).toBe(true);
    expect(current?.activities.dags.has("dag-history-dag")).toBe(true);
    const shelf = container.querySelector(".th-activity-shelf");
    expect(shelf).not.toBeNull();
    act(() => container.querySelector<HTMLButtonElement>(".th-activity-bar")?.click());
    expect(container.querySelector(".th-activity-agent-name")?.textContent).toContain("history-task");
    expect(container.querySelector(".th-activity-dag-name")?.textContent).toContain("history-dag");
  });

  it("consumes non-null oversized prefixes and retains their partial markers", async () => {
    render();
    await resolveActivity(0, {
      history: {
        task_oversized: true,
        dag_oversized: true,
        task: {
          truncated_tasks: true,
          tasks: [{ task_id: "task-prefix", name: "Prefix task", status: "completed" }],
        },
        dag: {
          truncated_runs: true,
          runs: [{
            run_id: "dag-prefix",
            run_key: "prefix",
            name: "Prefix DAG",
            status: "completed",
            nodes: [],
          }],
        },
      },
    });

    expect(current?.activities.tasks.has("task-prefix")).toBe(true);
    expect(current?.activities.dags.has("dag-prefix")).toBe(true);
    expect(current?.activities.truncatedTasks).toBe(true);
    expect(current?.activities.truncatedDags).toBe(true);
  });

  it("preserves a push newer than the REST request while hydrating the other side", async () => {
    render();
    act(() => deliver(snapshotFrame("task", "new-live-task")));

    await resolveActivity(0, activityBody("old-history-task", "history-dag"));

    expect(current?.activities.tasks.has("task-new-live-task")).toBe(true);
    expect(current?.activities.tasks.has("task-old-history-task")).toBe(false);
    expect(current?.activities.dags.has("dag-history-dag")).toBe(true);
  });

  it("replays dag activity that arrives while REST hydration is pending", async () => {
    render([
      {
        type: "extensionEvent",
        sessionId: session.id,
        name: "omo.task.updated",
        data: { tasks: [{ task_id: "task-live", name: "Live task", status: "running" }] },
      },
      {
        type: "extensionEvent",
        sessionId: session.id,
        name: "omo.dag.updated",
        data: {
          runs: [{
            run_id: "dag-live",
            run_key: "live",
            name: "Live DAG",
            status: "running",
            nodes: [{ id: "node-live", prompt: "work", depends_on: [], state: "running", task_id: "task-live" }],
          }],
        },
      },
    ]);

    act(() => deliver({
      type: "extensionEvent",
      sessionId: session.id,
      name: "omo.dag.activity",
      data: {
        runId: "dag-live",
        nodeId: "node-live",
        taskId: "task-live",
        at: "2026-09-03T12:00:00.000Z",
        activity: "tool",
        currentTool: "bash",
        lastAssistantLine: "still running",
      },
    }));

    await resolveActivity(0, {
      history: {
        task: { tasks: [{ task_id: "task-live", name: "Live task", status: "running" }] },
        dag: {
          runs: [{
            run_id: "dag-live",
            run_key: "history",
            name: "Live DAG",
            status: "running",
            nodes: [{ id: "node-live", prompt: "work", depends_on: [], state: "running", task_id: "task-live" }],
          }],
        },
      },
    });

    expect(current?.activities.tasks.get("task-live")?.liveProgress).toMatchObject({
      activity: "tool",
      currentTool: "bash",
      lastAssistantLine: "still running",
    });
    expect(current?.activities.dags.has("dag-live")).toBe(true);
    expect(current?.activities.dags.get("dag-live")?.nodes[0]).toMatchObject({
      activity: "tool",
      currentTool: "bash",
      lastAssistantLine: "still running",
      lastActivityAt: "2026-09-03T12:00:00.000Z",
    });
  });

  it("keeps every live task and DAG-node update when hydration replay overflows", async () => {
    const tasks = Array.from({ length: 125 }, (_, index) => ({
      task_id: `task-${index}`,
      name: `Task ${index}`,
      status: "running",
    }));
    const nodes = Array.from({ length: 125 }, (_, index) => ({
      id: `node-${index}`,
      prompt: `Work ${index}`,
      depends_on: [],
      state: "running",
      task_id: `task-${index}`,
    }));
    const run = {
      run_id: "dag-overflow",
      run_key: "overflow",
      name: "Overflow DAG",
      status: "running",
      nodes,
    };
    render([
      {
        type: "extensionEvent",
        sessionId: session.id,
        name: "omo.task.updated",
        data: { tasks },
      },
      {
        type: "extensionEvent",
        sessionId: session.id,
        name: "omo.dag.updated",
        data: { runs: [run] },
      },
    ]);

    act(() => {
      for (let index = 0; index < 125; index += 1) {
        deliver({
          type: "extensionEvent",
          sessionId: session.id,
          name: "omo.dag.activity",
          data: {
            runId: "dag-overflow",
            nodeId: `node-${index}`,
            taskId: `task-${index}`,
            at: "2026-09-03T12:00:00.000Z",
            activity: `work-${index}`,
          },
        });
      }
    });

    await resolveActivity(0, {
      history: {
        task: { tasks },
        dag: { runs: [run] },
      },
    });

    expect(Array.from(current?.activities.tasks.values() ?? []).every(
      (task, index) => task.liveProgress?.activity === `work-${index}`,
    )).toBe(true);
    expect(current?.activities.dags.get("dag-overflow")?.nodes.every(
      (node, index) => node.activity === `work-${index}`,
    )).toBe(true);
  });

  it("keeps REST history when overflowed DAG activity had no live snapshots to mutate", async () => {
    render();

    act(() => {
      for (let index = 0; index < 125; index += 1) {
        deliver({
          type: "extensionEvent",
          sessionId: session.id,
          name: "omo.dag.activity",
          data: {
            runId: `missing-run-${index % 2}`,
            nodeId: `missing-node-${index}`,
            taskId: `missing-task-${index}`,
            at: "2026-09-03T12:00:00.000Z",
            activity: `work-${index}`,
          },
        });
      }
    });

    await resolveActivity(0, activityBody("rest-task", "rest-dag"));

    expect(current?.activities.tasks.size).toBeGreaterThan(0);
    expect(current?.activities.dags.size).toBeGreaterThan(0);
    expect(current?.activities.tasks.has("task-rest-task")).toBe(true);
    expect(current?.activities.dags.has("dag-rest-dag")).toBe(true);
  });

  it("does not let a malformed snapshot suppress valid REST history", async () => {
    render();
    act(() => deliver({
      type: "extensionEvent",
      sessionId: session.id,
      name: "omo.task.updated",
      data: { tasks: "malformed" },
    }));

    await resolveActivity(0, activityBody("rest-task", "rest-dag"));

    expect(current?.activities.tasks.has("task-rest-task")).toBe(true);
  });

  it("re-fetches activity after recovery and reconnect binding generations", async () => {
    render();
    await resolveActivity(0, activityBody("initial-task", "initial-dag"));

    act(() => {
      deliver({ type: "error", sessionId: session.id, code: "external-write-detected", message: "changed" });
      current?.reloadExternalWrite();
      deliver(readyFrame());
    });
    expect(activityResolvers).toHaveLength(2);
    await resolveActivity(1, activityBody("recovered-task", "recovered-dag"));
    expect(current?.activities.tasks.has("task-recovered-task")).toBe(true);

    act(() => {
      reopen();
      deliver(readyFrame());
    });
    expect(activityResolvers).toHaveLength(3);
    await resolveActivity(2, activityBody("reconnected-task", "reconnected-dag"));
    expect(current?.activities.tasks.has("task-reconnected-task")).toBe(true);
  });

  it("drops a stale binding token that resolves after a newer generation", async () => {
    render();
    act(() => deliver(readyFrame()));
    expect(activityResolvers).toHaveLength(2);

    await resolveActivity(1, activityBody("fresh-task", "fresh-dag"));
    await resolveActivity(0, activityBody("stale-task", "stale-dag"));

    expect(current?.activities.tasks.has("task-fresh-task")).toBe(true);
    expect(current?.activities.tasks.has("task-stale-task")).toBe(false);
  });
  const dagFrame = (runs: readonly JsonObject[], truncated = false): ChatServerFrame => ({
    type: "extensionEvent", sessionId: session.id, name: "omo.dag.updated",
    data: { runs, truncated_runs: truncated },
  });
  const dagBody = (runs: readonly Record<string, unknown>[], truncated = false): unknown => ({
    history: { dag: { runs, truncated_runs: truncated }, task: { tasks: [] } },
  });
  const completedAt = "2026-09-07T10:02:00.000Z";
  const olderAt = "2026-09-07T10:01:00.000Z";

  describe.each(["live", "REST"] as const)("%s unknown timestamp hydration", (source) => {
    describe.each([false, true])("truncated_runs=%s", (truncated) => {
      describe.each(["running", "completed"])("known %s incumbent", (status) => {
        it.each(UNKNOWN_DAG_TIMESTAMPS)("$label preserves membership and equal replay", async ({ value }) => {
          const row = orderingDagRun(completedAt, status);
          render([dagFrame([row])]);
          const incumbent = current?.activities.dags.get("ordering-run");
          expect(incumbent?.status).toBe(status);
          const incoming = orderingDagRun(value, status === "running" ? "completed" : "running");
          if (source === "live") {
            act(() => deliver(dagFrame([incoming], truncated)));
            expect(current?.activities.dags.get("ordering-run")).toBe(incumbent);
            await resolveActivity(0, dagBody([row], truncated));
          } else {
            await resolveActivity(0, dagBody([incoming], truncated));
          }
          expect(current?.activities.dags.size).toBe(1);
          expect(current?.activities.dags.get("ordering-run")).toBe(incumbent);
          act(() => deliver(dagFrame([row])));
          expect(current?.activities.dags.size).toBe(1);
          expect(current?.activities.dags.get("ordering-run")).toBe(incumbent);
          act(() => { reopen(); deliver(readyFrame()); });
          await resolveActivity(1, dagBody([row]));
          expect(current?.activities.dags.get("ordering-run")).toBe(incumbent);
        });
      });

      it.each(UNKNOWN_DAG_TIMESTAMPS)("$label admits unknown-only rows in both source orders without a terminal latch", async ({ value }) => {
        render();
        const completed = orderingDagRun(value);
        const running = orderingDagRun(value, "running");
        if (source === "live") {
          act(() => deliver(dagFrame([completed], truncated)));
        } else {
          await resolveActivity(0, dagBody([completed], truncated));
        }
        expect(current?.activities.dags.get("ordering-run")).toMatchObject({
          status: "completed", counts: { completed: 1, running: 0 }, nodes: [{ state: "completed", attempt: 1 }], truncated,
        });
        expect(current?.activities.dagFreshness?.size).toBe(0);
        if (source === "live") {
          await resolveActivity(0, dagBody([running], truncated));
        } else {
          act(() => deliver(dagFrame([running], truncated)));
        }
        expect(current?.activities.dags.get("ordering-run")).toMatchObject({
          status: "running", counts: { completed: 0, running: 1 }, nodes: [{ state: "running", attempt: 2 }],
        });
        expect(current?.activities.dagFreshness?.size).toBe(0);
        act(() => deliver(dagFrame([orderingDagRun(completedAt)])));
        expect(current?.activities.dags.get("ordering-run")).toMatchObject({ status: "completed", updatedAt: completedAt });
        expect(current?.activities.dagFreshness?.get("ordering-run")).toBe(Date.parse(completedAt));
      });
    });
  });

  it.each([false, true])("newer REST wins stale live input with retained initial state=%s", async (retained) => {
    render(retained ? [dagFrame([orderingDagRun(completedAt)])] : []);
    act(() => deliver(dagFrame([orderingDagRun(olderAt, "running")])));
    await resolveActivity(0, dagBody([orderingDagRun(completedAt)]));
    expect(current?.activities.dags.get("ordering-run")).toMatchObject({
      status: "completed", updatedAt: completedAt, counts: { running: 0, completed: 1 },
      nodes: [{ state: "completed", attempt: 1 }],
    });
    act(() => deliver(dagFrame([orderingDagRun(olderAt, "running")])));
    expect(current?.activities.dags.get("ordering-run")?.status).toBe("completed");
    act(() => { reopen(); deliver(readyFrame()); });
    act(() => deliver(dagFrame([orderingDagRun(olderAt, "running")])));
    await resolveActivity(1, dagBody([orderingDagRun(completedAt)]));
    expect(current?.activities.dags.get("ordering-run")?.status).toBe("completed");
  });

  it("older live input after REST cannot regress completion, but newer input restarts", async () => {
    render();
    await resolveActivity(0, dagBody([orderingDagRun(completedAt)]));
    act(() => {
      deliver({ type: "run.started", sessionId: session.id });
      deliver({ type: "run.done", sessionId: session.id, reason: "completed" });
    });
    expect(current?.activities.dags.get("ordering-run")?.status).toBe("completed");
    act(() => deliver(dagFrame([orderingDagRun(olderAt, "running")])));
    expect(current?.activities.dags.get("ordering-run")?.status).toBe("completed");
    act(() => deliver(dagFrame([orderingDagRun("2026-09-07T10:03:00Z", "running")])));
    expect(current?.activities.dags.get("ordering-run")?.nodes[0]?.attempt).toBe(2);
    expect(current?.activities.dags.get("ordering-run")?.status).toBe("running");
  });

  it.each([
    ["newer live", completedAt, olderAt, "running"],
    ["equal keeps incumbent", completedAt, completedAt, "running"],
    ["known beats unknown REST", completedAt, undefined, "running"],
    ["both unknown accepts REST last", undefined, undefined, "completed"],
  ])("reconciles %s against current accepted rows", async (_case, liveAt, restAt, status) => {
    render();
    act(() => deliver(dagFrame([orderingDagRun(liveAt, "running")])));
    await resolveActivity(0, dagBody([orderingDagRun(restAt)]));
    expect(current?.activities.dags.get("ordering-run")?.status).toBe(status);
  });

  it.each([false, true])("REST omission preserves only actual live touches when truncated=%s", async (truncated) => {
    const run = (id: string, at = completedAt) => orderingDagRun(at, "completed", { run_id: id });
    render([dagFrame([run("untouched"), run("rejected"), run("accepted"), run("mutated"), run("heartbeat")])]);
    act(() => {
      deliver(dagFrame([run("rejected", olderAt), run("accepted", "2026-09-07T10:03:00Z")]));
      deliver({ type: "extensionEvent", sessionId: session.id, name: "omo.dag.activity",
        data: { runId: "mutated", nodeId: "n1", at: completedAt, activity: "thinking" } });
      deliver({ type: "extensionEvent", sessionId: session.id, name: "omo.dag.activity",
        data: { runId: "untouched", nodeId: "missing", at: completedAt, activity: "thinking" } });
      deliver({ type: "extensionEvent", sessionId: session.id, name: "omo.dag.heartbeat",
        data: { at: completedAt, runs: [{ runId: "heartbeat", headSeq: 8 }] } });
    });
    await resolveActivity(0, dagBody([], truncated));
    expect([...current?.activities.dags.keys() ?? []].sort()).toEqual(truncated
      ? ["accepted", "heartbeat", "mutated", "rejected", "untouched"] : ["accepted", "mutated"]);
    expect(current?.activities.truncatedDags).toBe(truncated);
  });

  it("does not reapply buffered replacing DAG snapshots over REST-only running rows", async () => {
    render();
    act(() => deliver(dagFrame([orderingDagRun(completedAt)])));
    await resolveActivity(0, dagBody([
      orderingDagRun(completedAt), orderingDagRun(completedAt, "running", { run_id: "rest-only" }),
    ]));
    expect(current?.activities.dags.has("rest-only")).toBe(true);
  });

  it("replays retained progress for REST-introduced nodes without replacing authoritative rows", async () => {
    render();
    act(() => deliver({ type: "extensionEvent", sessionId: session.id, name: "omo.dag.activity",
      data: { runId: "ordering-run", nodeId: "n1", at: completedAt, activity: "thinking" } }));
    await resolveActivity(0, dagBody([orderingDagRun(completedAt)]));
    expect(current?.activities.dags.get("ordering-run")).toMatchObject({
      status: "completed", updatedAt: completedAt, nodes: [{ state: "completed", activity: "thinking" }],
    });
  });

  it("overflow retains dropped overlays while accepting newer REST and unrelated rows", async () => {
    const nodes = Array.from({ length: 125 }, (_, index) => ({
      id: `n${index}`, prompt: "do", depends_on: [], state: "running",
    }));
    render([dagFrame([orderingDagRun(olderAt, "running", { nodes, counts: { total: 125, running: 125 } })])]);
    act(() => {
      for (const node of nodes) deliver({
        type: "extensionEvent", sessionId: session.id, name: "omo.dag.activity",
        data: { runId: "ordering-run", nodeId: node.id, at: completedAt, activity: `work-${node.id}` },
      });
    });
    await resolveActivity(0, dagBody([
      orderingDagRun(completedAt, "completed", {
        nodes: nodes.map(node => ({ ...node, state: "completed" })), counts: { total: 125, completed: 125 },
      }), orderingDagRun(completedAt, "running", { run_id: "rest-only" }),
    ], true));
    const run = current?.activities.dags.get("ordering-run");
    expect(run).toMatchObject({ status: "completed", updatedAt: completedAt, counts: { total: 125, completed: 125, running: 0 } });
    expect(run?.nodes).toHaveLength(125);
    for (const node of run?.nodes ?? []) expect(node).toMatchObject({ state: "completed", activity: `work-${node.id}` });
    expect(current?.activities.dags.has("rest-only")).toBe(true);
    expect(current?.activities.truncatedDags).toBe(true);
  });

  it("identical progress received during REST is not a new per-ID mutation", async () => {
    const progress: ChatServerFrame = { type: "extensionEvent", sessionId: session.id, name: "omo.dag.activity",
      data: { runId: "ordering-run", nodeId: "n1", at: completedAt, activity: "thinking" } };
    render([dagFrame([orderingDagRun(completedAt)]), progress]);
    act(() => deliver(progress));
    await resolveActivity(0, dagBody([]));
    expect(current?.activities.dags.has("ordering-run")).toBe(false);
  });

  it("retains compact per-ID freshness only for the mounted pane lifetime", async () => {
    render([dagFrame([orderingDagRun(completedAt)])]);
    await resolveActivity(0, dagBody([]));
    expect(current?.activities.dags.size).toBe(0);
    expect(current?.activities.dagFreshness?.size).toBe(1);
    expect(current?.activities.dagFreshness?.get("ordering-run")).toBe(Date.parse(completedAt));

    // ChatPane is keyed by session.id in SplitView; replacing/closing it
    // unmounts this hook rather than transferring activity state to a new pane.
    act(() => root.render(null));
    render();
    expect(current?.activities.dags.size).toBe(0);
    expect(current?.activities.dagFreshness?.size ?? 0).toBe(0);
    act(() => deliver(dagFrame([orderingDagRun(olderAt, "running")])));
    expect(current?.activities.dags.get("ordering-run")?.status).toBe("running");
    expect(current?.activities.dagFreshness?.size).toBe(1);
    await resolveActivity(1, dagBody([orderingDagRun(olderAt, "running")]));
    expect(current?.activities.dagFreshness?.size).toBe(1);
  });

});
