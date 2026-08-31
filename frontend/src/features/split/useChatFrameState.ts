import { useRef, useState } from "react";
import type { ChatClient, CommandEntry, ContextUsage, JsonObject, ResumeCandidate } from "../../lib/chatWs";
import type { ApprovalRequest } from "./ApprovalModal";
import { useConfirmedControls } from "./chatConfirmedControls";
import { type UiMessage } from "./chatEntries";
import { emptyActivityState } from "./activityState";
import type { ActivityState } from "./activityTypes";
import { useEntriesPageBuffer } from "./useEntriesPageBuffer";
import { useStreamingBuffer } from "./useStreamingBuffer";
import * as chatState from "./chatSessionState";
import type { ChatDraft, ToolEntry } from "./chatSessionTypes";
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

/** One server advisory shown as a dismissible banner above the transcript. */
export interface ChatNotice {
  readonly id: number;
  readonly kind: string;
  readonly payload: JsonObject | null;
  readonly at: number;
}

/** Newest-first cap on the visible advisory stack. */
const NOTICE_LIMIT = 5;

export function useChatFrameState() {
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
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  const [cacheHitRate, setCacheHitRate] = useState<number | null>(null);
  const [isCompacting, setIsCompacting] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [connected, setConnected] = useState(false);
  const [commands, setCommands] = useState<readonly CommandEntry[]>([]);
  const [models, setModels] = useState<readonly { readonly provider: string; readonly modelId: string; readonly name?: string; readonly input?: readonly string[] }[]>([]);
  const [pendingApproval, setPendingApproval] = useState<ApprovalRequest | null>(null);
  const [restoreVersion, setRestoreVersion] = useState(0);
  const [retryDraft, setRetryDraft] = useState<(ChatDraft & { readonly version: number }) | null>(null);
  const [activities, setActivities] = useState<ActivityState>(emptyActivityState);
  const [activitiesVersion, setActivitiesVersion] = useState(0);
  const [notices, setNotices] = useState<readonly ChatNotice[]>([]);
  const messagesRef = useRef<readonly UiMessage[]>([]);
  const runningRef = useRef(false);
  const submitLatchRef = useRef(false);
  const optimisticIdRef = useRef(0);
  const retryVersionRef = useRef(0);
  const pendingRef = useRef<chatState.PendingOptimistic[]>([]);
  const activeRunRef = useRef<chatState.PendingOptimistic | null>(null);
  const uncertainRunRef = useRef<chatState.PendingOptimistic | null>(null);
  const awaitingReconnectHistoryRef = useRef(false);
  const messageVersionRef = useRef(0);
  const snapshotVersionRef = useRef(0);
  const toolCallsRef = useRef<Readonly<Record<string, ToolEntry>>>({});
  const historyLoadedRef = useRef(false);
  const activitiesRef = useRef<ActivityState>(emptyActivityState());
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

  // Notices are newest-first and capped: a chatty server cannot flood the
  // pane, and no dismissed-by-age advisory is persisted anywhere.
  const pushNotice = (kind: string, payload: JsonObject | null): void => {
    setNotices((current) =>
      [{ id: ++noticeIdRef.current, kind, payload, at: Date.now() }, ...current].slice(0, NOTICE_LIMIT),
    );
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
    setRetryDraft({ text: run.text, image: run.image, version: ++retryVersionRef.current });
  };

  const handleFrame = createChatFrameHandler({
    controls,
    streaming,
    pageBuffer,
    messagesRef,
    runningRef,
    submitLatchRef,
    pendingRef,
    activeRunRef,
    uncertainRunRef,
    awaitingReconnectHistoryRef,
    messageVersionRef,
    snapshotVersionRef,
    toolCallsRef,
    historyLoadedRef,
    activitiesRef,
    retryVersionRef,
    replaceMessages,
    replaceToolCalls,
    applyActivities,
    clearLiveSurfaces,
    recoverLostRun,
    setThinking,
    setRunning,
    setDoneReason,
    setError,
    setMissingOriginal,
    setContextUsage,
    setCacheHitRate,
    setIsCompacting,
    setHistoryLoaded,
    setCommands,
    setModels,
    setPendingApproval,
    setRestoreVersion,
    setRetryDraft,
    pushNotice,
  });

  const submit = (draft: ChatDraft, sessionId: string, client: ChatClient | null): boolean => {
    const text = draft.text.trim();
    if (submitLatchRef.current || runningRef.current || (!text && !draft.image) || !client) return false;
    const pending = chatState.newPendingRun(draft, text, ++optimisticIdRef.current, historyLoadedRef.current, messagesRef.current);
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

  const steer = (text: string, sessionId: string, client: ChatClient | null): boolean => {
    const trimmed = text.trim();
    if (!trimmed || !client) return false;
    const sent = client.send(chatState.steerSendFrame(trimmed, sessionId));
    if (sent) {
      messageVersionRef.current += 1;
      replaceMessages([...messagesRef.current, chatState.steerMessage(trimmed)]);
    }
    return sent;
  };

  const markOpen = (): void => {
    snapshotVersionRef.current = messageVersionRef.current;
    awaitingReconnectHistoryRef.current = uncertainRunRef.current !== null;
    setConnected(true);
    pageBuffer.reset();
  };
  const markClose = (): void => {
    ledger.failAll();
    uncertainRunRef.current = chatState.uncertainRun(activeRunRef.current, pendingRef.current);
    awaitingReconnectHistoryRef.current = false;
    setConnected(false);
  };
  return {
    messages,
    streaming: streaming.streaming,
    thinking,
    toolCalls,
    running,
    doneReason,
    error,
    missingOriginal,
    contextUsage,
    cacheHitRate,
    isCompacting,
    historyLoaded,
    connected,
    commands,
    thinkingLevel: controls.thinkingLevel,
    models,
    currentModelKey: controls.currentModelKey,
    pendingApproval,
    restoreVersion,
    retryDraft,
    activities,
    activitiesVersion,
    notices,
    handleFrame,
    submit,
    steer,
    markOpen,
    markClose,
    setThinkingLevel: controls.setThinkingLevel,
    setCurrentModelKey: controls.setCurrentModelKey,
    setPendingApproval,
    reportError: setError,
    armControl: ledger.arm,
    rejectControl: ledger.reject,
    confirmedModelKey: controls.confirmedModelKey,
    confirmedThinkingLevel: controls.confirmedThinkingLevel,
    applyConfirmedModelKey: controls.applyConfirmedModelKey,
    applyConfirmedThinkingLevel: controls.applyConfirmedThinkingLevel,
  };
}
