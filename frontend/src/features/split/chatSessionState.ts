import type { AssistantMessage, ChatClientFrame, ChatServerFrame } from "../../lib/chatWs";
import type { ApprovalRequest } from "./ApprovalModal";
import type { UiMessage } from "./chatEntries";
import { messageText, parseEntries } from "./chatEntries";
import type { ChatDraft, ToolEntry } from "./chatSessionTypes";
import { materializeFinalTools } from "./chatFinalTools";

export interface PendingOptimistic extends ChatDraft {
  readonly id: number;
  readonly priorMatchingCount: number;
  /**
   * Whether authoritative history had loaded when this run was submitted.
   * When false the priorMatchingCount baseline is unknown: delayed history
   * may already contain an old identical turn, so text counts alone must never
   * complete or drop the run.
   */
  readonly baselineKnown: boolean;
  accepted: boolean;
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
  return pending.echo
    ? { ...pending.echo, optimisticId: pending.id }
    : {
        role: "user",
        blocks: [{ kind: "text", text: pending.text }],
        optimisticId: pending.id,
      };
}

export function steerMessage(text: string): UiMessage {
  return { role: "user", customType: "steer", blocks: [{ kind: "text", text }] };
}

export function followUpMessage(text: string): UiMessage {
  return { role: "user", customType: "followUp", blocks: [{ kind: "text", text }] };
}

export function finalizeRunMessages(
  messages: readonly UiMessage[],
  toolCalls: Readonly<Record<string, ToolEntry>>,
): readonly UiMessage[] | null {
  const withoutSteer = messages.filter((message) => message.customType !== "steer");
  const hasTools = Object.keys(toolCalls).length > 0;
  if (withoutSteer.length === messages.length && !hasTools) return null;
  return hasTools ? materializeFinalTools(withoutSteer, toolCalls) : withoutSteer;
}

/** Create the pending optimistic run, capturing the user-text baseline count. */
export function newPendingRun(
  draft: ChatDraft,
  text: string,
  id: number,
  baselineKnown: boolean,
  current: readonly UiMessage[],
): PendingOptimistic {
  return {
    ...draft,
    text,
    id,
    priorMatchingCount: current.filter((message) => message.role === "user" && messageText(message) === text).length,
    baselineKnown,
    accepted: false,
  };
}

/** Build the chat.send frame for a pending run. */
export function promptSendFrame(pending: PendingOptimistic, sessionId: string): ChatClientFrame {
  return {
    type: "chat.send",
    sessionId,
    run: {
      kind: "prompt",
      message: pending.text,
      ...(pending.image ? { images: [{ data: pending.image.data, mimeType: pending.image.mimeType }] } : {}),
    },
  };
}

export function steerSendFrame(text: string, sessionId: string): ChatClientFrame {
  return { type: "chat.send", sessionId, run: { kind: "steer", message: text } };
}

export function followUpSendFrame(draft: ChatDraft, text: string, sessionId: string): ChatClientFrame {
  return {
    type: "chat.send",
    sessionId,
    run: {
      kind: "follow_up",
      message: text,
      ...(draft.image ? { images: [{ data: draft.image.data, mimeType: draft.image.mimeType }] } : {}),
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
    return current.map((currentMessage) => (currentMessage.optimisticId === pending.id ? { ...message, optimisticId: pending.id } : currentMessage));
  }
  const followUpIndex = current.findIndex((currentMessage) =>
    currentMessage.customType === "followUp" && messageText(currentMessage) === text);
  if (followUpIndex >= 0) {
    return current.map((currentMessage, currentIndex) => currentIndex === followUpIndex ? message : currentMessage);
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

export function reconcileHistory({ entries, current, pending, active, uncertain, preserveCurrent, serverStreaming = false }: ReconcileHistoryInput): ReconcileHistoryResult {
  let restored = parseEntries(entries);
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

  const optimistic = unmatched.filter((item) => item.accepted).map(optimisticMessage);
  const snapshot = [...restored, ...optimistic];
  const currentWithoutMissing = uncertainMissing ? current.filter((message) => message.optimisticId !== uncertain?.id) : current;

  return {
    messages: preserveCurrent ? mergeSnapshot(snapshot, currentWithoutMissing) : snapshot,
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
