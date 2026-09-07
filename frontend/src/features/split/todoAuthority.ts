import type { ChatServerFrame } from "../../lib/chatWs";
import { parseTodoDetails } from "./activityParseTodo";
import type { TodoPhase } from "./activityTypes";

type TodoFrame = Extract<ChatServerFrame, { readonly type: "chat.todo" }>;
type ReadyFrame = Extract<ChatServerFrame, { readonly type: "ready" }>;
type TodoBinding = Pick<TodoFrame, "sessionId" | "durableSessionId" | "bindingId">;

export interface TodoAuthority {
  readonly binding: TodoBinding | null;
  readonly requestGeneration: number;
  readonly status: TodoFrame["status"] | null;
  readonly source: TodoFrame["source"] | null;
  readonly error: TodoFrame["error"] | null;
  readonly todo: readonly TodoPhase[] | null;
}

export function emptyTodoAuthority(): TodoAuthority {
  return { binding: null, requestGeneration: -1, status: null, source: null, error: null, todo: null };
}

/** Unbind acceptance, not display: a blocked replacement read proves no clear. */
export function unbindTodoAuthority(state: TodoAuthority): TodoAuthority {
  if (state.binding === null) return state;
  return { ...state, binding: null, requestGeneration: -1, status: null, error: null };
}

function matches(binding: TodoBinding, frame: TodoBinding): boolean {
  return binding.sessionId === frame.sessionId && binding.durableSessionId === frame.durableSessionId
    && binding.bindingId === frame.bindingId;
}

export function bindTodoAuthority(state: TodoAuthority, frame: ReadyFrame): TodoAuthority {
  if (!frame.bindingId || !frame.piSessionId) return unbindTodoAuthority(state);
  const binding = { sessionId: frame.sessionId, durableSessionId: frame.piSessionId, bindingId: frame.bindingId };
  if (state.binding !== null && matches(state.binding, binding)) return state;
  return { ...state, binding, requestGeneration: -1, status: null, error: null };
}

/** Frames arrive through the wire parser; generations fence acquisitions, not source coordinates. */
export function applyTodoAuthority(state: TodoAuthority, frame: TodoFrame): TodoAuthority {
  if (state.binding === null || !matches(state.binding, frame)
    || frame.requestGeneration <= state.requestGeneration) return state;
  if (frame.status === "unavailable") {
    return { ...state, requestGeneration: frame.requestGeneration, status: frame.status, error: frame.error };
  }
  // The generated frame has optional successful fields. Reuse atomic phases
  // parsing rather than filtering malformed lists into an authoritative clear.
  const parsed = frame.phases === null ? null : parseTodoDetails({ phases: frame.phases });
  if (frame.source === undefined || (frame.phases !== null && parsed === null)) return state;
  return {
    ...state, requestGeneration: frame.requestGeneration, status: frame.status,
    source: frame.source, error: null, todo: parsed?.phases ?? null,
  };
}
