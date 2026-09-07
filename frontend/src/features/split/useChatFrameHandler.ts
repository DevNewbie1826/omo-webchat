import type { Translate } from "../../i18n";
import type { ChatServerFrame, CommandEntry, ContextUsage, JsonObject, ResumeCandidate } from "../../lib/chatWs";
import type { ApprovalRequest } from "./ApprovalModal";
import type { HistoryStatus, MissingOriginal } from "./useChatFrameState";
import { applyActivityEvent, applyRunFlight, applyTodoToolDetails, validatedActivityEvent } from "./activityState";
import type { ActivityState } from "./activityTypes";
import { ingestExtensionEvent } from "../workspace/liveBadgeStore";
import { type UiMessage } from "./chatEntries";
import { forgetSteerMark, steerMarks } from "./chatSteerMarks";
import type { useConfirmedControls } from "./chatConfirmedControls";
import { reconcileFrameHistory } from "./chatFrameReconciliation";
import * as chatState from "./chatSessionState";
import type { ChatSendStore, ChatSendRequest } from "./chatSendState";
import type { QueueEngineSummary, QueueSlotItem, ToolEntry } from "./chatSessionTypes";
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
  readonly sends: ChatSendStore;
  readonly offerFailedDraft: (request: ChatSendRequest) => void;
  readonly cancelQueuedRecovery: (requestIds: ReadonlySet<string>) => void;
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
  readonly pushNotice: (kind: string, payload: JsonObject | null, at?: number, nid?: string) => void;
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

const OPEN_FAILED_PREFIX = "open_failed:";

function isOpenFailedDetail(message: string): boolean {
  if (!message.startsWith(OPEN_FAILED_PREFIX)) return false;
  return message.slice(OPEN_FAILED_PREFIX.length).trim() !== "";
}

function errorSurfaceMessage(
  frame: Extract<ChatServerFrame, { readonly type: "error" }>,
  t: Translate,
): string {
  if (frame.code !== "start_failed") return frame.message;
  if (isOpenFailedDetail(frame.message)) {
    return `${t("chat.startFailedHeading")}\n${frame.message}`;
  }
  return t("chat.startFailed");
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

export function createChatFrameHandler(bindings: ChatFrameHandlerBindings): (frame: ChatServerFrame, connectionGeneration?: number) => "refresh_stats" | void {
  const clearLiveSurfaces = (): void => {
    bindings.clearLiveSurfaces();
    bindings.applyActivities(applyRunFlight(bindings.activitiesRef.current, false));
  };
  const completeExternalRecovery = (): void => {
    if (!bindings.externalRecoveryPendingRef.current
      || !bindings.externalRecoveryReadyRef.current
      || !bindings.externalRecoveryHistoryRef.current) return;
    bindings.externalRecoveryPendingRef.current = false;
    bindings.setExternalWriteDetected(false);
  };
  const handleFrame = (frame: ChatServerFrame, connectionGeneration = 0): "refresh_stats" | void => {
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
        bindings.replaceMessages(chatState.applySteerMarks(
          [...bindings.messagesRef.current, frame.message], steerMarks(frame.sessionId),
        ));
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
        // Only marks attached to canonical occurrences survive a run boundary.
        // A no-message steer must not decorate an unrelated later same-text turn.
        const userCount = bindings.messagesRef.current.filter(message => message.role === "user").length;
        for (const mark of steerMarks(frame.sessionId)) {
          if (mark.ordinal > userCount) forgetSteerMark(frame.sessionId, mark.requestId);
        }
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
          if (frame.phase === "completed") bindings.sends.complete(frame.requestId);
          else bindings.sends.admit(frame.requestId);
        } else if (frame.requestId) {
          bindings.controls.ledger.commit(frame.requestId);
        }
        return;
      case "control.result":
        if (frame.success) {
          if (frame.requestId && bindings.controls.ledger.dropRestoreRequest(frame.requestId, frame.command) === "set_model") {
            return "refresh_stats";
          }
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
        // Ownership is looked up before replay handling or request-specific UI.
        // Another pane observes this same logical-chat store, never a global ledger.
        const receipt = frame.requestId ? bindings.sends.terminal(frame.requestId) : undefined;
        if (receipt && receipt !== "queued") return;
        const owned = frame.requestId ? bindings.sends.get(frame.requestId) : undefined;
        if (frame.requestId && (owned || receipt === "queued")) {
          const failed = bindings.sends.fail(frame.requestId);
          if (failed) {
            if (failed.kind === "steer") forgetSteerMark(frame.sessionId ?? "", failed.requestId);
            bindings.offerFailedDraft(failed);
          }
        } else if (frame.requestId && frame.command === "chat.send") {
          return;
        }
        if (frame.code === "external-write-detected") {
          const generation = bindings.claimHistoryGeneration(connectionGeneration, true);
          if (bindings.resyncGenerationRef.current !== null
            && bindings.resyncGenerationRef.current !== generation) return;
          // Rejection is not authoritative empty history. Drop only this
          // attempt's uncommitted pages, retaining the completed transcript
          // and pending input without running success reconciliation.
          bindings.externalRecoveryPendingRef.current = false;
          bindings.pageBuffer.reset();
          bindings.setHistoryStatus((current) => current === "loading" ? "failed" : current);
          bindings.endResync(generation, true);
          bindings.setExternalWriteDetected(true);
          bindings.setError("");
          return;
        }
        if (frame.code === "session_unloaded") {
          // A correlated operation has already settled above. It is not a
          // terminal for the current provider run (which may belong to B).
          if (frame.requestId) return;
          // Only a session-wide unload quietly clears all live surfaces.
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
          // This replay terminally failed: retire only its uncommitted pages
          // so a later same-socket query cannot commit the rejected prefix.
          // Reached only when no other resync owns the fence (checked above),
          // and the queue item is already retired by the terminal claim.
          bindings.pageBuffer.reset();
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
        bindings.sends.handoff(confirmed);
        bindings.cancelQueuedRecovery(confirmed);
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
        else if (!bindings.runningRef.current) return "refresh_stats";
        return;
      case "state":
        // ready precedes provider initialization; state proves get_state
        // completed and the reopened provider route is live.
        bindings.controls.absorbState(frame);
        if (frame.isStreaming && !bindings.runningRef.current) {
          bindings.setDoneReason(null);
          bindings.replaceToolCalls({});
        }
        if (!frame.isStreaming) {
          bindings.streaming.clear();
          bindings.setThinking("");
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
        const suffix = preserveCurrent
          ? messagesSinceSnapshot(bindings.messagesRef.current, bindings.snapshotMessagesRef.current)
          : [];
        const reconciliation = reconcileFrameHistory({
          entries,
          current: suffix,
          preserveCurrent,
          hasLiveTodo: bindings.activitiesRef.current.todo !== null,
          steerMarks: steerMarks(frame.sessionId),
        });
        bindings.replaceMessages(reconciliation.history.messages);
        // A committed snapshot is not another live receipt on a repeated terminal.
        bindings.snapshotMessagesRef.current = reconciliation.history.messages.filter(message => !suffix.includes(message));
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
