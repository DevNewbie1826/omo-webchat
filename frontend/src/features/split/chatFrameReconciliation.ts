import type { UiMessage } from "./chatEntries";
import { extractTodoPhases } from "./chatTodoHistory";
import * as chatState from "./chatSessionState";
import type { TodoPhase } from "./activityTypes";

interface ReconcileFrameHistoryInput {
  readonly entries: unknown;
  readonly current: readonly UiMessage[];
  readonly pending: readonly chatState.PendingOptimistic[];
  readonly active: chatState.PendingOptimistic | null;
  readonly uncertain: chatState.PendingOptimistic | null;
  readonly awaitingReconnectHistory: boolean;
  readonly preserveCurrent: boolean;
  readonly serverStreaming: boolean;
  readonly hasLiveTodo: boolean;
  /** Occurrence counts of this chat's accepted steer texts. */
  readonly steerMarks?: Readonly<Record<string, number>>;
}

interface ReconcileFrameHistoryResult {
  readonly history: chatState.ReconcileHistoryResult;
  readonly uncertain: chatState.PendingOptimistic | null;
  readonly outcome: chatState.ReconcileOutcome;
  readonly todo: readonly TodoPhase[] | null;
}

export function reconcileFrameHistory(input: ReconcileFrameHistoryInput): ReconcileFrameHistoryResult {
  const uncertain = input.awaitingReconnectHistory ? input.uncertain : null;
  const history = chatState.reconcileHistory({
    entries: input.entries,
    current: input.current,
    pending: input.pending,
    active: input.active,
    uncertain,
    preserveCurrent: input.preserveCurrent,
    serverStreaming: input.serverStreaming,
    ...(input.steerMarks !== undefined ? { steerMarks: input.steerMarks } : {}),
  });
  return {
    history,
    uncertain,
    outcome: chatState.reconcileOutcome(history, uncertain, input.serverStreaming),
    todo: input.hasLiveTodo ? null : extractTodoPhases(input.entries),
  };
}
