import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseChatServerFrame, type ChatConnector, type ChatServerFrame } from "../../lib/chatWs";
import type { TodoPhase } from "./activityTypes";
import { ActivityShelf } from "./ActivityShelf";
import { messageText } from "./chatEntries";
import { useChatSession } from "./useChatSession";

const session = { id: "todo-chat", wsId: "todo-workspace", name: "Todo", cwd: "/fixture", provider: "omo" } as const;
const A = [{ name: "검증", tasks: [{ content: "old completed", status: "completed" as const }] }];
const B = [{ name: "Canonical B", tasks: [{ content: "new work", status: "in_progress" as const }] }];
const ready = (bindingId = "binding-a", piSessionId = "durable-a"): ChatServerFrame => ({
  type: "ready", sessionId: session.id, piSessionId, bindingId, resumed: true,
});
const projection = (phases: readonly TodoPhase[] | null, requestGeneration = 1, bindingId = "binding-a", durableSessionId = "durable-a"): Extract<ChatServerFrame, { readonly type: "chat.todo" }> => ({
  type: "chat.todo", sessionId: session.id, durableSessionId, bindingId, requestGeneration, status: "ready",
  source: phases === null
    ? { kind: "absent", leafId: "leaf", entryId: null, entryIndex: null }
    : { kind: "custom", leafId: "leaf", entryId: `entry-${requestGeneration}`, entryIndex: requestGeneration },
  phases,
});

describe("canonical todo hook authority", () => {
  let root: Root;
  let container: HTMLDivElement;
  let current: ReturnType<typeof useChatSession>;
  let deliver: (frame: ChatServerFrame) => void;
  let reopen: () => void;
  let close: () => void;
  let activityResolvers: ((response: Response) => void)[];

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    activityResolvers = [];
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
      if (String(input).endsWith("/activity")) return new Promise<Response>(resolve => activityResolvers.push(resolve));
      return new Promise<Response>(() => undefined);
    }));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const connect: ChatConnector = handlers => {
      deliver = handlers.onFrame;
      reopen = () => handlers.onOpen?.();
      close = () => handlers.onClose?.(1000);
      handlers.onOpen?.();
      return { send: () => true, close: () => undefined };
    };
    function Probe() { current = useChatSession(session, connect); return <ActivityShelf activities={current.activities} />; }
    act(() => root.render(<Probe />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("replaces restored A with canonical B and ignores late raw results and transcript replay", () => {
    act(() => { deliver(ready()); deliver(projection(A)); });
    expect(current.activities.todo).toEqual(A);
    act(() => { close(); reopen(); deliver(ready("binding-b")); deliver(projection(B, 1, "binding-b")); });
    expect(current.activities.todo).toEqual(B);
    act(() => {
      deliver({ type: "tool", sessionId: session.id, toolCallId: "late", toolName: "todo", phase: "end", result: { details: { phases: A, completedTasks: [{ phase: "검증", content: "old completed" }] } } });
      deliver({ type: "entries", sessionId: session.id, final: true, entries: [
        { type: "message", message: { role: "user", content: "keep transcript", timestamp: 1 } },
        { type: "custom", customType: "senpi.todo-state", data: { schema: "v2", phases: A } },
        { type: "tool", toolName: "todo", result: { details: { phases: A } } },
        { type: "message", message: { role: "toolResult", toolName: "todo", content: [{ text: "written" }], details: { phases: A } } },
      ] });
    });
    expect(current.activities.todo).toEqual(B);
    expect(current.toolCalls["late"]?.details).toMatchObject({ phases: A });
    expect(current.messages.map(messageText)).toEqual(["keep transcript", ""]);
    expect(current.messages.map(message => message.role)).toEqual(["user", "assistant"]);
    expect(current.messages[1]?.blocks).toEqual([{ kind: "tool", name: "todo", text: "written" }]);
  });

  it("renders canonical replacement, unavailable retention, reopen and clear on the permanent todo tab", () => {
    act(() => { deliver(ready()); deliver(projection(A)); });
    act(() => container.querySelector<HTMLButtonElement>('[data-activity-tab="todo"]')!.click());
    expect(container.querySelector(".th-activity-todo-task--completed .th-activity-todo-text")?.textContent).toBe("old completed");
    act(() => deliver(projection(B, 2)));
    expect(container.querySelector(".th-activity-todo-task--in_progress .th-activity-todo-text")?.textContent).toBe("new work");
    expect(container.querySelectorAll(".th-activity-todo-task")).toHaveLength(1);
    act(() => deliver({ type: "chat.todo", sessionId: session.id, durableSessionId: "durable-a", bindingId: "binding-a", requestGeneration: 3, status: "unavailable", error: "oversized" }));
    expect(container.querySelector(".th-activity-todo-text")?.textContent).toBe("new work");
    act(() => deliver(projection([], 4)));
    expect(container.querySelectorAll(".th-activity-todo-task")).toHaveLength(0);
    expect(container.querySelector('[data-activity-tab="todo"]')).not.toBeNull();
    act(() => deliver(projection(B, 5)));
    expect(container.querySelector(".th-activity-todo-text")?.textContent).toBe("new work");
    act(() => deliver(projection(null, 6)));
    expect(container.querySelector(".th-activity-shelf")).toBeNull();
  });

  it.each(["custom", "legacy-tool"] as const)("commits canonical %s pushes without tool or entries frames", kind => {
    act(() => {
      deliver(ready());
      deliver({ ...projection(B), source: { kind, leafId: "leaf", entryId: "state", entryIndex: 0 } });
    });
    expect(current.activities.todo).toEqual(B);
    expect(current.toolCalls).toEqual({});
    expect(current.messages).toEqual([]);
  });

  it("retains display while a rebind read is blocked and rejects every old identity", () => {
    act(() => { deliver(ready()); deliver(projection(A, 20)); close(); });
    act(() => deliver(projection(B, 21)));
    expect(current.activities.todo).toEqual(A);
    act(() => { reopen(); deliver(projection(B, 22)); });
    expect(current.activities.todo).toEqual(A);
    act(() => deliver(ready("binding-b", "durable-b")));
    act(() => {
      deliver(projection(B, 23));
      deliver(projection(B, 24, "binding-b"));
      deliver({ ...projection(B, 25, "binding-b", "durable-b"), sessionId: "wrong-chat" });
      deliver({ type: "chat.todo", sessionId: session.id, durableSessionId: "durable-b", bindingId: "binding-b", requestGeneration: 1, status: "unavailable", error: "history-unavailable" });
    });
    expect(current.activities.todo).toEqual(A);
    act(() => deliver(projection(B, 2, "binding-b", "durable-b")));
    expect(current.activities.todo).toEqual(B);
  });

  it.each(["resync", "reloadExternalWrite"] as const)("blocks the old binding during %s before replacement ready", action => {
    act(() => {
      deliver(ready()); deliver(projection(A));
      deliver({ type: "entries", sessionId: session.id, final: true, entries: [] });
    });
    act(() => { expect(current[action]()).toBe(true); });
    act(() => deliver(projection(B, 2)));
    expect(current.activities.todo).toEqual(A);
    act(() => { deliver(ready("binding-b")); deliver(projection(B, 0, "binding-b")); });
    expect(current.activities.todo).toEqual(B);
  });

  it("rejects older acquisitions, makes equal delivery idempotent, and preserves unavailable", () => {
    act(() => { deliver(ready()); deliver(projection(B, 3)); });
    const version = current.activitiesVersion;
    const list = current.activities.todo;
    act(() => { deliver(projection(A, 2)); deliver(projection(A, 3)); deliver(ready()); deliver(projection(B, 3)); });
    expect(current.activities.todo).toBe(list);
    expect(current.activitiesVersion).toBe(version);
    act(() => {
      deliver({ type: "chat.todo", sessionId: session.id, durableSessionId: "durable-a", bindingId: "binding-a", requestGeneration: 5, status: "unavailable", error: "invalid-state" });
      deliver(projection(A, 4));
    });
    expect(current.activities.todo).toBe(list);
    act(() => deliver(projection(A, 6)));
    expect(current.activities.todo).toEqual(A);
  });

  it("accepts clear, absent, named empty, and intentional reopen without merging membership", () => {
    act(() => { deliver(ready()); deliver(projection(A)); });
    for (const [index, phases] of [[], null, [{ name: "Empty", tasks: [] }], B, A, B].entries()) {
      act(() => deliver(projection(phases, index + 2)));
      expect(current.activities.todo).toEqual(phases);
    }
    const branch = { ...projection(A, 10), source: { kind: "custom" as const, leafId: "other-branch", entryId: "ancestor", entryIndex: 0 } };
    act(() => deliver(branch));
    expect(current.activities.todo).toEqual(A);
  });

  it("rejects malformed wire snapshots atomically without clearing the incumbent", () => {
    act(() => { deliver(ready()); deliver(projection(B)); });
    expect(parseChatServerFrame(projection(B, 2))).not.toBeNull();
    for (const phases of [undefined, [{}], [{ name: "bad", tasks: [{ content: "x", status: "unknown" }] }], [B[0], {}]]) {
      const parsed = parseChatServerFrame({ ...projection(B, 2), phases });
      expect(parsed).toBeNull();
      if (parsed) act(() => deliver(parsed));
      expect(current.activities.todo).toEqual(B);
    }
  });

  it.each(["update", "end"] as const)("preserves clear against late %s and error tool cards", phase => {
    act(() => { deliver(ready()); deliver(projection([])); });
    act(() => deliver({ type: "tool", sessionId: session.id, toolCallId: "late", toolName: "todo", phase, isError: true,
      partial: { details: { phases: A } }, result: { details: { phases: A } } }));
    expect(current.activities.todo).toEqual([]);
    expect(current.toolCalls["late"]).toMatchObject({ phase, isError: true, details: { phases: A } });
  });

  it("preserves canonical todo through task/DAG hydration, live events and parent settlement", async () => {
    act(() => { deliver(ready()); deliver(projection(B)); });
    await act(async () => {
      activityResolvers[0]!(new Response(JSON.stringify({ history: {
        task: { tasks: [{ task_id: "task", name: "Task", status: "running" }] },
        dag: { runs: [{ run_id: "dag", run_key: "plan", name: "DAG", status: "running", nodes: [] }] },
      }, task_digest: { tasks: [{ task_id: "task", status: "running" }], truncated: false }, dag_digest: { runs: [], truncated: false } }), { status: 200 }));
    });
    expect(current.activities.tasks.get("task")?.name).toBe("Task");
    expect(current.activities.dags.get("dag")?.name).toBe("DAG");
    const tasks = current.activities.tasks;
    const dags = current.activities.dags;
    act(() => deliver(projection(A, 2)));
    expect(current.activities.tasks).toBe(tasks);
    expect(current.activities.dags).toBe(dags);
    act(() => {
      deliver({ type: "run.started", sessionId: session.id });
      deliver({ type: "extensionEvent", sessionId: session.id, name: "omo.task.updated", data: { tasks: [{ task_id: "task", name: "Task", status: "completed" }] } });
      deliver({ type: "run.done", sessionId: session.id, reason: "completed" });
      deliver({ type: "state", sessionId: session.id, isStreaming: false, isCompacting: false });
    });
    expect(current.activities.todo).toEqual(A);
    expect(current.activities.tasks.get("task")?.status).toBe("completed");
    expect(current.activities.dags.has("dag")).toBe(true);
  });
});
