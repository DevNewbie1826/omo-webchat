import type { UiMessage } from "./chatEntries";
import { extractTodoPhases } from "./chatTodoHistory";
import * as chatState from "./chatSessionState";
import type { TodoPhase } from "./activityTypes";
import type { SteerMark } from "./chatSteerMarks";

interface ReconcileFrameHistoryInput {
  readonly entries: unknown;
  readonly current: readonly UiMessage[];
  readonly preserveCurrent: boolean;
  readonly hasLiveTodo: boolean;
  /** Stable canonical user-message occurrences admitted as steers. */
  readonly steerMarks?: readonly SteerMark[];
}

interface ReconcileFrameHistoryResult {
  readonly history: ReturnType<typeof chatState.reconcileHistory>;
  readonly todo: readonly TodoPhase[] | null;
}

export function reconcileFrameHistory(input: ReconcileFrameHistoryInput): ReconcileFrameHistoryResult {
  const history = chatState.reconcileHistory({
    entries: input.entries,
    current: input.current,
    preserveCurrent: input.preserveCurrent,
    ...(input.steerMarks !== undefined ? { steerMarks: input.steerMarks } : {}),
  });
  return {
    history,
    todo: input.hasLiveTodo ? null : extractTodoPhases(input.entries),
  };
}
