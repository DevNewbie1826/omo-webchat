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
  let resolveFetch: (response: Response) => void;

  const render = (initialFrames: readonly ChatServerFrame[] = []): void => {
    const connect: ChatConnector = (handlers) => {
      deliver = handlers.onFrame;
      handlers.onOpen?.();
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
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    })));
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

    await act(async () => {
      resolveFetch(new Response(JSON.stringify(activityBody("history-task", "history-dag")), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
      await Promise.resolve();
    });

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

  it("preserves a push newer than the REST request while hydrating the other side", async () => {
    render();
    act(() => deliver(snapshotFrame("task", "new-live-task")));

    await act(async () => {
      resolveFetch(new Response(JSON.stringify(activityBody("old-history-task", "history-dag")), { status: 200 }));
      await Promise.resolve();
    });

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

    await act(async () => {
      resolveFetch(new Response(JSON.stringify({
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
      }), { status: 200 }));
      await Promise.resolve();
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
});
