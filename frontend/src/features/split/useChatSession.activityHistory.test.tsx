import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatConnector, ChatServerFrame } from "../../lib/chatWs";
import { ActivityShelf } from "./ActivityShelf";
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
});
