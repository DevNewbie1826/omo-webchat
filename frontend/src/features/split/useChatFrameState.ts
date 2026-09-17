import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import type { ChatClient, ChatServerFrame, CommandEntry, ContextUsage, JsonObject, ResumeCandidate } from "../../lib/chatWs";
import type { ApprovalRequest } from "./ApprovalDock";
import type { ApprovalFrame } from "../../lib/contract/types_gen";
import { useConfirmedControls } from "./chatConfirmedControls";
import { concatEntries, messageText, type UiMessage } from "./chatEntries";
import type { HistoryResumeCursor } from "../../lib/contract/types_gen";
import {
  applyActivityEvent,
  applyTaskHistorySnapshot,
  applyDagHistorySnapshot,
  bufferActivityHydrationEvent,
  createActivityHydrationBuffer,
  emptyActivityState,
  type ActivityHydrationBuffer,
  type BufferedActivityEvent,
  type LiveCountAdmission,
} from "./activityState";
import { parseDagDigest, parseTaskDigest } from "../workspace/activityDigest";
import type { ActivityState } from "./activityTypes";
import { applyCountAuthority, type CountAuthority } from "./taskAuthority";
import { parseTaskCounts } from "./activityParseTask";
import { parseDagCounts } from "./activityParseDag";
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
  recoveryAfterHistory,
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

type HistoryPage = Extract<ChatServerFrame, { type: "entries" }>;

const historyEntryId = (entry: unknown): string | undefined => typeof entry === "object" && entry !== null && "id" in entry && typeof entry.id === "string" ? entry.id : undefined;

function uniqueHistoryEntries(entries: unknown[]): unknown[] {
  const positions = new Map<string, number>();
  const result: unknown[] = [];
  for (const entry of entries) {
    const id = historyEntryId(entry);
    const position = id === undefined ? undefined : positions.get(id);
    if (position !== undefined) result[position] = entry;
    else {
      if (id !== undefined) positions.set(id, result.length);
      result.push(entry);
    }
  }
  return result;
}

// Shared IDs anchor the ordered union; reversed anchors contradict continuity.
function mergeHistoryEntries(earlier: unknown[], later: unknown[]): unknown[] | null {
  const left = uniqueHistoryEntries(earlier);
  const right = uniqueHistoryEntries(later);
  const positions = new Map(left.flatMap((entry, index) => {
    const id = historyEntryId(entry);
    return id === undefined ? [] : [[id, index] as const];
  }));
  const result: unknown[] = [];
  let next = 0;
  let pending: unknown[] = [];
  for (const entry of right) {
    const id = historyEntryId(entry);
    const position = id === undefined ? undefined : positions.get(id);
    if (position === undefined) pending.push(entry);
    else {
      if (position < next) return null;
      result.push(...left.slice(next, position), ...pending, entry);
      pending = [];
      next = position + 1;
    }
  }
  return [...result, ...left.slice(next), ...pending];
}

export function createHistoryResumeCoverage() {
  let committed: unknown[] = [];
  let pending: unknown[] = [];
  let cursor: HistoryResumeCursor | undefined;
  let continuity = true;
  return {
    entries: () => committed,
    cursor: () => cursor,
    reconnect: () => { pending = []; continuity = true; },
    reset: () => { committed = []; pending = []; cursor = undefined; continuity = true; },
    accept(frame: HistoryPage): { frame: HistoryPage; resumed: boolean } {
      const echo = frame.resume;
      let resumed = continuity && echo !== undefined && cursor !== undefined
        && frame.historySessionId === cursor.sessionId
        && echo.sessionId === cursor.sessionId && echo.firstEntryId === cursor.firstEntryId
        && echo.lastEntryId === cursor.lastEntryId && echo.historyComplete === cursor.historyComplete;
      if (frame.segment === "head") {
        if (committed.length === 0) return { frame, resumed: false };
        // Head echoes describe the original request, not the advancing cursor.
        // Only an explicit durable-identity contradiction retires that coverage.
        const identityChanged = cursor !== undefined && frame.historySessionId !== undefined
          && frame.historySessionId !== cursor.sessionId;
        const received = uniqueHistoryEntries(concatEntries([frame.entries]));
        committed = (identityChanged ? null : mergeHistoryEntries(received, committed)) ?? received;
        if (identityChanged) {
          pending = [];
          continuity = false;
        }
      } else {
        continuity = resumed;
        pending.push(frame.entries);
        if (frame.final === false) return { frame, resumed };
        const received = uniqueHistoryEntries(concatEntries(pending));
        const merged = resumed ? mergeHistoryEntries(committed, received) : null;
        resumed = resumed && merged !== null;
        committed = merged ?? received;
        pending = [];
        continuity = true;
      }
      const firstEntryId = historyEntryId(committed[0]);
      const lastEntryId = historyEntryId(committed[committed.length - 1]);
      const sessionId = frame.historySessionId ?? (frame.segment === "head" ? cursor?.sessionId : undefined);
      cursor = firstEntryId && lastEntryId && sessionId ? {
        sessionId, firstEntryId, lastEntryId, historyComplete: frame.historyComplete === true,
      } : undefined;
      return { frame: { ...frame, entries: committed }, resumed };
    },
  };
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
  const entriesBuffer = useEntriesPageBuffer();
  const resumeCoverage = useRef(createHistoryResumeCoverage());
  const historyPageCommittedRef = useRef(false);
  const pageBuffer = {
    ...entriesBuffer,
    reset: () => {
      entriesBuffer.reset();
      resumeCoverage.current.reconnect();
      historyPageCommittedRef.current = false;
    },
  };
  const [thinking, setThinking] = useState("");
  const [toolCalls, setToolCalls] = useState<Readonly<Record<string, ToolEntry>>>({});
  const [running, setRunning] = useState(false);
  const [doneReason, setDoneReason] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [missingOriginal, setMissingOriginal] = useState<MissingOriginal | null>(null);
  const [externalWriteDetected, setExternalWriteDetected] = useState(false);
  const [sessionActive, setSessionActive] = useState(false);
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  const [cacheHitRate, setCacheHitRate] = useState<number | null>(null);
  const [isCompacting, setIsCompacting] = useState(false);
  const [historyStatus, setHistoryStatus] = useState<HistoryStatus>("loading");
  const historyLoaded = historyStatus === "loaded";
  const [connected, setConnected] = useState(false);
  const [commands, setCommands] = useState<readonly CommandEntry[]>([]);
  const [models, setModels] = useState<readonly { readonly provider: string; readonly modelId: string; readonly name?: string; readonly input?: readonly string[] }[]>([]);
  const [pendingApproval, setPendingApproval] = useState<ApprovalRequest | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState<ApprovalFrame | null>(null);
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
    readonly requestedMs: number;
    /** Live-admission sequence when this request was registered; a live
     delivery accepted after it outranks the response. */
    readonly requestSeq: number;
    readonly touchedDags: Set<string>;
    readonly touchedTasks: Set<string>;
  } | null>(null);
  const activityHydrationTokenRef = useRef(0);
  // Pane-local count ordering: monotonic per accepted live count delivery.
  const liveActivitySequenceRef = useRef(0);
  // The winning live aggregate plus its ordering, retained independently of
  // the bounded hydration-event buffer.
  const liveCountAdmissionRef = useRef<LiveCountAdmission | null>(null);
  // The DAG-run scalar group keeps its own accepted ordering and values,
  // retained independently of the task/agent aggregate record: an unrelated
  // task-count delivery must not replace it, and a later-arriving older
  // hydration response can never lower it.
  const dagRunCountAdmissionRef = useRef<LiveCountAdmission | null>(null);
  // Steers accepted while the client holds only a bounded tail: a
  // root-relative ordinal cannot be computed from the loaded tail, so the
  // occurrence waits here and is recorded once the branch root is known.
  const pendingSteersRef = useRef<Array<{
    readonly requestId: string;
    readonly text: string;
    readonly sessionId: string;
    /** The materialized occurrence, bound when its echo message arrives. */
    readonly echo?: UiMessage;
  }>>([]);
  const noticeIdRef = useRef(0);
  const recoveryRef = useRef<RecoveryState | null>(null);
  // True while a socket generation is open; a close only starts a recovery
  // cycle when a live connection was actually lost.
  const socketOpenRef = useRef(false);
  // True while the bannered error came from a malformed inbound frame: that
  // banner is a symptom of the transport, and the disconnect surface owns the
  // story once the socket is gone.
  const parseErrorRef = useRef(false);
  const applyRecovery = (next: RecoveryState | null): void => {
    if (next === recoveryRef.current) return;
    recoveryRef.current = next;
    setRecovery(next);
  };
  // Every error surface except the parse reporter revokes parse-error
  // ownership, so a close can never clear a banner it does not own.
  const applyError: typeof setError = (message) => {
    parseErrorRef.current = false;
    setError(message);
  };
  const reportParseError = (message: string): void => {
    parseErrorRef.current = true;
    setError(message);
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
    resumeCoverage.current.reset();
    todoAuthorityRef.current = unbindTodoAuthority(todoAuthorityRef.current);
    const generation = beginReplay(connectionGenerationRef.current);
    resyncGenerationRef.current = generation;
    resyncPendingRef.current = true;
    snapshotVersionRef.current = messageVersionRef.current;
    snapshotMessagesRef.current = messagesRef.current;
    historyLoadedRef.current = false;
    pageBuffer.reset();
    // A reloaded branch already contains any accepted steer, so a retained
    // occurrence from the replaced load must never resolve against it.
    pendingSteersRef.current = [];
    setHistoryStatus("loading");
    applyError("");
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

  // Resolve retained steer occurrences in send order against the reconciled
  // branch. An occurrence whose echo already materialized resolves to THAT
  // message's root-relative ordinal; one still waiting for its echo keeps
  // the append rule used when the whole branch is already held. Returns true
  // when marks were recorded so the caller applies them in the same pass.
  const settlePendingSteers = (sessionId: string, messages: readonly UiMessage[]): boolean => {
    const pending = pendingSteersRef.current;
    if (pending.length === 0) return false;
    pendingSteersRef.current = [];
    for (const steer of pending) {
      let ordinal: number | null = null;
      if (steer.echo !== undefined) {
        let position = 0;
        for (const message of messages) {
          if (message.role !== "user") continue;
          position += 1;
          if (message === steer.echo) {
            ordinal = position;
            break;
          }
        }
      }
      if (ordinal === null) {
        const marks = steerMarks(steer.sessionId);
        ordinal = Math.max(messages.filter(message => message.role === "user").length, ...marks.map(mark => mark.ordinal)) + 1;
      }
      recordSteerMark(steer.sessionId, { requestId: steer.requestId, text: steer.text, ordinal });
    }
    return true;
  };
  // Bind a live user message to the oldest retained steer occurrence still
  // waiting for its echo: the occurrence identity survives warming, so
  // settlement resolves the message that was actually sent.
  const bindPendingSteerEcho = (sessionId: string, message: UiMessage): void => {
    if (pendingSteersRef.current.length === 0) return;
    const text = messageText(message);
    const match = pendingSteersRef.current.find(pending =>
      pending.sessionId === sessionId && pending.echo === undefined && pending.text === text);
    if (match === undefined) return;
    pendingSteersRef.current = pendingSteersRef.current.map(pending =>
      pending === match ? { ...pending, echo: message } : pending);
  };
  // A run boundary without an echo retires the retained occurrences that
  // never materialized; occurrences whose echo already arrived survive.
  const retireUnmaterializedPendingSteers = (): void => {
    pendingSteersRef.current = pendingSteersRef.current.filter(pending => pending.echo !== undefined);
  };
  const dropPendingSteer = (requestId: string): void => {
    pendingSteersRef.current = pendingSteersRef.current.filter(pending => pending.requestId !== requestId);
  };

  const baseHandleFrame = createChatFrameHandler({
    acceptHistoryPage: (frame) => {
      if (frame.segment === "head" && !historyPageCommittedRef.current) return null;
      const accepted = resumeCoverage.current.accept(frame);
      if (frame.segment === "head" || frame.final !== false) {
        // Coverage already produced the whole accepted list, including replacement.
        entriesBuffer.reset();
        historyPageCommittedRef.current = true;
      }
      return accepted;
    },
    t,
    controls,
    streaming,
    pageBuffer,
    messagesRef,
    runningRef,
    submitLatchRef,
    sends,
    offerFailedDraft,
    settlePendingSteers,
    bindPendingSteerEcho,
    retireUnmaterializedPendingSteers,
    dropPendingSteer,
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
    admitLiveCountAuthority: (counts: CountAuthority) => {
      const hasTaskGroupCounts = counts.taskRunningCount !== undefined || counts.taskTotalCount !== undefined
        || counts.taskAgentRunningCount !== undefined || counts.taskAgentTotalCount !== undefined;
      const hasDagRunCounts = counts.dagRunRunningCount !== undefined || counts.dagRunTotalCount !== undefined
        || counts.dagRunCountsUnavailable !== undefined;
      if (!hasTaskGroupCounts && !hasDagRunCounts) return;
      const seq = ++liveActivitySequenceRef.current;
      // A run-only delivery carries no task/agent aggregate but does carry
      // the exact DAG-run pair; that group is retained per group, so a
      // task/agent-only delivery replaces only its own record.
      if (hasDagRunCounts) {
        dagRunCountAdmissionRef.current = {
          counts: {
            ...(counts.dagRunRunningCount === undefined ? {} : { dagRunRunningCount: counts.dagRunRunningCount }),
            ...(counts.dagRunTotalCount === undefined ? {} : { dagRunTotalCount: counts.dagRunTotalCount }),
            ...(counts.dagRunCountsUnavailable === undefined ? {} : { dagRunCountsUnavailable: counts.dagRunCountsUnavailable }),
          },
          seq,
        };
      }
      // Only task/agent scalar-bearing deliveries establish that group's
      // count ordering; an envelope without them carries no aggregate
      // evidence to retain there.
      if (hasTaskGroupCounts) liveCountAdmissionRef.current = { counts, seq };
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
    setError: applyError,
    setMissingOriginal,
    setExternalWriteDetected,
    setSessionActive,
    setContextUsage,
    setCacheHitRate,
    setIsCompacting,
    setHistoryStatus,
    setCommands,
    setModels,
    setPendingApproval,
    setPendingQuestion,
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
    if (frame.type === "ready") applyRecovery(recoveryAfterReady(recoveryRef.current, frame.resumed));
    else if (frame.type === "entries") applyRecovery(recoveryAfterHistory(recoveryRef.current, frame.final !== false));
    else if (frame.type === "error") {
      applyRecovery(frame.code === "provider_disconnected"
        ? recoveryAfterProviderLoss(recoveryRef.current)
        : recoveryAfterError(recoveryRef.current, frame.code, frame.message, frame.command));
    }
    return baseHandleFrame(frame, connectionGeneration);
  };

  // Both domains reconcile per ID; touches outlive the bounded progress buffer.
  const beginActivityHydration = (): number => {
    const token = ++activityHydrationTokenRef.current;
    activityHydrationRef.current = {
      token,
      buffer: createActivityHydrationBuffer(),
      touchedDags: new Set(),
      touchedTasks: new Set(),
      requestedMs: Date.now(),
      requestSeq: liveActivitySequenceRef.current,
    };
    return token;
  };
  const cancelActivityHydration = (token: number): void => {
    if (activityHydrationRef.current?.token === token) activityHydrationRef.current = null;
  };
  const hydrateActivities = (token: number, task: unknown, dag: unknown, taskDigest?: unknown, taskOversized = false, dagDigest?: unknown): void => {
    const hydration = activityHydrationRef.current;
    if (hydration === null || hydration.token !== token) return;
    activityHydrationRef.current = null;
    let next = activitiesRef.current;
    next = applyTaskHistorySnapshot(next, task, hydration.touchedTasks, parseTaskDigest(taskDigest) ?? undefined, taskOversized, hydration.requestedMs);
    next = applyDagHistorySnapshot(next, dag, hydration.touchedDags);
    // Raw-only history is supported. Admit its count/availability group at
    // the request's position, before the optional digest overrides it and
    // newer live admissions are reasserted below.
    const dagCounts = parseDagCounts(dag);
    if (dagCounts !== null) next = applyCountAuthority(next, dagCounts, hydration.requestedMs);
    // The DAG digest carries the same exact agent aggregate as the task side;
    // backfill it when the task digest is absent or predates the agent pair so
    // hydration never leaves the pane on stale or missing count authority.
    const dagDigestParsed = parseDagDigest(dagDigest);
    next = applyCountAuthority(next, {
      ...(dagDigestParsed?.agentRunningCount === undefined ? {} : { taskAgentRunningCount: dagDigestParsed.agentRunningCount }),
      ...(dagDigestParsed?.agentTotalCount === undefined ? {} : { taskAgentTotalCount: dagDigestParsed.agentTotalCount }),
      ...(dagDigestParsed?.dagRunRunningCount === undefined ? {} : { dagRunRunningCount: dagDigestParsed.dagRunRunningCount }),
      ...(dagDigestParsed?.dagRunTotalCount === undefined ? {} : { dagRunTotalCount: dagDigestParsed.dagRunTotalCount }),
      ...(dagDigestParsed?.dagRunCountsUnavailable === undefined ? {} : { dagRunCountsUnavailable: dagDigestParsed.dagRunCountsUnavailable }),
    }, hydration.requestedMs);
    for (const event of hydration.buffer.events) {
      // Accepted DAG snapshots already exist in current state. Replacing again
      // would remove REST-only rows or reverse both-unknown legacy ordering.
      if (event.name !== "omo.dag.updated" && event.name !== "omo.task.updated") next = applyActivityEvent(next, event.name, event.data);
      // Snapshot count authority still applies: a live or replayed frame that
      // landed while hydration was in flight carries the accepted revision
      // state, which a slower historical digest must not pin over with stale
      // zeros.
      else {
        const counts = event.name === "omo.task.updated"
          ? parseTaskCounts(event.data)
          : parseDagCounts(event.data);
        if (counts !== null) next = applyCountAuthority(next, counts, Date.now());
      }
    }
    // A live count delivery accepted after this request was registered
    // outranks the response even when the bounded buffer dropped the snapshot
    // frame that carried it, or the live frame changed counts without a
    // retained-row mutation: re-assert the winning aggregate at admission
    // time so the older snapshot cannot resurrect superseded scalars.
    const live = liveCountAdmissionRef.current;
    if (live !== null && live.seq > hydration.requestSeq) {
      next = applyCountAuthority(next, live.counts, Date.now());
    }
    // Re-assert the DAG-run group last: its accepted ordering survives
    // unrelated deliveries and buffer eviction, so this older response can
    // never leave the newer accepted pair lowered.
    const liveDagRun = dagRunCountAdmissionRef.current;
    if (liveDagRun !== null && liveDagRun.seq > hydration.requestSeq) {
      next = applyCountAuthority(next, liveDagRun.counts, Date.now());
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
      if (pageBuffer.historyRootKnown()) {
        const marks = steerMarks(sessionId);
        const ordinal = Math.max(messagesRef.current.filter(message => message.role === "user").length, ...marks.map(mark => mark.ordinal)) + 1;
        recordSteerMark(sessionId, { requestId, text, ordinal });
      } else {
        // A bounded tail cannot resolve the root-relative ordinal; retain the
        // occurrence and resolve it when the history completes.
        pendingSteersRef.current = [...pendingSteersRef.current, { requestId, text, sessionId }];
      }
    }
    let accepted = false;
    try {
      accepted = client.send(kind === "steer"
        ? { type: "chat.send", sessionId, requestId, run: { kind: "steer", message: text } }
        : chatState.queuedSendFrame({ text, image: draft.image }, requestId, sessionId));
    } catch (error) {
      applyError(error instanceof Error ? error.message : String(error));
    } finally {
      submitLatchRef.current = false;
    }
    // Incoming callbacks already advanced the registered operation. Never
    // resurrect a terminal operation or undo independently received messages.
    if (sends.terminal(requestId)) return true;
    if (!accepted) {
      sends.rollback(requestId);
      if (kind === "steer") {
        forgetSteerMark(sessionId, requestId);
        pendingSteersRef.current = pendingSteersRef.current.filter(pending => pending.requestId !== requestId);
      }
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
    resumeCoverage.current.reconnect();
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
    // A new socket makes a previous transport error stale — the same
    // reasoning beginResync already applies to its own reset.
    applyError("");
    setSessionActive(false);
    setConnected(true);
    pageBuffer.reset();
    pendingSteersRef.current = [];
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
    // The malformed-frame banner belongs to the transport that just died;
    // any other error survives for its own surface to resolve.
    if (parseErrorRef.current) applyError("");
    setConnected(false);
  };

  const beginExternalWriteRecovery = (): void => {
    resumeCoverage.current.reset();
    todoAuthorityRef.current = unbindTodoAuthority(todoAuthorityRef.current);
    externalRecoveryPendingRef.current = true;
    externalRecoveryReadyRef.current = false;
    externalRecoveryHistoryRef.current = false;
    historyLoadedRef.current = false;
    pageBuffer.reset();
    pendingSteersRef.current = [];
    setHistoryStatus("loading");
    applyError("");
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
    sessionActive,
    setSessionActive,
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
    pendingQuestion,
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
    getHistoryResume: () => resumeCoverage.current.cursor(),
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
    setPendingQuestion,
    reportError: applyError,
    reportParseError,
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
