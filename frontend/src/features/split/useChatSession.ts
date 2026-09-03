import { useEffect, useRef } from "react";
import type { ChatClient, ChatClientFrame, ChatConnector, ChatServerFrame } from "../../lib/chatWs";
import type { ChatSessionRef } from "../workspace/workspace";
import type { ChatDraft } from "./chatSessionTypes";
import { getChatActivity } from "./activityHistory";
import { COMPACT_COMMAND, isCuratedCompact } from "./curatedCommands";
import { useChatFrameState } from "./useChatFrameState";

export function useChatSession(
  session: ChatSessionRef,
  connect: ChatConnector,
  onChatName?: (name: string, origin: "auto" | "user" | "provider") => void,
) {
  const frameState = useChatFrameState();
  const clientRef = useRef<ChatClient | null>(null);
  const frameHandlerRef = useRef<(frame: ChatServerFrame) => void>(() => undefined);
  const onChatNameRef = useRef(onChatName);
  const markOpenRef = useRef<() => void>(() => undefined);
  const markCloseRef = useRef<() => void>(() => undefined);
  const requestSeqRef = useRef(0);
  frameHandlerRef.current = frameState.handleFrame;
  onChatNameRef.current = onChatName;
  markOpenRef.current = frameState.markOpen;
  markCloseRef.current = frameState.markClose;
  const nextRequestId = (): string => `req-${session.id}-${++requestSeqRef.current}`;

  useEffect(() => {
    let opened = false;
    const createFrame = { type: "chat.create" as const, wsId: session.wsId, chatId: session.id };
    // The server publishes the socket binding only after the provider session
    // opens (see the ready frame). A chat.stats sent before that is rejected
    // with session_mismatch, so the initial stats request waits for ready and
    // fires at most once per connection.
    let initialStatsSent = false;
    const sendInitialFrames = (client: ChatClient): void => {
      client.send(createFrame);
    };
    const client = connect({
      onOpen: () => {
        const reconnected = opened;
        opened = true;
        markOpenRef.current();
        if (clientRef.current) {
          sendInitialFrames(clientRef.current);
          // Reconnects replay the activity cache: the server answers with the
          // extensionEvent frames missed while the socket was down. The initial
          // open skips it - the attach flow delivers the snapshots itself.
          if (reconnected) clientRef.current.send({ type: "activity.refresh", sessionId: session.id });
        }
      },
      onFrame: (frame) => {
        if (frame.sessionId !== undefined && frame.sessionId !== session.id) return;
        if (frame.type === "ready" && !initialStatsSent) {
          initialStatsSent = true;
          clientRef.current?.send({ type: "chat.stats", sessionId: session.id });
        }
        if (frame.type === "chat.name") {
          onChatNameRef.current?.(frame.name, frame.origin);
          return;
        }
        frameHandlerRef.current(frame);
      },
      onParseError: () => frameState.reportError("Received a malformed server frame."),
      onClose: () => markCloseRef.current(),
    });
    clientRef.current = client;
    if (opened) sendInitialFrames(client);
    return () => {
      client.close();
      clientRef.current = null;
    };
  }, [connect, session.id, session.wsId]);

  useEffect(() => {
    const ctrl = new AbortController();
    const token = frameState.beginActivityHydration();
    void getChatActivity(session.wsId, session.id, ctrl.signal).then(
      (activity) => frameState.hydrateActivities(token, activity.history.task, activity.history.dag),
      () => undefined,
    );
    return () => ctrl.abort();
  }, [session.id, session.wsId]);

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
    if (frameState.isCompacting) {
      frameState.reportError("Cannot send a prompt while the conversation is compacting.");
      return false;
    }
    return frameState.submit(draft, session.id, clientRef.current);
  };

  const compact = (): boolean => {
    if (frameState.running) {
      frameState.reportError("Cannot compact while the assistant is responding.");
      return false;
    }
    if (frameState.isCompacting) {
      frameState.reportError("Compaction is already in progress.");
      return false;
    }
    return sendControl({ type: "chat.compact", sessionId: session.id }, "Failed to start compaction.");
  };

  const steer = (text: string): boolean => frameState.steer(text, session.id, clientRef.current);

  const stop = (): boolean => sendControl({ type: "chat.abort", sessionId: session.id }, "Failed to stop the current run.");

  const disconnect = (): boolean => sendControl({ type: "chat.disconnect", sessionId: session.id }, "Failed to disconnect the session.");

  // Reopen an evicted/unloaded session: re-sending the same chat.create
  // frame the open/reconnect path uses makes the server resume the durable
  // chat from disk. The pane's unloaded banner clears on the state frame,
  // which proves get_state completed against a live provider route.
  const resume = (): boolean => {
    const client = clientRef.current;
    return client !== null
      && client.send({ type: "chat.create", wsId: session.wsId, chatId: session.id });
  };

  const reloadExternalWrite = (): boolean => {
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

  const respondApproval = (response: { value?: string; confirmed?: boolean; cancelled?: boolean }): boolean => {
    const request = frameState.pendingApproval;
    if (!request) return false;
    const requestId = nextRequestId();
    if (!frameState.armControl(
      requestId,
      "extension_ui_response",
      () => frameState.setPendingApproval(request),
      () => undefined,
    )) return false;
    frameState.setPendingApproval(null);
    if (!sendControl({
      type: "approval.respond",
      sessionId: session.id,
      requestId,
      id: request.id,
      ...response,
    }, "Failed to send approval response.")) {
      frameState.rejectControl(requestId);
      return false;
    }
    return true;
  };

  return {
    messages: frameState.messages,
    streaming: frameState.streaming,
    thinking: frameState.thinking,
    toolCalls: frameState.toolCalls,
    running: frameState.running,
    doneReason: frameState.doneReason,
    error: frameState.error,
    missingOriginal: frameState.missingOriginal,
    sessionUnloaded: frameState.sessionUnloaded,
    externalWriteDetected: frameState.externalWriteDetected,
    contextUsage: frameState.contextUsage,
    cacheHitRate: frameState.cacheHitRate,
    isCompacting: frameState.isCompacting,
    historyLoaded: frameState.historyLoaded,
    historyStatus: frameState.historyStatus,
    connected: frameState.connected,
    commands: frameState.commands,
    thinkingLevel: frameState.thinkingLevel,
    models: frameState.models,
    currentModelKey: frameState.currentModelKey,
    pendingApproval: frameState.pendingApproval,
    restoreVersion: frameState.restoreVersion,
    retryDraft: frameState.retryDraft,
    activities: frameState.activities,
    activitiesVersion: frameState.activitiesVersion,
    notices: frameState.notices,
    submit,
    compact,
    steer,
    stop,
    disconnect,
    resume,
    reloadExternalWrite,
    changeThinkingLevel,
    changeModel,
    respondApproval,
  };
}
