import type { UiMessage } from "./chatEntries";
import * as chatState from "./chatSessionState";
import type { SteerMark } from "./chatSteerMarks";

interface ReconcileFrameHistoryInput {
  readonly entries: unknown;
  readonly current: readonly UiMessage[];
  readonly preserveCurrent: boolean;
  /** Stable canonical user-message occurrences admitted as steers. */
  readonly steerMarks?: readonly SteerMark[];
}

interface ReconcileFrameHistoryResult {
  readonly history: ReturnType<typeof chatState.reconcileHistory>;
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
  };
}
