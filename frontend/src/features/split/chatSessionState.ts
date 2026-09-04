import type { AssistantMessage, ChatClientFrame, ChatServerFrame } from "../../lib/chatWs";
import type { ApprovalRequest } from "./ApprovalModal";
import type { UiMessage } from "./chatEntries";
import { messageText, parseEntries } from "./chatEntries";
import type { ChatDraft, ToolEntry } from "./chatSessionTypes";
import { materializeFinalTools } from "./chatFinalTools";
import type { SteerMark } from "./chatSteerMarks";

export interface PendingOptimistic extends ChatDraft {
  readonly id: number;
  readonly requestId: string;
  readonly kind: "prompt" | "followUp" | "steer";
  readonly priorMatchingCount: number;
  /**
   * Whether authoritative history had loaded when this run was submitted.
   * When false the priorMatchingCount baseline is unknown: delayed history
   * may already contain an old identical turn, so text counts alone must never
   * complete or drop the run.
   */
  readonly baselineKnown: boolean;
  accepted: boolean;
  admitted: boolean;
  echo?: UiMessage;
}

export function extractToolText(value?: { readonly content?: readonly { readonly text?: string }[] }): string {
  return value?.content?.map((item) => item.text ?? "").join("") ?? "";
}

type ToolFrame = Extract<ChatServerFrame, { readonly type: "tool" }>;
type ApprovalFrame = Extract<ChatServerFrame, { readonly type: "approval" }>;

/** Fold a live tool frame into the per-call tool entry map. */
export function nextToolEntry(
  current: Readonly<Record<string, ToolEntry>>,
  frame: ToolFrame,
): Readonly<Record<string, ToolEntry>> {
  const previous = current[frame.toolCallId];
  const text =
    frame.phase === "end" ? extractToolText(frame.result) || extractToolText(frame.partial) : extractToolText(frame.partial);
  const details = frame.phase === "end" ? frame.result?.details : frame.partial?.details;
  return {
    ...current,
    [frame.toolCallId]: {
      toolName: frame.toolName,
      phase: frame.phase,
      text: text || previous?.text || "",
      isError: frame.isError ?? previous?.isError ?? false,
      details: details !== undefined ? details : previous?.details,
      args: frame.args !== undefined ? frame.args : previous?.args,
    },
  };
}

/** Map a server approval frame onto the modal request, keeping defined fields only. */
export function approvalRequestOf(frame: ApprovalFrame): ApprovalRequest {
  return {
    id: frame.id,
    method: frame.method,
    ...(frame.title ? { title: frame.title } : {}),
    ...(frame.message ? { message: frame.message } : {}),
    ...(frame.options ? { options: frame.options } : {}),
    ...(frame.prefill ? { prefill: frame.prefill } : {}),
    ...(frame.placeholder ? { placeholder: frame.placeholder } : {}),
  };
}

export function uncertainRun(active: PendingOptimistic | null, pending: readonly PendingOptimistic[]): PendingOptimistic | null {
  // The active run stays uncertain on disconnect even after its server echo
  // removed it from the display-pending list (echo-before-assistant): the echo
  // proves the user entry exists, but without an assistant reply the run is
  // still unresolved and must be recovered on reconnect.
  if (!active) return null;
  return active.echo !== undefined || pending.some((item) => item.id === active.id) ? active : null;
}

interface ReconcileHistoryInput {
  readonly entries: unknown;
  readonly current: readonly UiMessage[];
  readonly pending: readonly PendingOptimistic[];
  readonly active: PendingOptimistic | null;
  readonly uncertain: PendingOptimistic | null;
  readonly preserveCurrent: boolean;
  /** Stable canonical user-message occurrences admitted as steers. */
  readonly steerMarks?: readonly SteerMark[];
  /**
   * Whether the server may still be streaming the uncertain run (last known
   * isStreaming). When false and the baseline is unknown, an identical turn
   * in delayed history is never accepted as the run's completion.
   */
  readonly serverStreaming?: boolean;
}

export interface ReconcileHistoryResult {
  readonly messages: readonly UiMessage[];
  readonly pending: PendingOptimistic[];
  readonly uncertainMissing: boolean;
  readonly uncertainStalled: boolean;
  readonly activeCompleted: boolean;
}

export function optimisticMessage(pending: PendingOptimistic): UiMessage {
  if (pending.echo) {
    return pending.kind === "followUp"
      ? pending.echo
      : { ...pending.echo, optimisticId: pending.id };
  }
  const message: UiMessage = {
    role: "user",
    ...(pending.kind === "followUp" ? { customType: "followUp" } : pending.kind === "steer" ? { customType: "steer" } : {}),
    blocks: [{ kind: "text", text: pending.text }],
  };
  // Follow-up identity is UI bookkeeping, not canonical message data. Keep it
  // directly readable for reconciliation/render keys without exposing it to
  // consumers that enumerate the wire-shaped marker.
  Object.defineProperty(message, "optimisticId", {
    value: pending.id,
    enumerable: pending.kind !== "followUp",
  });
  return message;
}

export function steerMessage(text: string): UiMessage {
  return { role: "user", customType: "steer", blocks: [{ kind: "text", text }] };
}

export function finalizeRunMessages(
  messages: readonly UiMessage[],
  toolCalls: Readonly<Record<string, ToolEntry>>,
): readonly UiMessage[] | null {
  // Steer-marked rows survive the run terminal. The mark is UI bookkeeping
  // the client owns: observed engine behavior persists the steer as a plain
  // user-role entry with no marker and never re-supplies a marked row, so
  // dropping the local echo here only erased the text. History
  // reconciliation re-tags the canonical plain flush instead (steerMarks).
  const hasTools = Object.keys(toolCalls).length > 0;
  if (!hasTools) return null;
  return materializeFinalTools(messages, toolCalls);
}

/** Create the pending optimistic run, capturing the user-text baseline count. */
export function newPendingRun(
  draft: ChatDraft,
  text: string,
  id: number,
  requestId: string,
  baselineKnown: boolean,
  current: readonly UiMessage[],
  kind: PendingOptimistic["kind"] = "prompt",
): PendingOptimistic {
  return {
    ...draft,
    text,
    id,
    requestId,
    kind,
    priorMatchingCount: current.filter((message) => message.role === "user" && messageText(message) === text).length,
    baselineKnown,
    accepted: false,
    admitted: false,
  };
}

/** Build the chat.send frame for a pending run. */
export function queuedSendFrame(
  draft: { readonly text: string; readonly image: PendingOptimistic["image"] },
  requestId: string,
  sessionId: string,
): ChatClientFrame {
  return {
    type: "chat.send",
    sessionId,
    requestId,
    run: {
      kind: "prompt",
      message: draft.text,
      ...(draft.image ? { images: [{ data: draft.image.data, mimeType: draft.image.mimeType }] } : {}),
    },
  };
}

export function promptSendFrame(pending: PendingOptimistic, sessionId: string): ChatClientFrame {
  return queuedSendFrame(pending, pending.requestId, sessionId);
}

export function steerSendFrame(pending: PendingOptimistic, sessionId: string): ChatClientFrame {
  return { type: "chat.send", sessionId, requestId: pending.requestId, run: { kind: "steer", message: pending.text } };
}

export function followUpSendFrame(pending: PendingOptimistic, sessionId: string): ChatClientFrame {
  return {
    type: "chat.send",
    sessionId,
    requestId: pending.requestId,
    run: {
      kind: "follow_up",
      message: pending.text,
      ...(pending.image ? { images: [{ data: pending.image.data, mimeType: pending.image.mimeType }] } : {}),
    },
  };
}

export function reconcileLiveUserMessage(
  message: AssistantMessage,
  current: readonly UiMessage[],
  pendingItems: PendingOptimistic[],
  active: PendingOptimistic | null,
): readonly UiMessage[] | null | undefined {
  const text = messageText(message);
  const index = pendingItems.findIndex((pending) => pending.text === text);
  if (index >= 0) {
    const pending = pendingItems[index];
    if (!pending) return undefined;
    pending.echo = message;
    if (!pending.accepted) {
      return null;
    }
    pendingItems.splice(index, 1);
    return current.map((currentMessage) => (currentMessage.optimisticId === pending.id
      ? pending.kind === "followUp" ? message : { ...message, optimisticId: pending.id }
      : currentMessage));
  }
  if (active?.text !== text || !current.some((currentMessage) => currentMessage.optimisticId === active.id)) {
    return undefined;
  }
  active.echo = message;
  return current.map((currentMessage) => (currentMessage.optimisticId === active.id ? { ...message, optimisticId: active.id } : currentMessage));
}

function messageKey(message: UiMessage): string {
  return JSON.stringify([
    message.role,
    (message.blocks ?? []).map((block) => [block.kind, block.text ?? "", block.thinking ?? "", block.id ?? "", block.name ?? "", block.arguments ?? null]),
  ]);
}

function mergeSnapshot(snapshot: readonly UiMessage[], current: readonly UiMessage[]): UiMessage[] {
  const available = new Map<string, number>();
  for (const message of snapshot) {
    const key = messageKey(message);
    available.set(key, (available.get(key) ?? 0) + 1);
  }

  const merged = [...snapshot];
  for (const message of current) {
    const key = messageKey(message);
    const remaining = available.get(key) ?? 0;
    if (remaining > 0) {
      available.set(key, remaining - 1);
    } else {
      merged.push(message);
    }
  }
  return merged;
}

export function reconcileHistory({ entries, current, pending, active, uncertain, preserveCurrent, serverStreaming = false, steerMarks }: ReconcileHistoryInput): ReconcileHistoryResult {
  let restored = parseEntries(entries);
  // Re-derive steer marks on the exact canonical user occurrences recorded at
  // admission. Text is only a consistency guard; it is never used to search
  // for another occurrence if history and the stored identity disagree.
  if (steerMarks !== undefined) {
    const marksByOrdinal = new Map(steerMarks.map((mark) => [mark.ordinal, mark]));
    let userOrdinal = 0;
    restored = restored.map((message) => {
      if (message.role !== "user") return message;
      userOrdinal += 1;
      const mark = marksByOrdinal.get(userOrdinal);
      if (mark === undefined || mark.text !== messageText(message)) return message;
      return { ...message, customType: "steer" };
    });
  }
  const counts = new Map<string, number>();
  for (const message of restored) {
    if (message.role !== "user") continue;
    const text = messageText(message);
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }

  // Missing is safe to decide by counts even on an unknown baseline: at most
  // the baseline count of occurrences means the run added no new user entry.
  // Completion, however, requires a trustworthy baseline (or a server echo):
  // delayed history may contain an old identical turn that must never pose as
  // the unsent run's completion. While the server may still be streaming the
  // run there is no authoritative idle point, so the stored turn is accepted.
  const baselineTrusted = uncertain === null || uncertain.baselineKnown || uncertain.echo !== undefined;
  const uncertainMissing = Boolean(uncertain && (counts.get(uncertain.text) ?? 0) <= uncertain.priorMatchingCount);
  const stalledTrusted = uncertain !== null && !uncertainMissing && baselineTrusted;
  const dropUncertain = uncertain !== null && (uncertainMissing || stalledTrusted);
  const retainedPending = pending.filter((item) => !dropUncertain || item.id !== uncertain?.id);

  // The run whose completion to verify against restored history. Normally the
  // active run; but when a reconnect resolves an uncertain run whose run.done
  // already fired (active is null), the uncertain run stands in — so a run
  // that actually completed (its reply is in the history) is not retried,
  // while a genuinely lost one (absent from history) still is.
  const completionRun = active ?? uncertain;
  // A run may only be reconciled against restored history when the server has
  // acknowledged it (an echo identity) or it is the uncertain run being
  // resolved across a reconnect (a post-baseline occurrence). Text counts
  // captured before history arrived are not enough: stale initial history may
  // already contain an identical older turn.
  const completionReconcilable =
    completionRun !== null && (completionRun.echo !== undefined || (uncertain !== null && uncertain.id === completionRun.id));
  const mayMatchCounts = completionReconcilable && (baselineTrusted || serverStreaming);

  let activeIndex = -1;
  if (completionRun && mayMatchCounts && (counts.get(completionRun.text) ?? 0) > completionRun.priorMatchingCount) {
    let matchingCount = 0;
    activeIndex = restored.findIndex((message) => {
      if (message.role !== "user" || messageText(message) !== completionRun.text) return false;
      matchingCount += 1;
      return matchingCount > completionRun.priorMatchingCount;
    });
    if (activeIndex >= 0) {
      restored = restored.map((message, messageIndex) => (messageIndex === activeIndex ? { ...message, optimisticId: completionRun.id } : message));
    }
  }
  const activeCompleted = activeIndex >= 0 && restored.slice(activeIndex + 1).some((message) => message.role === "assistant");
  const uncertainStalled = uncertain !== null && !uncertainMissing && !activeCompleted;

  const unmatched = retainedPending.filter((item) => {
    if (active !== null && item.id === active.id && !completionReconcilable) return true;
    // The tagged restored occurrence already represents this run; keeping the
    // optimistic duplicate would double the user row on echo replacement.
    if (active !== null && item.id === active.id && activeIndex >= 0) return false;
    // Unknown baseline: history counts cannot prove a match (an old identical
    // turn may inflate them), so the run stays pending until echoed or until
    // authoritative history with a known baseline arrives.
    if (!item.baselineKnown && item.echo === undefined) return true;
    return (counts.get(item.text) ?? 0) <= item.priorMatchingCount;
  });

  // Steers never materialize transcript rows: their pending feedback lives in
  // the status strip until the live echo arrives (tagged) or the run settles.
  const optimistic = unmatched.filter((item) => item.accepted && item.kind !== "steer").map(optimisticMessage);
  const snapshot = [...restored, ...optimistic];
  const unmatchedIds = new Set(unmatched.map((item) => item.id));
  const pendingIds = new Set(pending.map((item) => item.id));
  const currentWithoutSettled = current.filter((message) => {
    if (uncertainMissing && message.optimisticId === uncertain?.id) return false;
    return message.optimisticId === undefined
      || !pendingIds.has(message.optimisticId)
      || unmatchedIds.has(message.optimisticId);
  });

  return {
    messages: preserveCurrent ? mergeSnapshot(snapshot, currentWithoutSettled) : snapshot,
    pending: unmatched,
    uncertainMissing,
    uncertainStalled,
    activeCompleted,
  };
}

/**
 * Decide how a reconnect history reconciliation resolves the active run.
 * "missing"/"stalled" mean the uncertain run is lost and retryable; a stalled
 * uncertain run is only declared lost once the server confirms it is not
 * streaming. "completed" releases the run without retry.
 */
export type ReconcileOutcome = "missing" | "stalled" | "completed" | "active";

export function reconcileOutcome(
  result: ReconcileHistoryResult,
  uncertain: PendingOptimistic | null,
  serverStreaming: boolean,
): ReconcileOutcome {
  if (serverStreaming) return "active";
  if (uncertain && result.uncertainMissing) return "missing";
  if (uncertain && result.uncertainStalled) return "stalled";
  if (result.activeCompleted) return "completed";
  return "active";
}
