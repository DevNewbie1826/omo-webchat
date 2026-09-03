import type { ChatServerFrame, CommandEntry, ContextUsage, JsonObject, ResumeCandidate } from "../../lib/chatWs";
import type { ApprovalRequest } from "./ApprovalModal";
import type { HistoryStatus, MissingOriginal } from "./useChatFrameState";
import { applyActivityEvent, applyRunFlight, applyTodoToolDetails } from "./activityState";
import type { ActivityState } from "./activityTypes";
import { ingestExtensionEvent } from "../workspace/liveBadgeStore";
import type { UiMessage } from "./chatEntries";
import type { useConfirmedControls } from "./chatConfirmedControls";
import { isPromptTerminalError } from "./chatErrorState";
import { reconcileFrameHistory } from "./chatFrameReconciliation";
import * as chatState from "./chatSessionState";
import type { ChatDraft, ToolEntry } from "./chatSessionTypes";
import type { useEntriesPageBuffer } from "./useEntriesPageBuffer";
import type { useStreamingBuffer } from "./useStreamingBuffer";

type StateSetter<T> = (value: T | ((current: T) => T)) => void;
type Current<T> = { current: T };
type ModelsFrame = Extract<ChatServerFrame, { readonly type: "models" }>;

interface ChatFrameHandlerBindings {
  readonly controls: ReturnType<typeof useConfirmedControls>;
  readonly streaming: ReturnType<typeof useStreamingBuffer>;
  readonly pageBuffer: ReturnType<typeof useEntriesPageBuffer>;
  readonly messagesRef: Current<readonly UiMessage[]>;
  readonly runningRef: Current<boolean>;
  readonly submitLatchRef: Current<boolean>;
  readonly pendingRef: Current<chatState.PendingOptimistic[]>;
  readonly activeRunRef: Current<chatState.PendingOptimistic | null>;
  readonly uncertainRunRef: Current<chatState.PendingOptimistic | null>;
  readonly awaitingReconnectHistoryRef: Current<boolean>;
  readonly messageVersionRef: Current<number>;
  readonly snapshotVersionRef: Current<number>;
  readonly toolCallsRef: Current<Readonly<Record<string, ToolEntry>>>;
  readonly historyLoadedRef: Current<boolean>;
  readonly activitiesRef: Current<ActivityState>;
  readonly bufferActivityEvent: (name: string, data: unknown) => void;
  readonly retryVersionRef: Current<number>;
  readonly externalRecoveryPendingRef: Current<boolean>;
  readonly externalRecoveryReadyRef: Current<boolean>;
  readonly externalRecoveryHistoryRef: Current<boolean>;
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
  readonly setSessionUnloaded: StateSetter<boolean>;
  readonly setExternalWriteDetected: StateSetter<boolean>;
  readonly setContextUsage: StateSetter<ContextUsage | null>;
  readonly setCacheHitRate: StateSetter<number | null>;
  readonly setIsCompacting: StateSetter<boolean>;
  readonly setHistoryStatus: StateSetter<HistoryStatus>;
  readonly setCommands: StateSetter<readonly CommandEntry[]>;
  readonly setModels: StateSetter<ModelsFrame["models"]>;
  readonly setPendingApproval: StateSetter<ApprovalRequest | null>;
  readonly setRestoreVersion: StateSetter<number>;
  readonly setRetryDraft: StateSetter<(ChatDraft & { readonly version: number }) | null>;
  readonly pushNotice: (kind: string, payload: JsonObject | null, at?: number, nid?: string) => void;
}

/**
 * Error codes that prove the conversation history will never arrive. Three
 * groups: the open/create/resume sequence failing, the provider-termination
 * switch in internal/session/dispatch.go whose terminal kinds tear the session down,
 * and a failed get_entries response. Control rejections - set_model_failed,
 * set_thinking_failed, approval_failed, persist_failed - are absent by
 * design: treating those as history failure would re-expose the notice-only
 * transcript this gate exists to prevent.
 */
const HISTORY_TERMINAL_ERROR_CODES: ReadonlySet<string> = new Set([
  "resume_failed", "initialize_failed", "start_failed", "no_chat",
  "bad_create", "no_workspace", "bad_provider",
  "decode_failed", "incomplete_history", "adoption_required", "provider_overflow", "provider_timeout", "pi_eof",
]);

function isHistoryTerminalError(frame: Extract<ChatServerFrame, { readonly type: "error" }>): boolean {
  // A failed history command is terminal whatever request id the provider
  // tagged it with: the shared provider always stamps get_entries with a
  // "webchat-entries-N" id.
  if (frame.code === "provider_error") return frame.command === "get_entries";
  return frame.code !== undefined && HISTORY_TERMINAL_ERROR_CODES.has(frame.code);
}

function cacheHitRateOf(tokens: unknown): number | null {
  if (typeof tokens !== "object" || tokens === null || Array.isArray(tokens)) return null;
  const input = "input" in tokens ? tokens.input : undefined;
  const cacheRead = "cacheRead" in tokens ? tokens.cacheRead : undefined;
  if (typeof input !== "number" || typeof cacheRead !== "number") return null;
  const denominator = input + cacheRead;
  return denominator > 0 ? cacheRead / denominator : null;
}

export function createChatFrameHandler(bindings: ChatFrameHandlerBindings): (frame: ChatServerFrame) => void {
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
  const handleFrame = (frame: ChatServerFrame): void => {
    switch (frame.type) {
      case "ready":
        bindings.armHistoryStall(false);
        if (bindings.externalRecoveryPendingRef.current) {
          bindings.externalRecoveryReadyRef.current = true;
          completeExternalRecovery();
        }
        return;
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
        bindings.bufferActivityEvent(frame.name, frame.data);
        const next = applyActivityEvent(bindings.activitiesRef.current, frame.name, frame.data);
        if (next !== bindings.activitiesRef.current) bindings.applyActivities(next);
        return;
      }
      case "message": {
        if (frame.message.role === "toolResult") return;
        bindings.messageVersionRef.current += 1;
        if (frame.message.role === "user") {
          const reconciled = chatState.reconcileLiveUserMessage(
            frame.message,
            bindings.messagesRef.current,
            bindings.pendingRef.current,
            bindings.activeRunRef.current,
          );
          if (reconciled === null) return;
          if (reconciled) {
            bindings.replaceMessages(reconciled);
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
        clearLiveSurfaces();
        const next = chatState.finalizeRunMessages(bindings.messagesRef.current, finalized);
        if (next) {
          bindings.messageVersionRef.current += 1;
          bindings.replaceMessages(next);
        }
        return;
      }
      case "ack":
        if (frame.requestId) bindings.controls.ledger.commit(frame.requestId);
        return;
      case "control.result":
        if (frame.success) {
          if (frame.requestId) bindings.controls.ledger.dropRestoreRequest(frame.requestId);
          return;
        }
        if (frame.requestId && bindings.controls.ledger.reject(frame.requestId)) bindings.setError(frame.message ?? "");
        return;
      case "error": {
        // The engine unloaded this idle session and deleted it from its
        // registry; the engine process itself is still alive and the
        // conversation is durable on disk. Not terminal: surface the calm
        // resumable banner instead of the raw error, and stop any in-flight
        // run indicator so the pane does not look busy. Only the provider-backed
        // state frame of the next open sequence clears the state.
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
          });
          bindings.setExternalWriteDetected(true);
          bindings.setError("");
          return;
        }
        if (frame.code === "session_unloaded") {
          bindings.submitLatchRef.current = false;
          bindings.setDoneReason(null);
          clearLiveSurfaces();
          bindings.setSessionUnloaded(true);
          bindings.setError("");
          return;
        }
        if (isHistoryTerminalError(frame)) {
          bindings.externalRecoveryPendingRef.current = false;
          bindings.setHistoryStatus((current) => current === "loading" ? "failed" : current);
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
        if (frame.requestId && bindings.controls.ledger.reject(frame.requestId)) {
          bindings.setError(frame.message);
          return;
        }
        bindings.setError(frame.message);
        if (!isPromptTerminalError(frame)) return;
        const active = bindings.activeRunRef.current;
        bindings.submitLatchRef.current = false;
        clearLiveSurfaces();
        if (active) {
          bindings.messageVersionRef.current += 1;
          bindings.pendingRef.current = bindings.pendingRef.current.filter((pending) => pending.id !== active.id);
          bindings.replaceMessages(bindings.messagesRef.current.filter((message) => message.optimisticId !== active.id));
          bindings.setRetryDraft({ text: active.text, image: active.image, version: ++bindings.retryVersionRef.current });
        }
        return;
      }
      case "notice":
        bindings.pushNotice(frame.kind, frame.payload ?? null, frame.at, frame.nid);
        return;
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
        if (frame.error) bindings.setError(frame.error);
        return;
      case "state":
        // ready precedes provider initialization; state proves get_state
        // completed and the reopened provider route is live.
        bindings.setSessionUnloaded(false);
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
        if (frame.final === false) {
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
        const entries = bindings.pageBuffer.consume(frame.entries);
        const reconciliation = reconcileFrameHistory({
          entries,
          current: bindings.messagesRef.current,
          pending: bindings.pendingRef.current,
          active: bindings.activeRunRef.current,
          uncertain: bindings.uncertainRunRef.current,
          awaitingReconnectHistory: bindings.awaitingReconnectHistoryRef.current,
          preserveCurrent: bindings.messageVersionRef.current > bindings.snapshotVersionRef.current,
          serverStreaming: bindings.runningRef.current,
          hasLiveTodo: bindings.activitiesRef.current.todo !== null,
        });
        bindings.pendingRef.current = reconciliation.history.pending;
        if (reconciliation.uncertain) {
          bindings.uncertainRunRef.current = null;
          bindings.awaitingReconnectHistoryRef.current = false;
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
        bindings.replaceMessages(reconciliation.history.messages);
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
