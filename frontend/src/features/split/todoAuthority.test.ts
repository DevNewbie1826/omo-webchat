import { describe, expect, it } from "vitest";
import type { ChatServerFrame } from "../../lib/chatWs";
import type { TodoPhase } from "./activityTypes";
import { applyTodoAuthority, bindTodoAuthority, emptyTodoAuthority, unbindTodoAuthority } from "./todoAuthority";

type TodoFrame = Extract<ChatServerFrame, { readonly type: "chat.todo" }>;
const ready = { type: "ready", sessionId: "chat", piSessionId: "durable", bindingId: "binding", resumed: true } as const;
const completed: readonly TodoPhase[] = [{ name: "Plan", tasks: [{ content: "same text", status: "completed" }] }];
const frame = (phases: readonly TodoPhase[] | null, requestGeneration = 0): TodoFrame => ({
  type: "chat.todo", sessionId: ready.sessionId, durableSessionId: ready.piSessionId, bindingId: ready.bindingId,
  requestGeneration, status: "ready", phases,
  source: phases === null ? { kind: "absent", leafId: "leaf", entryId: null, entryIndex: null }
    : { kind: "custom", leafId: "leaf", entryId: `state-${requestGeneration}`, entryIndex: requestGeneration },
});
const incumbent = () => applyTodoAuthority(bindTodoAuthority(emptyTodoAuthority(), ready), frame(completed));

describe("whole-list todo authority", () => {
  it("admits generation zero only after matching ready", () => {
    const empty = emptyTodoAuthority();
    expect(applyTodoAuthority(empty, frame(completed))).toBe(empty);
    expect(incumbent()).toMatchObject({ requestGeneration: 0, status: "ready", todo: completed });
  });

  it.each(["sessionId", "durableSessionId", "bindingId"] as const)("rejects mismatching %s without consuming the acquisition", field => {
    const state = incumbent();
    expect(applyTodoAuthority(state, { ...frame([], 1), [field]: "other" })).toBe(state);
    expect(applyTodoAuthority(state, frame([], 1)).todo).toEqual([]);
  });

  it("is idempotent for equal acquisitions, even conflicting redelivery", () => {
    const state = applyTodoAuthority(incumbent(), frame([], 4));
    for (const generation of [0, 3, 4]) expect(applyTodoAuthority(state, frame(completed, generation))).toBe(state);
    expect(bindTodoAuthority(state, ready)).toBe(state);
    expect(applyTodoAuthority(state, frame([], 4))).toBe(state);
  });

  it.each(["history-unavailable", "invalid-state", "oversized"] as const)("retains list and source through %s, fencing older acquisitions", error => {
    const state = incumbent();
    const unavailable: TodoFrame = {
      type: "chat.todo", sessionId: "chat", durableSessionId: "durable", bindingId: "binding",
      requestGeneration: 2, status: "unavailable", error,
    };
    const next = applyTodoAuthority(state, unavailable);
    expect(next.todo).toBe(state.todo);
    expect(next.source).toBe(state.source);
    expect(next).toMatchObject({ status: "unavailable", error, requestGeneration: 2 });
    expect(applyTodoAuthority(next, frame([], 1))).toBe(next);
    expect(applyTodoAuthority(next, unavailable)).toBe(next);
    expect(applyTodoAuthority(next, frame([], 3))).toMatchObject({ todo: [], status: "ready", error: null });
  });

  it("retains display on unbind and permits a new binding's lower acquisition", () => {
    const state = applyTodoAuthority(incumbent(), frame(completed, 50));
    const unbound = unbindTodoAuthority(state);
    expect(unbound.todo).toBe(state.todo);
    expect(unbindTodoAuthority(unbound)).toBe(unbound);
    expect(applyTodoAuthority(unbound, frame([], 51))).toBe(unbound);
    const rebound = bindTodoAuthority(unbound, { ...ready, bindingId: "replacement" });
    expect(rebound.todo).toBe(state.todo);
    expect(applyTodoAuthority(rebound, frame([], 51))).toBe(rebound);
    expect(applyTodoAuthority(rebound, { ...frame([], 0), bindingId: "replacement" }).todo).toEqual([]);
  });

  it("legacy ready removes todo authority without clearing display", () => {
    const { bindingId: _binding, ...legacy } = ready;
    const state = bindTodoAuthority(incumbent(), legacy);
    expect(state.binding).toBeNull();
    expect(state.todo).toEqual(completed);
    expect(applyTodoAuthority(state, frame([], 2))).toBe(state);
  });

  const replacements: readonly [string, readonly TodoPhase[] | null][] = [
    ["explicit clear", []],
    ["proven absent", null],
    ["named empty phase", [{ name: "Empty", tasks: [] }]],
    ["intentional same-text reopen", [{ name: "Plan", tasks: [{ content: "same text", status: "in_progress" }] }]],
    ["re-init", [{ name: "New plan", tasks: [{ content: "different", status: "pending" }] }]],
    ["append", [{ name: "Plan", tasks: [{ content: "same text", status: "completed" }, { content: "added", status: "pending" }] }]],
    ["rename and move", [{ name: "Elsewhere", tasks: [{ content: "renamed", status: "pending" }] }]],
    ["drop", [{ name: "Plan", tasks: [{ content: "same text", status: "abandoned" }] }]],
    ["duplicate content", [{ name: "Plan", tasks: [{ content: "same text", status: "pending" }, { content: "same text", status: "completed" }] }]],
  ];
  it.each(replacements)("replaces the entire list for %s", (_name, phases) => {
    const next = applyTodoAuthority(incumbent(), frame(phases, 1));
    expect(next.todo).toEqual(phases);
  });

  it("does not compare source IDs, branch positions or custom/legacy kinds", () => {
    const state = applyTodoAuthority(incumbent(), frame(completed, 30));
    const next = applyTodoAuthority(state, { ...frame([], 31), source: { leafId: "older-branch", entryId: "ancestor", entryIndex: 0, kind: "legacy-tool" } });
    expect(next.todo).toEqual([]);
    expect(next.source).toEqual({ leafId: "older-branch", entryId: "ancestor", entryIndex: 0, kind: "legacy-tool" });
  });

  it("does not consume successful acquisitions missing optional generated fields", () => {
    const state = incumbent();
    const { phases: _phases, ...missingPhases } = frame([], 1);
    const { source: _source, ...missingSource } = frame([], 1);
    expect(applyTodoAuthority(state, missingPhases)).toBe(state);
    expect(applyTodoAuthority(state, missingSource)).toBe(state);
    expect(applyTodoAuthority(state, frame([], 1)).todo).toEqual([]);
  });
});
