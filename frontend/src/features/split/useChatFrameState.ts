import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import type { ChatClient, ChatServerFrame, CommandEntry, ContextUsage, JsonObject, ResumeCandidate } from "../../lib/chatWs";
import type { ApprovalRequest } from "./ApprovalModal";
import { useConfirmedControls } from "./chatConfirmedControls";
import { type UiMessage } from "./chatEntries";
import {
  applyActivityEvent,
  applyTaskHistorySnapshot,
  applyDagHistorySnapshot,
  bufferActivityHydrationEvent,
  createActivityHydrationBuffer,
  emptyActivityState,
  type ActivityHydrationBuffer,
  type BufferedActivityEvent,
} from "./activityState";
import { parseTaskDigest } from "../workspace/activityDigest";
import type { ActivityState } from "./activityTypes";
import { emptyTodoAuthority, unbindTodoAuthority } from "./todoAuthority";
import { useEntriesPageBuffer } from "./useEntriesPageBuffer";
import { useStreamingBuffer } from "./useStreamingBuffer";
import { recordSteerMark, forgetSteerMark, steerMarks } from "./chatSteerMarks";
import * as chatState from "./chatSessionState";
import { useSessionDraft, useSessionSends } from "./sessionDraft";
import type { ChatSendRequest } from "./chatSendState";
import type { ChatSessionRef } from "../workspace/workspace";
import type { ChatDraft, FailedDraft, RecoveredChatDraft, QueueEngineSummary, QueueSlotItem, ToolEntry } from "./chatSessionTypes";
import { createChatFrameHandler } from "./useChatFrameHandler";
import {
  recoveryAfterClose,
  recoveryAfterError,
  recoveryAfterOpen,
  recoveryAfterProviderLoss,
  recoveryAfterReady,
  type RecoveryState,
} from "./recoveryState";

export type { RecoveryPhase, RecoveryState } from "./recoveryState";

/**
 * Set when a resume_failed error frame proved the stored identity dangling:
 * the raw error string is suppressed in favor of the banner, and the state
 * deliberately survives live frames (run.started, deltas, tools) so the
 * banner outlives the failure until the pane is replaced.
 */
export interface MissingOriginal {
  readonly candidates: readonly ResumeCandidate[];
}

/**
 * One server advisory rendered as a distinct system block inside the
 * transcript flow. `at` carries the server stamp (epoch ms) when the frame
 * had one, otherwise the client's receipt time.
 */
export interface ChatNotice {
  readonly id: number;
  readonly kind: string;
  readonly payload: JsonObject | null;
  readonly at: number;
  readonly nid?: string;
}

/** Cap on retained advisories: wide enough for a durable server replay. */
const NOTICE_LIMIT = 50;

export type HistoryStatus = "loading" | "loaded" | "failed";

// Inactivity window since the last sign of history progress: active multi-page
// loads may run indefinitely, while a silent provider cannot hide advisories forever.
const HISTORY_STALL_MS = 30_000;

/**
 * One row of the unified transcript render list: a conversation entry or an
 * in-flow system notice block.
 */
export type TranscriptItem =
  | { readonly kind: "message"; readonly message: UiMessage }
  | { readonly kind: "notice"; readonly notice: ChatNotice };

/**
 * Preserve the authoritative message order exactly and merge notices around
 * timestamped message boundaries. Timestamp-less optimistic/steer messages
 * therefore stay where they were sent. Notice ties use receipt id (oldest
 * first), and a notice follows every message sharing its millisecond.
 */
export function mergeTranscriptItems(
  messages: readonly UiMessage[],
  notices: readonly ChatNotice[],
): readonly TranscriptItem[] {
  const orderedNotices = [...notices].sort((a, b) => a.at - b.at || a.id - b.id);
  const items: TranscriptItem[] = [];
  let noticeIndex = 0;
  for (const message of messages) {
    const ts = message.ts ?? 0;
    if (ts > 0) {
      while (noticeIndex < orderedNotices.length && orderedNotices[noticeIndex]!.at < ts) {
        items.push({ kind: "notice", notice: orderedNotices[noticeIndex++]! });
      }
    }
    items.push({ kind: "message", message });
  }
  while (noticeIndex < orderedNotices.length) {
    items.push({ kind: "notice", notice: orderedNotices[noticeIndex++]! });
  }
  return items;
}

export function useChatFrameState(session?: Pick<ChatSessionRef, "wsId" | "id">) {
  const { store: sends, requests: sendRequests } = useSessionSends(session);
  const { cancelRecovery } = useSessionDraft(session);
  const socketRef = useRef(0);
  const { t } = useT();
  const controls = useConfirmedControls();
  const ledger = controls.ledger;
  const [messages, setMessages] = useState<readonly UiMessage[]>([]);
  const streaming = useStreamingBuffer();
  const pageBuffer = useEntriesPageBuffer();
  const [thinking, setThinking] = useState("");
  const [toolCalls, setToolCalls] = useState<Readonly<Record<string, ToolEntry>>>({});
  const [running, setRunning] = useState(false);
  const [doneReason, setDoneReason] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [missingOriginal, setMissingOriginal] = useState<MissingOriginal | null>(null);
  const [externalWriteDetected, setExternalWriteDetected] = useState(false);
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  const [cacheHitRate, setCacheHitRate] = useState<number | null>(null);
  const [isCompacting, setIsCompacting] = useState(false);
  const [historyStatus, setHistoryStatus] = useState<HistoryStatus>("loading");
  const historyLoaded = historyStatus === "loaded";
  const [connected, setConnected] = useState(false);
  const [commands, setCommands] = useState<readonly CommandEntry[]>([]);
  const [models, setModels] = useState<readonly { readonly provider: string; readonly modelId: string; readonly name?: string; readonly input?: readonly string[] }[]>([]);
  const [pendingApproval, setPendingApproval] = useState<ApprovalRequest | null>(null);
  const [restoreVersion, setRestoreVersion] = useState(0);
  const [retryDraft, setRetryDraft] = useState<RecoveredChatDraft | null>(null);
  const [sendError, setSendError] = useState<JsonObject | null>(null);
  const [activities, setActivities] = useState<ActivityState>(emptyActivityState);
  const [activitiesVersion, setActivitiesVersion] = useState(0);
  const [notices, setNotices] = useState<readonly ChatNotice[]>([]);
  const [recovery, setRecovery] = useState<RecoveryState | null>(null);
  const [queueItems, setQueueItems] = useState<readonly QueueSlotItem[]>([]);
  const [queueEngine, setQueueEngine] = useState<QueueEngineSummary>({ pendingMessageCount: 0, ordered: [] });
  const failedDrafts: readonly FailedDraft[] = sendRequests.filter(request => request.phase === "failed" && !request.queueOwned)
    .map(request => ({ ...request.draft, requestId: request.requestId }));
  const queuePlaceholders = sendRequests.filter(request => request.kind === "queued" && !request.queueOwned && (request.phase === "sending" || request.phase === "admitted"))
    .map(request => ({ requestId: request.requestId, text: request.text, hasImage: request.draft.image !== null }));
  const steerPending = sendRequests.filter(request => request.showSteer).map(request => ({ requestId: request.requestId, text: request.text }));
  const messagesRef = useRef<readonly UiMessage[]>([]);
  const runningRef = useRef(false);
  const submitLatchRef = useRef(false);
  const retryVersionRef = useRef(0);
  const externalRecoveryPendingRef = useRef(false);
  const externalRecoveryReadyRef = useRef(false);
  const externalRecoveryHistoryRef = useRef(false);
  const replayGenerationRef = useRef(0);
  const connectionGenerationRef = useRef(0);
  const replayQueueRef = useRef<Array<{
    readonly generation: number;
    readonly connectionGeneration: number;
    ready: boolean;
    terminal: boolean;
  }>>([]);
  const resyncGenerationRef = useRef<number | null>(null);
  const resyncPendingRef = useRef(false);
  const [resyncBusy, setResyncBusy] = useState(false);
  const messageVersionRef = useRef(0);
  const snapshotVersionRef = useRef(0);
  const snapshotMessagesRef = useRef<readonly UiMessage[]>([]);
  const toolCallsRef = useRef<Readonly<Record<string, ToolEntry>>>({});
  const historyLoadedRef = useRef(false);
  const historyStallTimerRef = useRef<number | null>(null);
  const activitiesRef = useRef<ActivityState>(emptyActivityState());
  const todoAuthorityRef = useRef(emptyTodoAuthority());
  const activityHydrationRef = useRef<{
    readonly token: number;
    readonly buffer: ActivityHydrationBuffer;
    readonly touchedDags: Set<string>;
    readonly touchedTasks: Set<string>;
  } | null>(null);
  const activityHydrationTokenRef = useRef(0);
  const noticeIdRef = useRef(0);
  const recoveryRef = useRef<RecoveryState | null>(null);
  // True while a socket generation is open; a close only starts a recovery
  // cycle when a live connection was actually lost.
  const socketOpenRef = useRef(false);
  const applyRecovery = (next: RecoveryState | null): void => {
    if (next === recoveryRef.current) return;
    recoveryRef.current = next;
    setRecovery(next);
  };

  const replaceMessages = (next: readonly UiMessage[]): void => {
    messagesRef.current = next;
    setMessages(next);
  };
  const replaceToolCalls = (next: Readonly<Record<string, ToolEntry>>): void => {
    toolCallsRef.current = next;
    setToolCalls(next);
  };
  const applyActivities = (next: ActivityState): void => {
    const hydration = activityHydrationRef.current;
    if (hydration !== null && next.dags !== activitiesRef.current.dags) {
      for (const [id, run] of next.dags) {
        if (run !== activitiesRef.current.dags.get(id)) hydration.touchedDags.add(id);
      }
    }
    if (hydration !== null && next.tasks !== activitiesRef.current.tasks) {
      for (const id of new Set([...next.tasks.keys(), ...activitiesRef.current.tasks.keys()])) {
        if (next.tasks.get(id) !== activitiesRef.current.tasks.get(id)) hydration.touchedTasks.add(id);
      }
    }
    activitiesRef.current = next;
    setActivities(next);
    setActivitiesVersion((version) => version + 1);
  };

  // Notices are retained newest-first and capped: a chatty server cannot
  // flood the pane, and the wide limit admits a durable server replay on
  // attach.
  const pushNotice = (kind: string, payload: JsonObject | null, at?: number, nid?: string): void => {
    setNotices((current) => {
      if (nid !== undefined && current.some((notice) => notice.nid === nid)) {
        return current;
      }
      return [{
        id: ++noticeIdRef.current,
        kind,
        payload,
        at: at ?? Date.now(),
        ...(nid !== undefined ? { nid } : {}),
      }, ...current].slice(0, NOTICE_LIMIT);
    });
  };

  const offerFailedDraft = (request: ChatSendRequest): void => {
    // Preserve direct failure recovery. Even a local prompt can be queued by
    // the server, so later handoff must cancel this request-owned offer/copy.
    if (request.kind === "queued" || request.queueOwned) return;
    setRetryDraft({ ...request.draft, requestId: request.requestId, version: ++retryVersionRef.current });
  };
  const cancelQueuedRecovery = (requestIds: ReadonlySet<string>): void => {
    setRetryDraft(current => current?.requestId && !current.explicit && requestIds.has(current.requestId) ? null : current);
    cancelRecovery(requestIds);
  };
  // A sibling receiver can perform the handoff first. Its shared receipt also
  // revokes this pane's unapplied offer, so remount cannot restore it again.
  useEffect(() => {
    if (!retryDraft?.requestId || retryDraft.explicit) return;
    const receipt = sends.terminal(retryDraft.requestId);
    if (receipt !== "queued" && receipt !== "queueFailed" && receipt !== "completed") return;
    setRetryDraft(null);
    cancelRecovery(new Set([retryDraft.requestId]));
  }, [sendRequests, retryDraft, sends, cancelRecovery]);
  const recoverFailedDraft = (requestId: string): void => {
    const request = sends.get(requestId);
    if (!request || request.queueOwned || (request.phase !== "failed" && request.phase !== "unknown")) return;
    const draft = sends.retire(requestId);
    if (draft) setRetryDraft({ ...draft, requestId, version: ++retryVersionRef.current, explicit: true });
  };
  const clearLiveSurfaces = (): void => {
    runningRef.current = false;
    sends.endRun();
    setRunning(false);
    streaming.clear();
    setThinking("");
    replaceToolCalls({});
  };

  const beginReplay = (connectionGeneration: number): number => {
    const generation = ++replayGenerationRef.current;
    replayQueueRef.current.push({ generation, connectionGeneration, ready: false, terminal: false });
    return generation;
  };
  const claimReadyGeneration = (connectionGeneration: number): number => {
    const replay = replayQueueRef.current.find((candidate) =>
      candidate.connectionGeneration === connectionGeneration && !candidate.ready);
    if (!replay) {
      const interrupted = replayQueueRef.current.find((candidate) =>
        candidate.connectionGeneration === connectionGeneration && !candidate.terminal);
      if (interrupted) {
        // Another binding ready before terminal replaces this attempt, not
        // the logical replay. Only its uncommitted pages are retractable.
        // Preserve the resync fence and its original live-message snapshot.
        if (resyncGenerationRef.current === null
          || resyncGenerationRef.current === interrupted.generation) pageBuffer.reset();
        return interrupted.generation;
      }
      // A user query can recover on the same socket without beginResync.
      // Track its first ready so a replacement can retire its partial pages.
      snapshotVersionRef.current = messageVersionRef.current;
      snapshotMessagesRef.current = messagesRef.current;
      const generation = ++replayGenerationRef.current;
      replayQueueRef.current.push({ generation, connectionGeneration, ready: true, terminal: false });
      return generation;
    }
    if (replay.terminal) {
      snapshotVersionRef.current = messageVersionRef.current;
      snapshotMessagesRef.current = messagesRef.current;
    }
    replay.ready = true;
    replayQueueRef.current = replayQueueRef.current.filter((candidate) => !candidate.ready || !candidate.terminal);
    return replay.generation;
  };
  const claimHistoryGeneration = (connectionGeneration: number, terminal: boolean): number => {
    const replay = replayQueueRef.current.find((candidate) =>
      candidate.connectionGeneration === connectionGeneration && !candidate.terminal);
    if (!replay) return connectionGeneration;
    if (terminal) {
      replay.terminal = true;
      replayQueueRef.current = replayQueueRef.current.filter((candidate) => !candidate.ready || !candidate.terminal);
    }
    return replay.generation;
  };

  // Manual re-sync follows the same hydration lifecycle as attach. Its
  // generation remains active through terminal history even when ready has
  // already released the action's own busy marker, fencing older page streams
  // away from the reset buffer.
  const beginResync = (): void => {
    todoAuthorityRef.current = unbindTodoAuthority(todoAuthorityRef.current);
    const generation = beginReplay(connectionGenerationRef.current);
    resyncGenerationRef.current = generation;
    resyncPendingRef.current = true;
    snapshotVersionRef.current = messageVersionRef.current;
    snapshotMessagesRef.current = messagesRef.current;
    historyLoadedRef.current = false;
    pageBuffer.reset();
    setHistoryStatus("loading");
    setError("");
    setResyncBusy(true);
  };
  const endResync = (generation: number, terminal = false): void => {
    if (resyncGenerationRef.current !== generation) return;
    if (resyncPendingRef.current) {
      resyncPendingRef.current = false;
      setResyncBusy(false);
    }
    if (terminal) resyncGenerationRef.current = null;
  };
  const failResync = (): void => {
    const generation = resyncGenerationRef.current;
    if (generation !== null) {
      replayQueueRef.current = replayQueueRef.current.filter((candidate) => candidate.generation !== generation);
    }
    resyncGenerationRef.current = null;
    resyncPendingRef.current = false;
    setResyncBusy(false);
    setHistoryStatus((current) => current === "loading" ? "failed" : current);
  };

  const armHistoryStall = (refresh: boolean): void => {
    if (historyStatus !== "loading") return;
    if (historyStallTimerRef.current !== null && !refresh) return;
    if (historyStallTimerRef.current !== null) window.clearTimeout(historyStallTimerRef.current);
    const connectionGeneration = connectionGenerationRef.current;
    historyStallTimerRef.current = window.setTimeout(() => {
      historyStallTimerRef.current = null;
      const stalled = replayQueueRef.current.filter((candidate) =>
        candidate.connectionGeneration === connectionGeneration);
      replayQueueRef.current = replayQueueRef.current.filter((candidate) =>
        candidate.connectionGeneration !== connectionGeneration);
      if (stalled.some((candidate) => candidate.generation === resyncGenerationRef.current)) {
        resyncGenerationRef.current = null;
        resyncPendingRef.current = false;
        setResyncBusy(false);
      }
      setHistoryStatus((current) => current === "loading" ? "failed" : current);
    }, HISTORY_STALL_MS);
  };

  const baseHandleFrame = createChatFrameHandler({
    t,
    controls,
    streaming,
    pageBuffer,
    messagesRef,
    runningRef,
    submitLatchRef,
    sends,
    offerFailedDraft,
    cancelQueuedRecovery,
    messageVersionRef,
    snapshotVersionRef,
    snapshotMessagesRef,
    resyncGenerationRef,
    claimReadyGeneration,
    claimHistoryGeneration,
    toolCallsRef,
    historyLoadedRef,
    activitiesRef,
    todoAuthorityRef,
    bufferActivityEvent: (event: BufferedActivityEvent) => {
      const hydration = activityHydrationRef.current;
      if (hydration !== null) bufferActivityHydrationEvent(hydration.buffer, event);
    },
    externalRecoveryPendingRef,
    externalRecoveryReadyRef,
    externalRecoveryHistoryRef,
    endResync,
    replaceMessages,
    replaceToolCalls,
    applyActivities,
    clearLiveSurfaces,
    armHistoryStall,
    setThinking,
    setRunning,
    setDoneReason,
    setError,
    setMissingOriginal,
    setExternalWriteDetected,
    setContextUsage,
    setCacheHitRate,
    setIsCompacting,
    setHistoryStatus,
    setCommands,
    setModels,
    setPendingApproval,
    setRestoreVersion,
    setSendError,
    pushNotice,
    setQueueItems,
    setQueueEngine,
  });

  // Recovery observation wraps the frame handler: the ready replay and the
  // mapped resume-failure errors are the recovery-state surface, and both
  // must be seen even when the handler itself early-returns on them. A
  // provider_disconnected error is the server-observed transport loss: the
  // browser socket stays open, so it is the only cycle start that flow gets.
  const handleFrame = (frame: ChatServerFrame, connectionGeneration = 0): "refresh_stats" | void => {
    if (frame.type === "ready") applyRecovery(recoveryAfterReady(recoveryRef.current));
    else if (frame.type === "error") {
      applyRecovery(frame.code === "provider_disconnected"
        ? recoveryAfterProviderLoss(recoveryRef.current)
        : recoveryAfterError(recoveryRef.current, frame.code, frame.message));
    }
    return baseHandleFrame(frame, connectionGeneration);
  };

  // Both domains reconcile per ID; touches outlive the bounded progress buffer.
  const beginActivityHydration = (): number => {
    const token = ++activityHydrationTokenRef.current;
    activityHydrationRef.current = { token, buffer: createActivityHydrationBuffer(), touchedDags: new Set(), touchedTasks: new Set() };
    return token;
  };
  const cancelActivityHydration = (token: number): void => {
    if (activityHydrationRef.current?.token === token) activityHydrationRef.current = null;
  };
  const hydrateActivities = (token: number, task: unknown, dag: unknown, taskDigest?: unknown, taskOversized = false): void => {
    const hydration = activityHydrationRef.current;
    if (hydration === null || hydration.token !== token) return;
    activityHydrationRef.current = null;
    let next = activitiesRef.current;
    next = applyTaskHistorySnapshot(next, task, hydration.touchedTasks, parseTaskDigest(taskDigest) ?? undefined, taskOversized);
    next = applyDagHistorySnapshot(next, dag, hydration.touchedDags);
    for (const event of hydration.buffer.events) {
      // Accepted DAG snapshots already exist in current state. Replacing again
      // would remove REST-only rows or reverse both-unknown legacy ordering.
      if (event.name !== "omo.dag.updated" && event.name !== "omo.task.updated") next = applyActivityEvent(next, event.name, event.data);
    }
    if (next !== activitiesRef.current) applyActivities(next);
  };

  const sendDraft = (draft: ChatDraft, requestId: string, sessionId: string, client: ChatClient | null, kind: ChatSendRequest["kind"]): boolean => {
    const text = draft.text.trim();
    if (submitLatchRef.current || (!text && !draft.image) || !client) return false;
    if (kind === "prompt" && (runningRef.current || sends.getSnapshot().some(request => request.hold))) return false;
    submitLatchRef.current = true;
    sends.register(requestId, kind, draft, socketRef.current);
    if (kind === "prompt") {
      setDoneReason(null);
      streaming.clear();
      setThinking("");
      replaceToolCalls({});
    }
    if (kind === "steer") {
      const marks = steerMarks(sessionId);
      const ordinal = Math.max(messagesRef.current.filter(message => message.role === "user").length, ...marks.map(mark => mark.ordinal)) + 1;
      recordSteerMark(sessionId, { requestId, text, ordinal });
    }
    let accepted = false;
    try {
      accepted = client.send(kind === "steer"
        ? { type: "chat.send", sessionId, requestId, run: { kind: "steer", message: text } }
        : chatState.queuedSendFrame({ text, image: draft.image }, requestId, sessionId));
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      submitLatchRef.current = false;
    }
    // Incoming callbacks already advanced the registered operation. Never
    // resurrect a terminal operation or undo independently received messages.
    if (sends.terminal(requestId)) return true;
    if (!accepted) {
      sends.rollback(requestId);
      if (kind === "steer") forgetSteerMark(sessionId, requestId);
    }
    return accepted;
  };
  const submit = (draft: ChatDraft, requestId: string, sessionId: string, client: ChatClient | null): boolean =>
    sendDraft(draft, requestId, sessionId, client, "prompt");
  const queueSend = (draft: ChatDraft, requestId: string, sessionId: string, client: ChatClient | null): boolean =>
    sendDraft(draft, requestId, sessionId, client, "queued");
  const steer = (text: string, requestId: string, sessionId: string, client: ChatClient | null): boolean =>
    sendDraft({ text, image: null }, requestId, sessionId, client, "steer");

  const markOpen = (): number => {
    todoAuthorityRef.current = unbindTodoAuthority(todoAuthorityRef.current);
    applyRecovery(recoveryAfterOpen(recoveryRef.current));
    socketOpenRef.current = true;
    socketRef.current = sends.nextSocket();
    const connectionGeneration = ++replayGenerationRef.current;
    connectionGenerationRef.current = connectionGeneration;
    replayQueueRef.current.push({
      generation: connectionGeneration,
      connectionGeneration,
      ready: false,
      terminal: false,
    });
    snapshotVersionRef.current = messageVersionRef.current;
    snapshotMessagesRef.current = messagesRef.current;
    historyLoadedRef.current = false;
    setHistoryStatus("loading");
    setConnected(true);
    pageBuffer.reset();
    return connectionGeneration;
  };
  const markClose = (): void => {
    todoAuthorityRef.current = unbindTodoAuthority(todoAuthorityRef.current);
    applyRecovery(recoveryAfterClose(recoveryRef.current, socketOpenRef.current));
    socketOpenRef.current = false;
    ledger.failAll();
    if (historyStallTimerRef.current !== null) {
      window.clearTimeout(historyStallTimerRef.current);
      historyStallTimerRef.current = null;
    }
    sends.disconnect(socketRef.current);
    const closedGeneration = connectionGenerationRef.current;
    const closedReplays = replayQueueRef.current.filter((candidate) =>
      candidate.connectionGeneration === closedGeneration);
    replayQueueRef.current = replayQueueRef.current.filter((candidate) =>
      candidate.connectionGeneration !== closedGeneration);
    if (closedReplays.some((candidate) => candidate.generation === resyncGenerationRef.current)) {
      resyncGenerationRef.current = null;
      resyncPendingRef.current = false;
      setResyncBusy(false);
    }
    setHistoryStatus((current) => current === "loading" ? "failed" : current);
    setConnected(false);
  };

  const beginExternalWriteRecovery = (): void => {
    todoAuthorityRef.current = unbindTodoAuthority(todoAuthorityRef.current);
    externalRecoveryPendingRef.current = true;
    externalRecoveryReadyRef.current = false;
    externalRecoveryHistoryRef.current = false;
    historyLoadedRef.current = false;
    pageBuffer.reset();
    setHistoryStatus("loading");
    setError("");
  };

  const failExternalWriteRecovery = (): void => {
    externalRecoveryPendingRef.current = false;
    setHistoryStatus((current) => current === "loading" ? "failed" : current);
  };

  useEffect(() => {
    if (historyStatus !== "loading" && historyStallTimerRef.current !== null) {
      window.clearTimeout(historyStallTimerRef.current);
      historyStallTimerRef.current = null;
    }
    return () => {
      if (historyStallTimerRef.current !== null) {
        window.clearTimeout(historyStallTimerRef.current);
        historyStallTimerRef.current = null;
      }
    };
  }, [historyStatus]);

  return {
    messages,
    streaming: streaming.streaming,
    thinking,
    toolCalls,
    running: running || sendRequests.some(request => request.hold),
    serverRunning: running,
    sendRequests,
    dismissSendRequest: (requestId: string) => { sends.retire(requestId); },
    doneReason,
    error,
    missingOriginal,
    externalWriteDetected,
    contextUsage,
    cacheHitRate,
    isCompacting,
    historyLoaded,
    historyStatus,
    connected,
    commands,
    thinkingLevel: controls.thinkingLevel,
    models,
    currentModelKey: controls.currentModelKey,
    pendingApproval,
    restoreVersion,
    retryDraft,
    failedDrafts,
    recoverFailedDraft,
    sendError,
    dismissSendError: () => setSendError(null),
    queueItems,
    queueEngine,
    queuePlaceholders,
    steerPending,
    activities,
    activitiesVersion,
    notices,
    recovery,
    handleFrame,
    beginActivityHydration,
    cancelActivityHydration,
    hydrateActivities,
    submit,
    queueSend,
    steer,
    markOpen,
    markClose,
    setThinkingLevel: controls.setThinkingLevel,
    setCurrentModelKey: controls.setCurrentModelKey,
    setPendingApproval,
    reportError: setError,
    beginExternalWriteRecovery,
    failExternalWriteRecovery,
    beginResync,
    endResync,
    failResync,
    resyncBusy,
    resyncDisabled: resyncBusy || historyStatus === "loading" || !connected,
    armControl: ledger.arm,
    rejectControl: ledger.reject,
    confirmedModelKey: controls.confirmedModelKey,
    confirmedThinkingLevel: controls.confirmedThinkingLevel,
    applyConfirmedModelKey: controls.applyConfirmedModelKey,
    applyConfirmedThinkingLevel: controls.applyConfirmedThinkingLevel,
  };
}
