import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatConnector, ChatServerFrame } from "../../lib/chatWs";
import { useChatSession } from "./useChatSession";

const session = {
  id: "chat-1",
  name: "Chat",
  wsId: "workspace-1",
  cwd: "/work",
  provider: "omo",
} as const;

const TASK_DETAILS = {
  op: "write",
  storage: "memory",
  completedTasks: [{ phase: "Live", content: "finished work" }],
  phases: [{ name: "Live", tasks: [{ content: "live work", status: "in_progress" as const }] }],
};

const TOOLRESULT_HISTORY_PHASES = [
  { name: "From toolResult", tasks: [{ content: "history tool", status: "pending" as const }] },
];

const CUSTOM_HISTORY_PHASES = [
  { name: "From custom", tasks: [{ content: "history custom", status: "completed" as const }] },
];

describe("useChatSession activities", () => {
  let root: Root;
  let container: HTMLDivElement;
  let current: ReturnType<typeof useChatSession> | undefined;
  let deliver: (frame: ChatServerFrame) => void;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const connect: ChatConnector = (handlers) => {
      deliver = handlers.onFrame;
      handlers.onOpen?.();
      return { send: () => true, close: () => undefined };
    };
    function Probe() {
      current = useChatSession(session, connect);
      return null;
    }
    act(() => root.render(<Probe />));
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it("applies extensionEvent frames into the activities domain and bumps the version", () => {
    expect(current?.activitiesVersion).toBe(0);

    act(() => {
      deliver({
        type: "extensionEvent",
        sessionId: session.id,
        name: "omo.task.updated",
        data: {
          parent_session_id: "sess-1",
          tasks: [{ task_id: "t1", name: "Spawn", status: "running" }],
        },
      });
      deliver({
        type: "extensionEvent",
        sessionId: session.id,
        name: "omo.dag.updated",
        data: {
          runs: [
            {
              run_id: "r1",
              run_key: "plan",
              name: "Ship",
              status: "running",
              nodes: [{ id: "n1", prompt: "do", depends_on: [], state: "running" }],
            },
          ],
        },
      });
    });

    expect(current?.activities.tasks.get("t1")?.name).toBe("Spawn");
    expect(current?.activities.dags.get("r1")?.name).toBe("Ship");
    expect(current?.activities.todo).toBeNull();
    expect(current?.activitiesVersion).toBe(2);

    act(() => {
      deliver({ type: "extensionEvent", sessionId: session.id, name: "omo.unknown", data: { tasks: [] } });
    });
    expect(current?.activitiesVersion).toBe(2);
  });

  it("keeps todo tool partial and end details on toolCalls without committing todo", () => {
    const startPhases = [{ name: "Start", tasks: [{ content: "starting", status: "pending" as const }] }];
    act(() => {
      deliver({ type: "tool", sessionId: session.id, toolCallId: "call-1", toolName: "todo", phase: "start" });
      deliver({
        type: "tool",
        sessionId: session.id,
        toolCallId: "call-1",
        toolName: "todo",
        phase: "update",
        partial: { details: { op: "write", phases: startPhases } },
      });
    });

    expect(current?.activities.todo).toBeNull();
    expect(current?.toolCalls["call-1"]?.phase).toBe("update");

    act(() => {
      deliver({
        type: "tool",
        sessionId: session.id,
        toolCallId: "call-1",
        toolName: "todo",
        phase: "end",
        result: { details: TASK_DETAILS },
      });
    });

    expect(current?.activities.todo).toBeNull();
    // Tool results are presentation, not canonical list acquisitions.
    expect(current?.activitiesVersion).toBe(0);
    // Existing toolCalls handling is untouched by the activity wiring.
    expect(current?.toolCalls["call-1"]).toMatchObject({
      toolName: "todo",
      phase: "end",
      isError: false,
    });
    expect(current?.toolCalls["call-1"]?.details).toEqual(TASK_DETAILS);
  });

  it("restores transcript without committing custom or toolResult todo carriers", () => {
    act(() =>
      deliver({
        type: "entries",
        sessionId: session.id,
        entries: [
          { type: "message", message: { role: "user", content: "plan it", timestamp: 1 } },
          {
            type: "message",
            message: {
              role: "toolResult",
              toolName: "todo",
              content: [{ text: "written" }],
              details: { op: "write", phases: TOOLRESULT_HISTORY_PHASES },
            },
          },
          {
            type: "custom",
            customType: "senpi.todo-state",
            data: { schema: "v2", op: "write", phases: CUSTOM_HISTORY_PHASES },
          },
        ],
      }),
    );

    expect(current?.activities.todo).toBeNull();
    expect(current?.activitiesVersion).toBe(0);
    // The todo-state custom entry must never become a visible transcript row.
    expect((current?.messages ?? []).every((message) => message.role !== "custom")).toBe(true);
    expect(current?.messages[0]?.role).toBe("user");
  });

  it("does not grant either live results or history todo authority", () => {
    act(() => {
      deliver({
        type: "tool",
        sessionId: session.id,
        toolCallId: "call-1",
        toolName: "todo",
        phase: "end",
        result: { details: TASK_DETAILS },
      });
    });
    expect(current?.activities.todo).toBeNull();

    act(() =>
      deliver({
        type: "entries",
        sessionId: session.id,
        entries: [
          {
            type: "custom",
            customType: "senpi.todo-state",
            data: { schema: "v2", op: "write", phases: CUSTOM_HISTORY_PHASES },
          },
        ],
      }),
    );

    expect(current?.activities.todo).toBeNull();
    expect(current?.activitiesVersion).toBe(0);
  });

  it("does not crash when activity events arrive before history entries", () => {
    act(() => {
      // Live node activity for a run that has no snapshot yet is a no-op.
      deliver({
        type: "extensionEvent",
        sessionId: session.id,
        name: "omo.dag.activity",
        data: { runId: "r-unknown", nodeId: "n1", at: "2026-08-19T12:00:00.000Z" },
      });
      deliver({
        type: "extensionEvent",
        sessionId: session.id,
        name: "omo.task.updated",
        data: { parent_session_id: "sess-1", tasks: [{ task_id: "t1", name: "Early", status: "running" }] },
      });
    });

    act(() =>
      deliver({
        type: "entries",
        sessionId: session.id,
        entries: [{ type: "message", message: { role: "user", content: "hi", timestamp: 1 } }],
      }),
    );

    expect(current?.messages[0]?.role).toBe("user");
    expect(current?.activities.tasks.get("t1")?.name).toBe("Early");
    expect(current?.activities.todo).toBeNull();
    expect(current?.activities.dags.size).toBe(0);
  });
});
