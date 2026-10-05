import { useEffect, useRef, useState } from "react";
import { queueClearFrame, queueMoveFrame, queueRemoveFrame, type ChatClient, type ChatClientFrame, type ChatConnector, type CommandEntry } from "../../lib/chatWs";
import type { ChatSessionRef } from "../workspace/workspace";
import { useT } from "../../i18n";
import { newUuid } from "../../lib/uuid";
import { isFallbackApprovalFrame } from "../../lib/chatWsParseFallback";
import type { ChatDraft } from "./chatSessionTypes";
import type { ApprovalResponse } from "./QuestionWindow";
import type { ApprovalProgressFrame } from "../../lib/contract/types_gen";
import { getChatActivity } from "./activityHistory";
import { getChatGoal, type ChatGoal } from "./goalState";
import { COMPACT_COMMAND, isCuratedCompact, isCuratedReload, RELOAD_COMMAND } from "./curatedCommands";
import { useChatFrameState } from "./useChatFrameState";
import { useOlderHistory } from "./useOlderHistory";
import { bindAttachedBadgeSource, ingestExtensionEvent, releaseAttachedBadgeSource } from "../workspace/liveBadgeStore";

export function useChatSession(
  session: ChatSessionRef,
  connect: ChatConnector,
  onChatName?: (name: string, origin: "auto" | "user" | "provider") => void,
) {
  const frameState = useChatFrameState(session);
  const { t } = useT();
  const [goal, setGoal] = useState<ChatGoal | null>(null);
  const bindingKey = `${session.wsId}\u0000${session.id}`;
  const [activityBinding, setActivityBinding] = useState({ key: "", generation: 0 });
  const goalPushedRef = useRef(false);
  const clientRef = useRef<ChatClient | null>(null);
  const connectionGenerationRef = useRef(0);
  const releaseBadgeSourceRef = useRef<() => void>(() => undefined);
  const frameHandlerRef = useRef<typeof frameState.handleFrame>(() => undefined);
  const onChatNameRef = useRef(onChatName);
  const markOpenRef = useRef<() => number>(() => 0);
  const markCloseRef = useRef<() => void>(() => undefined);
  const historyResumeRef = useRef(frameState.getHistoryResume);
  historyResumeRef.current = frameState.getHistoryResume;
  const requestSeqRef = useRef(0);
  // Receipt objects remain the owners while their responses are in flight.
  // A new receipt supersedes a surface even when it is optimistically empty.
  const requestOwners = useRef<{
    approval: { readonly id: string; readonly generation: number } | null;
  }>({ approval: null });
  const progressTimers = useRef(new Map<string, { readonly timer: number; latest: Pick<ApprovalProgressFrame, "answers" | "comment"> }>());
  const cancelQuestionProgress = (key: string): void => {
    const pending = progressTimers.current.get(key);
    if (pending) window.clearTimeout(pending.timer);
    progressTimers.current.delete(key);
  };
  frameHandlerRef.current = frameState.handleFrame;
  onChatNameRef.current = onChatName;
  markOpenRef.current = frameState.markOpen;
  markCloseRef.current = frameState.markClose;
  const nextRequestId = (): string => `req-${session.id}-${++requestSeqRef.current}`;
  const nextSendRequestId = (): string => newUuid();
  const olderHistory = useOlderHistory(session, frameState, () => recreateHistory());

  useEffect(() => {
    let opened = false;
    let socketConnection = 0;
    let socketInstanceId: string | undefined;
    let socketDurableSessionId: string | undefined;
    const attemptToken = {};
    const releaseBadgeSource = (): void => {
      releaseAttachedBadgeSource(attemptToken);
      socketDurableSessionId = undefined;
    };
    releaseBadgeSourceRef.current = releaseBadgeSource;
    const createFrame = { type: "chat.create" as const, wsId: session.wsId, chatId: session.id };
    // The server publishes the socket binding only after the provider session
    // opens (see the ready frame). A chat.stats sent before that is rejected
    // with session_mismatch, so the initial stats request waits for ready and
    // fires at most once per connection.
    let initialStatsSent = false;
    const sendInitialFrames = (client: ChatClient, reconnected = false): void => {
      releaseBadgeSourceRef.current();
      socketDurableSessionId = undefined;
      const resume = reconnected ? historyResumeRef.current() : undefined;
      client.send({ ...createFrame, ...(resume ? { resume } : {}) });
    };
    const client = connect({
      getHistoryResume: () => historyResumeRef.current(),
      onAttempt: (connection) => {
        releaseBadgeSourceRef.current();
        socketConnection = connection;
        socketInstanceId = undefined;
        socketDurableSessionId = undefined;
      },
      onOpen: (connection) => {
        if (connection !== undefined && connection < socketConnection) return;
        if (connection === undefined || connection !== socketConnection) {
          releaseBadgeSourceRef.current();
          socketConnection = connection ?? socketConnection + 1;
          socketInstanceId = undefined;
          socketDurableSessionId = undefined;
        }
        const reconnected = opened;
        opened = true;
        connectionGenerationRef.current = markOpenRef.current();
        if (clientRef.current) {
          sendInitialFrames(clientRef.current, reconnected);
          // Reconnects replay the activity cache: the server answers with the
          // extensionEvent frames missed while the socket was down. The initial
          // open skips it - the attach flow delivers the snapshots itself.
          if (reconnected) clientRef.current.send({ type: "activity.refresh", sessionId: session.id });
        }
      },
      onHello: (instanceId, connection) => {
        if (connection !== undefined && connection !== socketConnection) return;
        socketInstanceId = instanceId;
      },
      onFrame: (frame, connection) => {
        if (connection !== undefined && connection !== socketConnection) return;
        if (frame.sessionId !== undefined && frame.sessionId !== session.id) return;
        if (frame.type === "ready") {
          socketDurableSessionId = frame.piSessionId ?? undefined;
          bindAttachedBadgeSource(frame.sessionId, {
            attemptToken,
            instanceId: socketInstanceId,
            connection: connection ?? socketConnection,
            currentConnection: socketConnection,
            bindingId: frame.bindingId,
            durableSessionId: socketDurableSessionId,
          });
        }
        if (frame.type === "error" && frame.code === "session_unloaded" && !frame.requestId) {
          releaseBadgeSourceRef.current();
          socketDurableSessionId = undefined;
        }
        if (frame.type === "extensionEvent") {
          ingestExtensionEvent(frame.sessionId, frame.name, frame.data, {
            attemptToken,
            instanceId: socketInstanceId,
            connection: connection ?? socketConnection,
            currentConnection: socketConnection,
            bindingId: frame.bindingId,
            durableSessionId: socketDurableSessionId,
          }, frame.revision);
        }
        if (frame.type === "approval") {
          if (isFallbackApprovalFrame(frame) || frame.method !== "question") {
            requestOwners.current.approval = { id: frame.id, generation: ++requestSeqRef.current };
          } else if (requestOwners.current.approval?.id === frame.id) {
            requestOwners.current.approval = null;
          }
        }
        if (frame.type === "ready") {
          setActivityBinding((current) => current.key === bindingKey
            ? { key: bindingKey, generation: current.generation + 1 }
            : { key: bindingKey, generation: 1 });
          if (!initialStatsSent) {
            initialStatsSent = true;
            clientRef.current?.send({ type: "chat.stats", sessionId: session.id });
          }
        }
        if (frame.type === "chat.goal") {
          // Live goal push while attached: a push always outranks the
          // attach-time REST fetch that may still be in flight.
          goalPushedRef.current = true;
          setGoal(frame.goal);
          return;
        }
        if (frame.type === "chat.name") {
          onChatNameRef.current?.(frame.name, frame.origin);
          return;
        }
        if (frameHandlerRef.current(frame, connectionGenerationRef.current) === "refresh_stats") {
          clientRef.current?.send({ type: "chat.stats", sessionId: session.id });
        }
        if (frame.type === "approval.resolved" || frame.type === "questions.snapshot") {
          const pendingKeys = new Set(frameState.getPendingQuestions().map(question => question.requestId ?? question.id));
          for (const key of progressTimers.current.keys()) {
            if (!pendingKeys.has(key)) cancelQuestionProgress(key);
          }
        }
      },
      onParseError: (raw) => {
        // WebKit delivers a truncated payload to JS as a message right before
        // the close fires; keep the dropped text diagnosable in the console.
        console.warn("[chatWs] non-JSON frame dropped", raw.slice(0, 500));
        frameState.reportParseError(t("chat.malformedFrame"));
      },
      onClose: (_code, connection) => {
        if (connection !== undefined && connection !== socketConnection) return;
        for (const key of progressTimers.current.keys()) cancelQuestionProgress(key);
        releaseBadgeSourceRef.current();
        socketConnection += 1;
        socketInstanceId = undefined;
        socketDurableSessionId = undefined;
        markCloseRef.current();
      },
    });
    clientRef.current = client;
    if (opened) sendInitialFrames(client);
    return () => {
      releaseBadgeSourceRef.current();
      socketConnection += 1;
      socketInstanceId = undefined;
      socketDurableSessionId = undefined;
      markCloseRef.current();
      for (const key of progressTimers.current.keys()) cancelQuestionProgress(key);
      client.close();
      clientRef.current = null;
    };
  }, [connect, session.id, session.wsId]);

  // Attach-time goal hydration: the REST fetch establishes the
  // initial state; a chat.goal push that arrives while the request is in
  // flight is newer, so the response is dropped in that case.
  useEffect(() => {
    const ctrl = new AbortController();
    goalPushedRef.current = false;
    setGoal(null);
    void getChatGoal(session.wsId, session.id, ctrl.signal).then(
      (next) => {
        if (!goalPushedRef.current) setGoal(next);
      },
      () => undefined,
    );
    return () => ctrl.abort();
  }, [session.id, session.wsId]);

  useEffect(() => {
    if (activityBinding.key !== bindingKey || activityBinding.generation === 0) return undefined;
    const ctrl = new AbortController();
    const token = frameState.beginActivityHydration();
    void getChatActivity(session.wsId, session.id, ctrl.signal).then(
      (activity) => frameState.hydrateActivities(token, activity.history.task, activity.history.dag, activity.taskDigest, activity.history.taskOversized, activity.dagDigest),
      () => frameState.cancelActivityHydration(token),
    );
    return () => {
      ctrl.abort();
      frameState.cancelActivityHydration(token);
    };
  }, [activityBinding, bindingKey, session.id, session.wsId]);

  useEffect(() => {
    if (frameState.doneReason === null) return;
    clientRef.current?.send({ type: "chat.stats", sessionId: session.id });
  }, [frameState.doneReason, session.id]);

  // Backgrounded tabs miss activity events (mobile may suspend the socket);
  // on return to visible, ask the server to replay its cached activity frames
  // so the shelf catches up immediately. No-op without an attached session.
  useEffect(() => {
    const onVisibility = (): void => {
      if (document.visibilityState !== "visible") return;
      clientRef.current?.send({ type: "activity.refresh", sessionId: session.id });
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [session.id]);

  const sendControl = (frame: ChatClientFrame, failureMessage: string): boolean => {
    const client = clientRef.current;
    if (!client) {
      frameState.reportError(failureMessage);
      return false;
    }
    try {
      if (!client.send(frame)) {
        frameState.reportError(failureMessage);
        return false;
      }
      frameState.reportError("");
      return true;
    } catch (error) {
      frameState.reportError(error instanceof Error && error.message ? error.message : failureMessage);
      return false;
    }
  };

  const submit = (draft: ChatDraft): boolean => {
    const text = draft.text.trim();
    const exactCompact = text === `/${COMPACT_COMMAND.name}` && draft.image === null;
    const providerOwnsCompact = frameState.commands.some((command) => command.name === COMPACT_COMMAND.name);
    // Palette identity survives insertion and queuing. A manually typed exact
    // /compact remains the curated action only while the provider has not
    // advertised an authoritative same-name command.
    if (exactCompact && (draft.command ? isCuratedCompact(draft.command) : !providerOwnsCompact)) return compact();
    // Exact /reload is the header's reload action, never a prompt. resync()
    // owns the busy guards and reports them, so a refused reload keeps the
    // draft in the composer instead of queuing "/reload" for the model.
    if (isLocalReload(text, draft)) return resync();
    if (frameState.running || frameState.isCompacting) {
      // The server owns the run-time queue: send a plain prompt for the bridge
      // to enqueue; the queue frame publishes the item to the panel.
      return frameState.queueSend(draft, nextSendRequestId(), session.id, clientRef.current);
    }
    return frameState.submit(draft, nextSendRequestId(), session.id, clientRef.current);
  };

  const queueRemove = (itemId: string): boolean =>
    sendControl(queueRemoveFrame(session.id, itemId), "Failed to remove the queued item.");

  const queueMove = (itemId: string, toIndex: number): boolean =>
    sendControl(queueMoveFrame(session.id, itemId, toIndex), "Failed to reorder the queue.");

  const queueClear = (scope: "webchat" | "engine" | "all"): boolean =>
    sendControl(queueClearFrame(session.id, scope), "Failed to clear the queue.");

  const compact = (): boolean => {
    if (frameState.running) {
      frameState.reportError(t("chat.compactWhileResponding"));
      return false;
    }
    if (frameState.isCompacting) {
      frameState.reportError(t("chat.compactInProgress"));
      return false;
    }
    return sendControl({ type: "chat.compact", sessionId: session.id }, "Failed to start compaction.");
  };

  const providerOwnsReload = (): boolean =>
    frameState.commands.some((command) => command.name === RELOAD_COMMAND.name);

  const isLocalReload = (text: string, draft: ChatDraft): boolean =>
    text === `/${RELOAD_COMMAND.name}` && draft.image === null
    && (draft.command ? isCuratedReload(draft.command) : !providerOwnsReload());

  const steer = (text: string, command: CommandEntry | null = null): boolean => {
    // A mid-run "/reload" would otherwise be steered into the model as text;
    // route it to resync(), which refuses while responding and says why.
    // Same identity-first predicate as submit: the palette selection decides,
    // so a curated /reload stays local even after the provider advertises its
    // own reload, and a provider-selected reload steers even after the
    // advertisement is dropped. Manually typed /reload keeps the
    // provider-ownership rule. Images never ride the steer path.
    if (isLocalReload(text.trim(), { text, image: null, ...(command ? { command } : {}) })) return resync();
    return frameState.steer(text, nextSendRequestId(), session.id, clientRef.current);
  };

  const stop = (): boolean => sendControl({ type: "chat.abort", sessionId: session.id }, "Failed to stop the current run.");

  const disconnect = (): boolean => {
    releaseBadgeSourceRef.current();
    return sendControl({ type: "chat.disconnect", sessionId: session.id }, "Failed to disconnect the session.");
  };

  const reloadExternalWrite = (): boolean => {
    releaseBadgeSourceRef.current();
    frameState.beginExternalWriteRecovery();
    const client = clientRef.current;
    try {
      const sent = client !== null
        && client.send({ type: "chat.create", wsId: session.wsId, chatId: session.id, recovery: true });
      if (!sent) frameState.failExternalWriteRecovery();
      return sent;
    } catch {
      frameState.failExternalWriteRecovery();
      return false;
    }
  };

  // Explicit retry for an in-place session rejected as session-active: the
  // user authorizes the activity gate bypass for this one attach.
  const forceOpen = (): boolean => {
    releaseBadgeSourceRef.current();
    frameState.beginExternalWriteRecovery();
    frameState.setSessionActive(false);
    const client = clientRef.current;
    try {
      const sent = client !== null
        && client.send({ type: "chat.create", wsId: session.wsId, chatId: session.id, force: true });
      if (!sent) {
        frameState.failExternalWriteRecovery();
        frameState.setSessionActive(true);
      }
      return sent;
    } catch {
      frameState.failExternalWriteRecovery();
      frameState.setSessionActive(true);
      return false;
    }
  };

  // Manual history refresh for a session advanced by another client: close
  // and immediately re-create the same binding so the server replays its
  // attach-time history hydration. Never mid-run — the rebind would tear
  // down a live turn — and the busy marker ends at the ready or terminal
  // entries frame, or on a terminal history error.
  const resync = (): boolean => {
    if (!frameState.canRecreateHistory()) return false;
    if (frameState.running) {
      frameState.reportError(t("chat.resyncBusyResponding"));
      return false;
    }
    if (frameState.isCompacting) {
      frameState.reportError(t("chat.resyncBusyCompacting"));
      return false;
    }
    return recreateHistory();
  };

  // History retries and stale-page recovery re-create this socket binding;
  // they do not abort the provider's run.
  const recreateHistory = (): boolean => {
    if (!frameState.canRecreateHistory()) return false;
    frameState.beginResync();
    releaseBadgeSourceRef.current();
    if (!sendControl({ type: "chat.close", sessionId: session.id }, t("chat.resyncError"))) {
      frameState.failResync();
      return false;
    }
    if (!sendControl({ type: "chat.create", wsId: session.wsId, chatId: session.id }, t("chat.resyncError"))) {
      frameState.failResync();
      return false;
    }
    return true;
  };
  const retryHistory = (): void => {
    if (frameState.messages.length === 0) recreateHistory();
    else resync();
  };

  const changeThinkingLevel = (level: string): boolean => {
    const restore = frameState.confirmedThinkingLevel();
    const requestId = nextRequestId();
    if (!frameState.armControl(
      requestId,
      "set_thinking_level",
      () => frameState.applyConfirmedThinkingLevel(restore),
      () => frameState.applyConfirmedThinkingLevel(level),
    )) return false;
    frameState.setThinkingLevel(level);
    if (!sendControl(
      { type: "chat.set", sessionId: session.id, requestId, ...(level ? { thinkingLevel: level } : {}) },
      "Failed to send thinking level change.",
    )) {
      frameState.rejectControl(requestId);
      return false;
    }
    return true;
  };

  const changeModel = (value: string): boolean => {
    const separator = value.indexOf("/");
    if (separator <= 0) return false;
    const model = { provider: value.slice(0, separator), modelId: value.slice(separator + 1) };
    const modelKey = `${model.provider}/${model.modelId}`;
    const restore = frameState.confirmedModelKey();
    const requestId = nextRequestId();
    if (!frameState.armControl(
      requestId,
      "set_model",
      () => frameState.applyConfirmedModelKey(restore),
      () => frameState.applyConfirmedModelKey(modelKey),
    )) return false;
    frameState.setCurrentModelKey(modelKey);
    if (!sendControl({ type: "chat.set", sessionId: session.id, requestId, model }, "Failed to send model change.")) {
      frameState.rejectControl(requestId);
      return false;
    }
    return true;
  };

  const respondRequest = (id: string | undefined, response: ApprovalResponse): boolean => {
    const approval = frameState.pendingApproval?.id === id ? frameState.pendingApproval : null;
    const question = frameState.getPendingQuestions().find(candidate => candidate.id === id);
    if (!approval && !question) return false;
    if (question?.delivery === "sending") return false;
    const approvalOwner = requestOwners.current.approval;
    const requestId = nextRequestId();
    if (!frameState.armControl(
      requestId,
      {
        key: approval ? `extension_ui_response:${id}:${approvalOwner?.generation}` : `extension_ui_response:${id}`,
        ownsRestore: () => approval
          ? requestOwners.current.approval === approvalOwner
          : frameState.getPendingQuestions().some(candidate => candidate.id === id),
      },
      () => {
        if (approval && requestOwners.current.approval === approvalOwner) frameState.setPendingApproval(approval);
        if (question) frameState.restoreQuestion(question.id, question);
      },
      () => undefined,
    )) return false;
    if (approval) frameState.setPendingApproval(null);
    if (question) {
      cancelQuestionProgress(question.requestId ?? question.id);
      frameState.markQuestionSending(question.id);
    }
    if (!sendControl({
      type: "approval.respond",
      sessionId: session.id,
      requestId,
      id: (approval ?? question)?.id ?? "",
      ...response,
    }, "Failed to send approval response.")) {
      frameState.rejectControl(requestId);
      return false;
    }
    return true;
  };

  const reportQuestionProgress = (id: string, draft: Pick<ApprovalProgressFrame, "answers" | "comment">): void => {
    const question = frameState.getPendingQuestions().find(candidate => candidate.id === id);
    if (!question || question.delivery === "sending") return;
    const key = question.requestId ?? question.id;
    const pending = progressTimers.current.get(key);
    if (pending) {
      pending.latest = draft;
      return;
    }
    const entry = { latest: draft, timer: window.setTimeout(() => {
      progressTimers.current.delete(key);
      const current = frameState.getPendingQuestions().find(candidate => (candidate.requestId ?? candidate.id) === key);
      if (current && current.delivery !== "sending") {
        clientRef.current?.send({ type: "approval.progress", sessionId: session.id, id: current.id, ...entry.latest });
      }
    }, 1_000) };
    progressTimers.current.set(key, entry);
  };
  const questionIdForKey = (key: string): string | undefined =>
    frameState.getPendingQuestions().find(question => (question.requestId ?? question.id) === key)?.id;

  const resendQuestion = (id: string): boolean => {
    const question = frameState.getPendingQuestions().find(candidate => candidate.id === id);
    return question?.delivery === "failed" && question.submittedAnswer !== undefined
      ? respondRequest(id, question.submittedAnswer) : false;
  };

  return {
    messages: frameState.messages,
    streaming: frameState.streaming,
    thinking: frameState.thinking,
    toolCalls: frameState.toolCalls,
    running: frameState.running,
    serverRunning: frameState.serverRunning,
    sendRequests: frameState.sendRequests,
    dismissSendRequest: frameState.dismissSendRequest,
    doneReason: frameState.doneReason,
    error: frameState.error,
    missingOriginal: frameState.missingOriginal,
    externalWriteDetected: frameState.externalWriteDetected,
    sessionActive: frameState.sessionActive,
    contextUsage: frameState.contextUsage,
    cacheHitRate: frameState.cacheHitRate,
    isCompacting: frameState.isCompacting,
    historyLoaded: frameState.historyLoaded,
    historyStatus: frameState.historyStatus,
    historyWarming: frameState.historyWarming,
    historyRootKnown: frameState.historyRootKnown,
    historyFailedEmpty: frameState.historyFailedEmpty,
    olderHistory,
    retryHistory,
    connected: frameState.connected,
    recovery: frameState.recovery,
    commands: frameState.commands,
    thinkingLevel: frameState.thinkingLevel,
    models: frameState.models,
    currentModelKey: frameState.currentModelKey,
    pendingApproval: frameState.pendingApproval,
    pendingQuestions: frameState.pendingQuestions,
    shownQuestion: frameState.shownQuestion,
    cycleQuestion: frameState.cycleQuestion,
    questionEndedSignal: frameState.questionEndedSignal,
    blockingQuestionPending: frameState.blockingQuestionPending,
    restoreVersion: frameState.restoreVersion,
    retryDraft: frameState.retryDraft,
    failedDrafts: frameState.failedDrafts,
    recoverFailedDraft: frameState.recoverFailedDraft,
    sendError: frameState.sendError,
    dismissSendError: frameState.dismissSendError,
    queueItems: frameState.queueItems,
    queueEngine: frameState.queueEngine,
    queuePlaceholders: frameState.queuePlaceholders,
    steerPending: frameState.steerPending,
    queueRemove,
    queueMove,
    queueClear,
    activities: frameState.activities,
    activitiesVersion: frameState.activitiesVersion,
    goal,
    notices: frameState.notices,
    submit,
    compact,
    steer,
    stop,
    disconnect,
    reloadExternalWrite,
    forceOpen,
    resync,
    resyncBusy: frameState.resyncBusy,
    resyncDisabled: frameState.resyncDisabled,
    changeThinkingLevel,
    changeModel,
    respondApproval: (response: ApprovalResponse) => respondRequest(frameState.pendingApproval?.id, response),
    respondQuestion: (id: string, response: ApprovalResponse) => respondRequest(id, response),
    respondQuestionByKey: (key: string, response: ApprovalResponse) => {
      const id = questionIdForKey(key);
      return id !== undefined && respondRequest(id, response);
    },
    reportQuestionProgress,
    reportQuestionProgressByKey: (key: string, draft: Pick<ApprovalProgressFrame, "answers" | "comment">) => {
      const id = questionIdForKey(key);
      if (id !== undefined) reportQuestionProgress(id, draft);
    },
    cancelQuestionProgressByKey: cancelQuestionProgress,
    resendQuestion,
  };
}
