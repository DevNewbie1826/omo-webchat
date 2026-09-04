import type { Translate } from "../../i18n";
import type { ChatServerFrame, CommandEntry, ContextUsage, JsonObject, ResumeCandidate } from "../../lib/chatWs";
import type { ApprovalRequest } from "./ApprovalModal";
import type { HistoryStatus, MissingOriginal } from "./useChatFrameState";
import { applyActivityEvent, applyRunFlight, applyTodoToolDetails, validatedActivityEvent } from "./activityState";
import type { ActivityState } from "./activityTypes";
import { ingestExtensionEvent } from "../workspace/liveBadgeStore";
import { messageText, type UiMessage } from "./chatEntries";
import { forgetSteerMark, steerMarkCounts } from "./chatSteerMarks";
import type { useConfirmedControls } from "./chatConfirmedControls";
import { isPromptTerminalError } from "./chatErrorState";
import { reconcileFrameHistory } from "./chatFrameReconciliation";
import * as chatState from "./chatSessionState";
import type { QueueEngineSummary, QueuePlaceholder, QueueSlotItem, SteerPendingItem, ToolEntry } from "./chatSessionTypes";
import type { useEntriesPageBuffer } from "./useEntriesPageBuffer";
import type { useStreamingBuffer } from "./useStreamingBuffer";

type StateSetter<T> = (value: T | ((current: T) => T)) => void;
type Current<T> = { current: T };
type ModelsFrame = Extract<ChatServerFrame, { readonly type: "models" }>;

interface ChatFrameHandlerBindings {
  readonly t: Translate;
  readonly controls: ReturnType<typeof useConfirmedControls>;
  readonly streaming: ReturnType<typeof useStreamingBuffer>;
  readonly pageBuffer: ReturnType<typeof useEntriesPageBuffer>;
  readonly messagesRef: Current<readonly UiMessage[]>;
  readonly runningRef: Current<boolean>;
  readonly submitLatchRef: Current<boolean>;
  readonly pendingRef: Current<chatState.PendingOptimistic[]>;
  readonly ownedSendRequestIdsRef: Current<Set<string>>;
  readonly retiredSteerIdsRef: Current<Set<number>>;
  readonly activeRunRef: Current<chatState.PendingOptimistic | null>;
  readonly uncertainRunRef: Current<chatState.PendingOptimistic | null>;
  readonly awaitingReconnectHistoryRef: Current<boolean>;
  readonly messageVersionRef: Current<number>;
  readonly snapshotVersionRef: Current<number>;
  readonly snapshotMessagesRef: Current<readonly UiMessage[]>;
  readonly resyncGenerationRef: Current<number | null>;
  readonly claimReadyGeneration: (connectionGeneration: number) => number;
  readonly claimHistoryGeneration: (connectionGeneration: number, terminal: boolean) => number;
  readonly toolCallsRef: Current<Readonly<Record<string, ToolEntry>>>;
  readonly historyLoadedRef: Current<boolean>;
  readonly activitiesRef: Current<ActivityState>;
  readonly bufferActivityEvent: (event: NonNullable<ReturnType<typeof validatedActivityEvent>>) => void;
  readonly externalRecoveryPendingRef: Current<boolean>;
  readonly externalRecoveryReadyRef: Current<boolean>;
  readonly externalRecoveryHistoryRef: Current<boolean>;
  readonly endResync: (generation: number, terminal?: boolean) => void;
  readonly replaceMessages: (next: readonly UiMessage[]) => void;
  readonly replaceToolCalls: (next: Readonly<Record<string, ToolEntry>>) => void;
  readonly applyActivities: (next: ActivityState) => void;
  readonly clearLiveSurfaces: () => void;
  readonly recoverLostRun: (run: chatState.PendingOptimistic) => void;
  readonly armHistoryStall: (refresh: boolean) => void;
  readonly setThinking: StateSetter<string>;
  readonly setRunning: StateSetter<boolean>;
  readonly setDoneReason: StateSetter<string | null>;
  readonly setError: StateSetter<string>;
  readonly setMissingOriginal: StateSetter<MissingOriginal | null>;
  readonly setExternalWriteDetected: StateSetter<boolean>;
  readonly setContextUsage: StateSetter<ContextUsage | null>;
  readonly setCacheHitRate: StateSetter<number | null>;
  readonly setIsCompacting: StateSetter<boolean>;
  readonly setHistoryStatus: StateSetter<HistoryStatus>;
  readonly setCommands: StateSetter<readonly CommandEntry[]>;
  readonly setModels: StateSetter<ModelsFrame["models"]>;
  readonly setPendingApproval: StateSetter<ApprovalRequest | null>;
  readonly setRestoreVersion: StateSetter<number>;
  readonly setSendError: StateSetter<JsonObject | null>;
  readonly consumeOutcome: (requestId: string) => boolean;
  readonly notifyPendingChanged: () => void;
  readonly retainFailedDrafts: (runs: readonly chatState.PendingOptimistic[]) => void;
  readonly pushNotice: (kind: string, payload: JsonObject | null, at?: number, nid?: string) => void;
  readonly steerPendingRef: Current<readonly SteerPendingItem[]>;
  readonly replaceSteerPending: (next: readonly SteerPendingItem[]) => void;
  readonly queuePlaceholdersRef: Current<readonly QueuePlaceholder[]>;
  readonly replaceQueuePlaceholders: (next: readonly QueuePlaceholder[]) => void;
  readonly setQueueItems: StateSetter<readonly QueueSlotItem[]>;
  readonly setQueueEngine: StateSetter<QueueEngineSummary>;
}

/**
 * Error-frame codes that make unavailable conversation history visible as a
 * failed load. Other error codes leave the existing transcript visible.
 */
const CREATE_TERMINAL_ERROR_CODES: readonly string[] = [
  "no_chat", "unsupported_provider", "adoption_required", "bad_create", "start_failed", "session-active",
];

const HISTORY_TERMINAL_ERROR_CODES: ReadonlySet<string> = new Set([
  "resume_failed", "initialize_failed", ...CREATE_TERMINAL_ERROR_CODES,
  "no_workspace", "bad_provider", "decode_failed", "incomplete_history",
  "provider_overflow", "provider_timeout", "pi_eof",
]);

function isHistoryTerminalError(frame: Extract<ChatServerFrame, { readonly type: "error" }>): boolean {
  // A provider_error frame marks history failed only when its command field
  // identifies the history request.
  if (frame.code === "provider_error") return frame.command === "get_entries";
  return frame.code !== undefined && HISTORY_TERMINAL_ERROR_CODES.has(frame.code);
}

// Error frames matching these observed command or code values use the
// persistent send-error banner; all other errors use the transient surface.
const SEND_ERROR_COMMANDS: ReadonlySet<string> = new Set([
  "chat.send", "chat.compact", "chat.abort",
  "prompt", "steer", "follow_up", "compact", "abort",
]);
const SEND_ERROR_CODES: ReadonlySet<string> = new Set([
  "prompt_in_flight", "compaction_in_flight", "bad_send", "send_failed", "compact_failed", "send_backpressure",
]);

// Without a matching requestId, these codes do not remove an optimistic
// message or restore its draft.
const UNCORRELATED_OPERATION_ERROR_CODES: ReadonlySet<string> = new Set(["bad_send", "send_failed"]);

// Backend error frames carry a stable English fallback. Codes in this map
// show localized copy on the transient error surface instead.
const LOCALIZED_ERROR_KEYS: Readonly<Record<string, string>> = {
  start_failed: "chat.startFailed",
};

function errorSurfaceMessage(
  frame: Extract<ChatServerFrame, { readonly type: "error" }>,
  t: Translate,
): string {
  const key = frame.code !== undefined ? LOCALIZED_ERROR_KEYS[frame.code] : undefined;
  return key !== undefined ? t(key) : frame.message;
}

/**
 * Select error frames that appear in the persistent, manually dismissed
 * banner. Other error frames appear in the transient error surface.
 */
export function sendCommandFailureOf(frame: Extract<ChatServerFrame, { readonly type: "error" }>): JsonObject | null {
  if (frame.code !== undefined && SEND_ERROR_CODES.has(frame.code)) return { message: frame.message };
  if (frame.code === "provider_error"
    && frame.command !== undefined
    && SEND_ERROR_COMMANDS.has(frame.command)) return { message: frame.message };
  return null;
}

/** The raw failure text of a send-error banner payload. */
export function sendErrorDetail(payload: JsonObject | null): string {
  const message = payload?.["message"];
  return typeof message === "string" ? message : "";
}

export function retirePendingSteers(
  pending: readonly chatState.PendingOptimistic[],
  retiredSteerIds: Set<number>,
): void {
  for (const operation of pending) {
    if (operation.kind === "steer") retiredSteerIds.add(operation.id);
  }
}

export function settleCompletedSendPending(
  pending: chatState.PendingOptimistic[],
  requestId: string,
  retiredSteerIds: Set<number>,
): chatState.PendingOptimistic[] {
  const operation = pending.find((candidate) => candidate.requestId === requestId);
  if (operation?.kind !== "steer") return pending;
  retiredSteerIds.delete(operation.id);
  return pending.filter((candidate) => candidate.id !== operation.id);
}

function cacheHitRateOf(tokens: unknown): number | null {
  if (typeof tokens !== "object" || tokens === null || Array.isArray(tokens)) return null;
  const input = "input" in tokens ? tokens.input : undefined;
  const cacheRead = "cacheRead" in tokens ? tokens.cacheRead : undefined;
  if (typeof input !== "number" || typeof cacheRead !== "number") return null;
  const denominator = input + cacheRead;
  return denominator > 0 ? cacheRead / denominator : null;
}

function messagesSinceSnapshot(
  current: readonly UiMessage[],
  snapshot: readonly UiMessage[],
): readonly UiMessage[] {
  const baseline = new Map<UiMessage, number>();
  for (const message of snapshot) baseline.set(message, (baseline.get(message) ?? 0) + 1);
  return current.filter((message) => {
    const remaining = baseline.get(message) ?? 0;
    if (remaining === 0) return true;
    baseline.set(message, remaining - 1);
    return false;
  });
}

export function createChatFrameHandler(bindings: ChatFrameHandlerBindings): (frame: ChatServerFrame, connectionGeneration?: number) => void {
  const clearLiveSurfaces = (): void => {
    bindings.clearLiveSurfaces();
    bindings.applyActivities(applyRunFlight(bindings.activitiesRef.current, false));
  };
  const settleFailedPending = (pending: chatState.PendingOptimistic, sessionId: string): void => {
    bindings.ownedSendRequestIdsRef.current.delete(pending.requestId);
    bindings.messageVersionRef.current += 1;
    bindings.pendingRef.current = bindings.pendingRef.current.filter((operation) => operation.id !== pending.id);
    bindings.retiredSteerIdsRef.current.delete(pending.id);
    if (pending.kind === "steer") {
      // A rejected steer never persisted engine-side: drop its occurrence so
      // the mark store cannot mis-tag a later identical prompt entry.
      forgetSteerMark(sessionId, pending.text);
      bindings.replaceSteerPending(bindings.steerPendingRef.current.filter((item) => item.requestId !== pending.requestId));
    }
    bindings.replaceMessages(bindings.messagesRef.current.filter((message) => message.optimisticId !== pending.id));
    bindings.retainFailedDrafts([pending]);
    if (pending.kind === "prompt" && bindings.activeRunRef.current?.id === pending.id) {
      bindings.submitLatchRef.current = false;
      clearLiveSurfaces();
    }
  };
  const completeExternalRecovery = (): void => {
    if (!bindings.externalRecoveryPendingRef.current
      || !bindings.externalRecoveryReadyRef.current
      || !bindings.externalRecoveryHistoryRef.current) return;
    bindings.externalRecoveryPendingRef.current = false;
    bindings.setExternalWriteDetected(false);
  };
  const handleFrame = (frame: ChatServerFrame, connectionGeneration = 0): void => {
    switch (frame.type) {
      case "ready": {
        const generation = bindings.claimReadyGeneration(connectionGeneration);
        if (bindings.externalRecoveryPendingRef.current) {
          bindings.externalRecoveryReadyRef.current = true;
        }
        if (!frame.resumed && frame.piSessionId !== null) {
          // A fresh provider route has no entries stream. Route an authoritative
          // empty terminal through normal reconciliation so this generation
          // closes and cannot consume a later replay's terminal frame. A null
          // provider identity is not proof that initialization finished.
          handleFrame({
            type: "entries",
            sessionId: frame.sessionId,
            entries: [],
            final: true,
          }, connectionGeneration);
          return;
        }
        bindings.armHistoryStall(false);
        completeExternalRecovery();
        // A manual re-sync ends at ready only for the binding created by that
        // action. Older attach/reconnect acknowledgements cannot release it.
        bindings.endResync(generation);
        return;
      }
      case "messageDelta":
        if (frame.delta.kind === "text_delta" && frame.delta.delta) {
          bindings.setError("");
          bindings.streaming.push(frame.delta.delta);
        } else if (frame.delta.kind === "thinking_delta" && frame.delta.delta) {
          bindings.setThinking((value) => value + frame.delta.delta);
        }
        return;
      case "tool": {
        bindings.setError("");
        bindings.replaceToolCalls(chatState.nextToolEntry(bindings.toolCallsRef.current, frame));
        if (frame.toolName === "todo") {
          const details = frame.phase === "end" ? frame.result?.details : frame.partial?.details;
          if (details !== undefined) {
            const next = applyTodoToolDetails(bindings.activitiesRef.current, details);
            if (next !== bindings.activitiesRef.current) bindings.applyActivities(next);
          }
        }
        return;
      }
      case "extensionEvent": {
        ingestExtensionEvent(frame.sessionId, frame.name, frame.data);
        const activityEvent = validatedActivityEvent(frame.name, frame.data);
        const before = bindings.activitiesRef.current;
        const next = applyActivityEvent(before, frame.name, frame.data);
        if (next !== before) bindings.applyActivities(next);
        if (activityEvent !== null) {
          // Record which domains the reducer actually mutated so hydration
          // overflow fencing reflects real changes, not mere event presence.
          // Compare the domain maps directly: a dag.activity without a
          // usable taskId changes only dags, and a heartbeat changes neither.
          bindings.bufferActivityEvent({
            ...activityEvent,
            mutatedTask: next.tasks !== before.tasks,
            mutatedDag: next.dags !== before.dags,
          });
        }
        return;
      }
      case "message": {
        if (frame.message.role === "toolResult") return;
        bindings.messageVersionRef.current += 1;
        if (frame.message.role === "user") {
          const echoText = messageText(frame.message);
          const pendingMatch = bindings.pendingRef.current.find((pending) => pending.text === echoText);
          // The steer summary clears the moment its echo renders; the appended
          // echo carries the steer mark so the transcript keeps showing it
          // until the run settles (finalizeRunMessages strips it then).
          const steerSummaryIndex = bindings.steerPendingRef.current.findIndex((item) => item.text === echoText);
          const reconciled = chatState.reconcileLiveUserMessage(
            frame.message,
            bindings.messagesRef.current,
            bindings.pendingRef.current,
            bindings.activeRunRef.current,
          );
          if (reconciled === null) return;
          if (reconciled) {
            const markerWasRetired = pendingMatch?.kind === "steer"
              && bindings.retiredSteerIdsRef.current.delete(pendingMatch.id);
            if (!markerWasRetired && pendingMatch?.kind === "steer") {
              bindings.replaceMessages([...reconciled, { ...frame.message, customType: "steer" }]);
            } else {
              bindings.replaceMessages(markerWasRetired ? [...reconciled, frame.message] : reconciled);
            }
            if (steerSummaryIndex >= 0) {
              bindings.replaceSteerPending(bindings.steerPendingRef.current.filter((_, index) => index !== steerSummaryIndex));
            }
            return;
          }
          if (steerSummaryIndex >= 0) {
            bindings.replaceSteerPending(bindings.steerPendingRef.current.filter((_, index) => index !== steerSummaryIndex));
            bindings.replaceMessages([...bindings.messagesRef.current, { ...frame.message, customType: "steer" }]);
            bindings.streaming.clear();
            bindings.setThinking("");
            return;
          }
        }
        bindings.replaceMessages([...bindings.messagesRef.current, frame.message]);
        bindings.streaming.clear();
        bindings.setThinking("");
        return;
      }
      case "run.started":
        bindings.runningRef.current = true;
        bindings.setRunning(true);
        bindings.setError("");
        bindings.setDoneReason(null);
        bindings.replaceToolCalls({});
        // The shelf judges staleness only while a run is in flight.
        bindings.applyActivities(applyRunFlight(bindings.activitiesRef.current, true));
        return;
      case "run.done": {
        bindings.setDoneReason(frame.reason);
        const finalized = bindings.toolCallsRef.current;
        // The run terminal retires the transient steer transcript marker via
        // finalizeRunMessages below, and drops every steer summary: without an
        // echo (or after one) there is nothing left to wait for.
        bindings.replaceSteerPending([]);
        retirePendingSteers(bindings.pendingRef.current, bindings.retiredSteerIdsRef.current);
        clearLiveSurfaces();
        const next = chatState.finalizeRunMessages(bindings.messagesRef.current, finalized);
        if (next) {
          bindings.messageVersionRef.current += 1;
          bindings.replaceMessages(next);
        }
        return;
      }
      case "ack":
        if (frame.command === "chat.send" && frame.requestId) {
          if (frame.phase !== "completed") {
            const pending = bindings.pendingRef.current.find((operation) => operation.requestId === frame.requestId);
            if (pending) pending.admitted = true;
            return;
          }
          // Completion belongs only to the pane that originated this send.
          // Once consumed, replayed terminal acks have no local state to touch.
          if (!bindings.ownedSendRequestIdsRef.current.has(frame.requestId)
            || !bindings.consumeOutcome(frame.requestId)) return;
          bindings.ownedSendRequestIdsRef.current.delete(frame.requestId);
          // Completion is stronger than admission. Preserve an unechoed
          // follow-up for canonical reconciliation, but never recover it as an
          // unsent operation if an attach replay omitted the admission ack.
          const pending = bindings.pendingRef.current;
          const completed = pending.find((operation) => operation.requestId === frame.requestId);
          if (completed) completed.admitted = true;
          // Settle a steer and its exact optimistic marker in the same frame.
          // run.done may not have arrived (or may have been missed), so retiring
          // only the correlation would leave a duplicate/permanent marker.
          const settled = settleCompletedSendPending(pending, frame.requestId, bindings.retiredSteerIdsRef.current);
          if (settled !== pending) {
            bindings.pendingRef.current = settled;
            bindings.replaceMessages(bindings.messagesRef.current.filter((message) => message.optimisticId !== completed?.id));
            bindings.notifyPendingChanged();
          }
        } else if (frame.requestId) {
          bindings.controls.ledger.commit(frame.requestId);
        }
        return;
      case "control.result":
        if (frame.success) {
          if (frame.requestId) bindings.controls.ledger.dropRestoreRequest(frame.requestId);
          return;
        }
        if (frame.requestId && bindings.controls.ledger.reject(frame.requestId)) bindings.setError(frame.message ?? "");
        return;
      case "error": {
        // Local control ids restart when a pane is replaced, so settle an owned
        // control before consulting the process-wide send replay registry.
        if (frame.requestId && bindings.controls.ledger.reject(frame.requestId)) {
          bindings.setError(frame.message);
          return;
        }
        // Only chat.send terminal outcomes are ledger-backed across attaches.
        // Claim those before banner or settlement side effects so replay cannot
        // resurrect a dismissed failure.
        if (frame.requestId && frame.command === "chat.send"
          && !bindings.consumeOutcome(frame.requestId)) return;
        // Settle an owned send before any specialized presentation branch can
        // return. Resume and external-write failures still choose their own UI,
        // but the optimistic prompt is already rolled back and recoverable.
        const correlatedPending = frame.requestId
          ? bindings.pendingRef.current.find((operation) => operation.requestId === frame.requestId)
            ?? (bindings.activeRunRef.current?.requestId === frame.requestId ? bindings.activeRunRef.current : undefined)
          : undefined;
        if (correlatedPending) settleFailedPending(correlatedPending, frame.sessionId ?? "");
        // A rejected queued send was never enqueued: retire its placeholder so
        // the panel cannot keep showing a ghost item.
        if (frame.requestId) {
          const remainingPlaceholders = bindings.queuePlaceholdersRef.current
            .filter((placeholder) => placeholder.requestId !== frame.requestId);
          if (remainingPlaceholders.length !== bindings.queuePlaceholdersRef.current.length) {
            bindings.replaceQueuePlaceholders(remainingPlaceholders);
          }
        }
        // A session_unloaded error remains hidden and leaves the pane ready
        // for another prompt. It clears the submission latch, completion
        // reason, running state, active response, streamed text, thinking,
        // tools, activity flight, compaction, and pending approval.
        if (frame.code === "external-write-detected") {
          // Cold rehydration pages deliberately remain non-final because the
          // live tail could not be trusted. The drift error is their terminal
          // marker: consume the snapshot before surfacing persistent recovery.
          bindings.externalRecoveryPendingRef.current = false;
          handleFrame({
            type: "entries",
            sessionId: frame.sessionId ?? "",
            entries: [],
            final: true,
          }, connectionGeneration);
          bindings.setExternalWriteDetected(true);
          bindings.setError("");
          return;
        }
        if (frame.code === "session_unloaded") {
          bindings.submitLatchRef.current = false;
          bindings.setDoneReason(null);
          clearLiveSurfaces();
          bindings.setIsCompacting(false);
          bindings.setPendingApproval(null);
          bindings.setError("");
          return;
        }
        if (isHistoryTerminalError(frame)) {
          const generation = bindings.claimHistoryGeneration(connectionGeneration, true);
          if (bindings.resyncGenerationRef.current !== null
            && bindings.resyncGenerationRef.current !== generation) return;
          bindings.externalRecoveryPendingRef.current = false;
          bindings.setHistoryStatus((current) => current === "loading" ? "failed" : current);
          bindings.endResync(generation, true);
        }
        // A dangling stored identity surfaces its branch candidates instead
        // of the raw failure. The state is never cleared by live frames.
        if (frame.code === "resume_failed" && frame.dangling === true) {
          const candidates: readonly ResumeCandidate[] = frame.candidates ?? [];
          bindings.setMissingOriginal({ candidates });
          bindings.setError("");
          return;
        }
        if (frame.code === "decode_failed" || frame.code === "incomplete_history" || frame.code === "adoption_required") bindings.pageBuffer.reset();
        // Send-path command failures persist in a dedicated banner slot instead
        // of the transient error surface or capped transcript notices.
        const sendFailure = sendCommandFailureOf(frame);
        if (sendFailure === null) bindings.setError(errorSurfaceMessage(frame, bindings.t));
        else bindings.setSendError(sendFailure);

        // Error frames without requestId may restore the active draft only
        // for prompt-terminal fields; unrelated request ids leave it visible.
        const pending = !frame.requestId && (frame.command === "prompt"
          || (isPromptTerminalError(frame) && !UNCORRELATED_OPERATION_ERROR_CODES.has(frame.code ?? "")))
            ? bindings.activeRunRef.current ?? undefined
            : undefined;
        if (pending) settleFailedPending(pending, frame.sessionId ?? "");
        return;
      }
      case "notice":
        bindings.pushNotice(frame.kind, frame.payload ?? null, frame.at, frame.nid);
        return;
      case "queue": {
        // Authoritative snapshot: on attach right after ready and on every
        // change. Placeholders whose requestId the server confirmed graduate
        // into listed items; the rest keep waiting for their frame.
        bindings.setQueueItems(frame.items);
        bindings.setQueueEngine(frame.engine);
        const confirmed = new Set(
          frame.items.map((item) => item.requestId).filter((requestId): requestId is string => requestId !== undefined),
        );
        const remaining = bindings.queuePlaceholdersRef.current.filter((placeholder) => !confirmed.has(placeholder.requestId));
        if (remaining.length !== bindings.queuePlaceholdersRef.current.length) {
          bindings.replaceQueuePlaceholders(remaining);
        }
        return;
      }
      case "approval":
        bindings.setPendingApproval(chatState.approvalRequestOf(frame));
        return;
      case "commands":
        bindings.setCommands(frame.commands);
        return;
      case "compaction.started":
        bindings.setIsCompacting(true);
        bindings.setError("");
        return;
      case "compaction.done":
        bindings.setIsCompacting(false);
        if (frame.error) bindings.setSendError({ message: frame.error });
        return;
      case "state":
        // ready precedes provider initialization; state proves get_state
        // completed and the reopened provider route is live.
        bindings.controls.absorbState(frame);
        if (frame.isStreaming && !bindings.runningRef.current) {
          bindings.setDoneReason(null);
          bindings.replaceToolCalls({});
        }
        bindings.runningRef.current = frame.isStreaming;
        bindings.setRunning(frame.isStreaming);
        bindings.applyActivities(applyRunFlight(bindings.activitiesRef.current, frame.isStreaming));
        bindings.setIsCompacting(frame.isCompacting);
        return;
      case "stats":
        if (frame.contextUsage) bindings.setContextUsage(frame.contextUsage);
        bindings.setCacheHitRate(cacheHitRateOf(frame.tokens));
        return;
      case "models":
        bindings.setModels(frame.models);
        return;
      case "entries": {
        const terminal = frame.final !== false;
        const generation = bindings.claimHistoryGeneration(connectionGeneration, terminal);
        if (bindings.resyncGenerationRef.current !== null
          && bindings.resyncGenerationRef.current !== generation) return;
        if (!terminal) {
          bindings.pageBuffer.push(frame.entries);
          bindings.armHistoryStall(true);
          return;
        }
        bindings.historyLoadedRef.current = true;
        bindings.setHistoryStatus("loaded");
        if (bindings.externalRecoveryPendingRef.current) {
          bindings.externalRecoveryHistoryRef.current = true;
          completeExternalRecovery();
        }
        // Fallback for the re-sync busy marker: ready normally ends it, but
        // the matching terminal page also proves the replay landed and closes
        // its page-buffer fence.
        bindings.endResync(generation, true);
        const entries = bindings.pageBuffer.consume(frame.entries);
        const preserveCurrent = bindings.messageVersionRef.current > bindings.snapshotVersionRef.current;
        const reconciliation = reconcileFrameHistory({
          entries,
          current: preserveCurrent
            ? messagesSinceSnapshot(bindings.messagesRef.current, bindings.snapshotMessagesRef.current)
            : bindings.messagesRef.current,
          pending: bindings.pendingRef.current,
          active: bindings.activeRunRef.current,
          uncertain: bindings.uncertainRunRef.current,
          awaitingReconnectHistory: bindings.awaitingReconnectHistoryRef.current,
          preserveCurrent,
          serverStreaming: bindings.runningRef.current,
          hasLiveTodo: bindings.activitiesRef.current.todo !== null,
          steerMarks: steerMarkCounts(frame.sessionId),
        });
        const unacknowledgedFollowUps = bindings.awaitingReconnectHistoryRef.current && !bindings.runningRef.current
          ? reconciliation.history.pending.filter((pending) => pending.kind === "followUp" && !pending.admitted)
          : [];
        const recoveredIds = new Set(unacknowledgedFollowUps.map((pending) => pending.id));
        bindings.pendingRef.current = reconciliation.history.pending.filter((pending) => !recoveredIds.has(pending.id));
        if (unacknowledgedFollowUps.length > 0) bindings.retainFailedDrafts(unacknowledgedFollowUps);
        if (bindings.awaitingReconnectHistoryRef.current) {
          bindings.awaitingReconnectHistoryRef.current = false;
          if (reconciliation.uncertain) bindings.uncertainRunRef.current = null;
        }
        if ((reconciliation.outcome === "missing" || reconciliation.outcome === "stalled") && reconciliation.uncertain) {
          bindings.recoverLostRun(reconciliation.uncertain);
          bindings.applyActivities(applyRunFlight(bindings.activitiesRef.current, false));
        } else if (reconciliation.outcome === "completed") {
          bindings.submitLatchRef.current = false;
          clearLiveSurfaces();
        }
        if (reconciliation.outcome === "completed") {
          bindings.runningRef.current = false;
          bindings.setDoneReason("stop");
        }
        bindings.replaceMessages(reconciliation.history.messages.filter((message) =>
          message.optimisticId === undefined
          || (!recoveredIds.has(message.optimisticId)
            && !bindings.retiredSteerIdsRef.current.has(message.optimisticId))));
        bindings.setRestoreVersion((version) => version + 1);
        if (reconciliation.todo !== null) {
          bindings.applyActivities({ ...bindings.activitiesRef.current, todo: reconciliation.todo });
        }
        return;
      }
      default:
        return;
    }
  };
  return handleFrame;
}
