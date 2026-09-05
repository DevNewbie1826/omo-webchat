import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import type { ChatClient, CommandEntry, ContextUsage, JsonObject, ResumeCandidate } from "../../lib/chatWs";
import type { ApprovalRequest } from "./ApprovalModal";
import { useConfirmedControls } from "./chatConfirmedControls";
import { type UiMessage } from "./chatEntries";
import {
  applyActivityEvent,
  applyActivityHistorySnapshot,
  bufferActivityHydrationEvent,
  createActivityHydrationBuffer,
  emptyActivityState,
  type ActivityHydrationBuffer,
  type BufferedActivityEvent,
} from "./activityState";
import type { ActivityState } from "./activityTypes";
import { useEntriesPageBuffer } from "./useEntriesPageBuffer";
import { useStreamingBuffer } from "./useStreamingBuffer";
import { recordSteerMark, steerMarks } from "./chatSteerMarks";
import * as chatState from "./chatSessionState";
import type { ChatDraft, QueueEngineSummary, QueuePlaceholder, QueueSlotItem, SteerPendingItem, ToolEntry } from "./chatSessionTypes";
import { createChatFrameHandler } from "./useChatFrameHandler";

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

export interface FailedDraft extends ChatDraft {
  readonly requestId: string;
}

/** Cap on retained advisories: wide enough for a durable server replay. */
const NOTICE_LIMIT = 50;

/**
 * chat.send outcomes are replayed on every attach. Keep their consumption
 * shared across panes so an outcome handled by one pane stays handled when a
 * replacement pane attaches, while bounding the process-lifetime registry.
 * Local control ids deliberately never enter this registry because their
 * sequences restart when a pane is replaced.
 */
const CONSUMED_OUTCOME_LIMIT = 512;
const consumedOutcomeKeys = new Set<string>();
const consumedOutcomeOrder: string[] = [];

function consumeOutcome(requestId: string): boolean {
  if (consumedOutcomeKeys.has(requestId)) return false;
  consumedOutcomeKeys.add(requestId);
  consumedOutcomeOrder.push(requestId);
  if (consumedOutcomeOrder.length > CONSUMED_OUTCOME_LIMIT) {
    const expired = consumedOutcomeOrder.shift();
    if (expired !== undefined) consumedOutcomeKeys.delete(expired);
  }
  return true;
}

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

export function useChatFrameState() {
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
  const [retryDraft, setRetryDraft] = useState<(ChatDraft & { readonly version: number }) | null>(null);
  const [failedDrafts, setFailedDrafts] = useState<readonly FailedDraft[]>([]);
  const [, setPendingVersion] = useState(0);
  const [sendError, setSendError] = useState<JsonObject | null>(null);
  const [activities, setActivities] = useState<ActivityState>(emptyActivityState);
  const [activitiesVersion, setActivitiesVersion] = useState(0);
  const [notices, setNotices] = useState<readonly ChatNotice[]>([]);
  const [queueItems, setQueueItems] = useState<readonly QueueSlotItem[]>([]);
  const [queueEngine, setQueueEngine] = useState<QueueEngineSummary>({ pendingMessageCount: 0, ordered: [] });
  const [queuePlaceholders, setQueuePlaceholders] = useState<readonly QueuePlaceholder[]>([]);
  const [steerPending, setSteerPending] = useState<readonly SteerPendingItem[]>([]);
  const messagesRef = useRef<readonly UiMessage[]>([]);
  const runningRef = useRef(false);
  const submitLatchRef = useRef(false);
  const optimisticIdRef = useRef(0);
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
  const pendingRef = useRef<chatState.PendingOptimistic[]>([]);
  const queuePlaceholdersRef = useRef<readonly QueuePlaceholder[]>([]);
  const steerPendingRef = useRef<readonly SteerPendingItem[]>([]);
  const ownedSendRequestIdsRef = useRef(new Set<string>());
  const retiredSteerIdsRef = useRef(new Set<number>());
  const activeRunRef = useRef<chatState.PendingOptimistic | null>(null);
  const uncertainRunRef = useRef<chatState.PendingOptimistic | null>(null);
  const awaitingReconnectHistoryRef = useRef(false);
  const messageVersionRef = useRef(0);
  const snapshotVersionRef = useRef(0);
  const snapshotMessagesRef = useRef<readonly UiMessage[]>([]);
  const toolCallsRef = useRef<Readonly<Record<string, ToolEntry>>>({});
  const historyLoadedRef = useRef(false);
  const historyStallTimerRef = useRef<number | null>(null);
  const activitiesRef = useRef<ActivityState>(emptyActivityState());
  const activityHydrationRef = useRef<{
    readonly token: number;
    readonly buffer: ActivityHydrationBuffer;
  } | null>(null);
  const activityHydrationTokenRef = useRef(0);
  const noticeIdRef = useRef(0);

  const replaceMessages = (next: readonly UiMessage[]): void => {
    messagesRef.current = next;
    setMessages(next);
  };
  const replaceToolCalls = (next: Readonly<Record<string, ToolEntry>>): void => {
    toolCallsRef.current = next;
    setToolCalls(next);
  };
  const applyActivities = (next: ActivityState): void => {
    activitiesRef.current = next;
    setActivities(next);
    setActivitiesVersion((version) => version + 1);
  };

  const replaceQueuePlaceholders = (next: readonly QueuePlaceholder[]): void => {
    queuePlaceholdersRef.current = next;
    setQueuePlaceholders(next);
  };
  const replaceSteerPending = (next: readonly SteerPendingItem[]): void => {
    steerPendingRef.current = next;
    setSteerPending(next);
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

  const retainFailedDrafts = (runs: readonly chatState.PendingOptimistic[]): void => {
    if (runs.length === 0) return;
    setFailedDrafts((current) => {
      const incoming = runs.map(({ requestId, text, image, command }) => ({
        requestId,
        text,
        image,
        ...(command ? { command } : {}),
      }));
      const ids = new Set(incoming.map((draft) => draft.requestId));
      return [...incoming, ...current.filter((draft) => !ids.has(draft.requestId))].slice(0, 20);
    });
    const newest = runs[0]!;
    setRetryDraft({ text: newest.text, image: newest.image, version: ++retryVersionRef.current });
  };

  const recoverFailedDraft = (requestId: string): void => {
    setFailedDrafts((current) => {
      const failed = current.find((draft) => draft.requestId === requestId);
      if (failed) setRetryDraft({ text: failed.text, image: failed.image, version: ++retryVersionRef.current });
      return current.filter((draft) => draft.requestId !== requestId);
    });
  };

  // Clear every transient live surface; shared by run completion, terminal
  // errors, and lost-run recovery.
  const clearLiveSurfaces = (): void => {
    runningRef.current = false;
    activeRunRef.current = null;
    setRunning(false);
    streaming.clear();
    setThinking("");
    replaceToolCalls({});
  };

  // Clear every transient live surface and offer a retry for a run that a
  // reconnect proved lost (missing user entry, or user entry without any
  // assistant reply while the server is not streaming).
  const recoverLostRun = (run: chatState.PendingOptimistic): void => {
    messageVersionRef.current += 1;
    clearLiveSurfaces();
    retainFailedDrafts([run]);
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
      const generation = ++replayGenerationRef.current;
      replayQueueRef.current.push({ generation, connectionGeneration, ready: true, terminal: false });
      return generation;
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

  const handleFrame = createChatFrameHandler({
    t,
    controls,
    streaming,
    pageBuffer,
    messagesRef,
    runningRef,
    submitLatchRef,
    pendingRef,
    ownedSendRequestIdsRef,
    retiredSteerIdsRef,
    activeRunRef,
    uncertainRunRef,
    awaitingReconnectHistoryRef,
    messageVersionRef,
    snapshotVersionRef,
    snapshotMessagesRef,
    resyncGenerationRef,
    claimReadyGeneration,
    claimHistoryGeneration,
    toolCallsRef,
    historyLoadedRef,
    activitiesRef,
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
    recoverLostRun,
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
    consumeOutcome,
    notifyPendingChanged: () => setPendingVersion((version) => version + 1),
    retainFailedDrafts,
    pushNotice,
    steerPendingRef,
    replaceSteerPending,
    queuePlaceholdersRef,
    replaceQueuePlaceholders,
    setQueueItems,
    setQueueEngine,
  });

  // REST is the historical base, but every activity frame received after the
  // request began is newer and must be replayed in arrival order. Full
  // snapshots and buffer overflow suppress REST replacement for every domain
  // whose live mutations can no longer be replayed completely.
  const beginActivityHydration = (): number => {
    const token = ++activityHydrationTokenRef.current;
    activityHydrationRef.current = { token, buffer: createActivityHydrationBuffer() };
    return token;
  };
  const cancelActivityHydration = (token: number): void => {
    if (activityHydrationRef.current?.token === token) activityHydrationRef.current = null;
  };
  const hydrateActivities = (token: number, task: unknown, dag: unknown): void => {
    const hydration = activityHydrationRef.current;
    if (hydration === null || hydration.token !== token) return;
    activityHydrationRef.current = null;
    let next = activitiesRef.current;
    // Overflow flags are mutation-aware (per-event bits): an armed flag means
    // a dropped event actually changed that domain's live state, so fencing
    // applies unconditionally — stale cached rows can no longer widen it.
    const protectLiveTasks = hydration.buffer.taskSuperseded
      || hydration.buffer.taskOverflowed;
    const protectLiveDags = hydration.buffer.dagSuperseded
      || hydration.buffer.dagOverflowed;
    if (!protectLiveTasks) {
      next = applyActivityHistorySnapshot(next, "omo.task.updated", task);
    }
    if (!protectLiveDags) {
      next = applyActivityHistorySnapshot(next, "omo.dag.updated", dag);
    }
    for (const event of hydration.buffer.events) {
      next = applyActivityEvent(next, event.name, event.data);
    }
    if (next !== activitiesRef.current) applyActivities(next);
  };

  const submit = (draft: ChatDraft, requestId: string, sessionId: string, client: ChatClient | null): boolean => {
    const text = draft.text.trim();
    if (submitLatchRef.current || runningRef.current || (!text && !draft.image) || !client) return false;
    const pending = chatState.newPendingRun(draft, text, ++optimisticIdRef.current, requestId, historyLoadedRef.current, messagesRef.current);
    pendingRef.current.push(pending);
    submitLatchRef.current = true;
    let accepted = false;
    try {
      accepted = client.send(chatState.promptSendFrame(pending, sessionId));
    } finally {
      submitLatchRef.current = false;
    }
    if (!accepted) {
      pendingRef.current = pendingRef.current.filter((item) => item !== pending);
      return false;
    }
    pending.accepted = true;
    ownedSendRequestIdsRef.current.add(requestId);
    messageVersionRef.current += 1;
    activeRunRef.current = pending;
    runningRef.current = true;
    setRunning(true);
    setDoneReason(null);
    streaming.clear();
    setThinking("");
    replaceToolCalls({});
    if (pending.echo) pendingRef.current = pendingRef.current.filter((item) => item !== pending);
    replaceMessages([...messagesRef.current, chatState.optimisticMessage(pending)]);
    return true;
  };

  // While a run (or compaction) is active the server owns the queue: the send
  // goes out as a plain prompt for the bridge to enqueue and ack. No transcript
  // row is created; the panel keeps a request-id placeholder until the matching
  // queue frame lands, and the queue survives reloads server-side.
  const queueSend = (draft: ChatDraft, requestId: string, sessionId: string, client: ChatClient | null): boolean => {
    const text = draft.text.trim();
    if ((!text && !draft.image) || !client) return false;
    const sent = client.send(chatState.queuedSendFrame({ text, image: draft.image }, requestId, sessionId));
    if (!sent) return false;
    ownedSendRequestIdsRef.current.add(requestId);
    replaceQueuePlaceholders([...queuePlaceholdersRef.current, { requestId, text, hasImage: draft.image !== null }]);
    return true;
  };

  const steer = (text: string, requestId: string, sessionId: string, client: ChatClient | null): boolean => {
    const trimmed = text.trim();
    if (!trimmed || !client) return false;
    const priorMarks = steerMarks(sessionId);
    const visibleUserCount = messagesRef.current.filter((message) => message.role === "user").length;
    const canonicalUserOrdinal = Math.max(visibleUserCount, ...priorMarks.map((mark) => mark.ordinal)) + 1;
    const pending = chatState.newPendingRun(
      { text: trimmed, image: null }, trimmed, ++optimisticIdRef.current, requestId,
      historyLoadedRef.current, messagesRef.current, "steer",
    );
    pendingRef.current.push(pending);
    const sent = client.send(chatState.steerSendFrame(pending, sessionId));
    if (!sent) {
      pendingRef.current = pendingRef.current.filter((item) => item !== pending);
      return false;
    }
    pending.accepted = true;
    ownedSendRequestIdsRef.current.add(requestId);
    // Persist the canonical occurrence identity so resync and reload can tag
    // this user row without matching another row that happens to share text.
    recordSteerMark(sessionId, { requestId, text: trimmed, ordinal: canonicalUserOrdinal });
    // No optimistic transcript row: the strip shows the pending summary until
    // the live echo (tagged as a steer) or run.done retires it.
    replaceSteerPending([...steerPendingRef.current, { requestId, text: trimmed }]);
    return true;
  };

  const markOpen = (): number => {
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
    awaitingReconnectHistoryRef.current = uncertainRunRef.current !== null
      || pendingRef.current.some((pending) => pending.kind === "followUp" && !pending.admitted);
    historyLoadedRef.current = false;
    setHistoryStatus("loading");
    setConnected(true);
    pageBuffer.reset();
    return connectionGeneration;
  };
  const markClose = (): void => {
    ledger.failAll();
    if (historyStallTimerRef.current !== null) {
      window.clearTimeout(historyStallTimerRef.current);
      historyStallTimerRef.current = null;
    }
    uncertainRunRef.current = chatState.uncertainRun(activeRunRef.current, pendingRef.current);
    awaitingReconnectHistoryRef.current = false;
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
    running,
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
