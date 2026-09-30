import type { ReactNode } from "react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { IconFolder, IconFolderOpen, IconMenu, IconPower, IconSplitH, IconSplitV, IconX } from "../../components/icons";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { ModalDialog } from "../../components/ModalDialog";
import type { ToastKind } from "../../components/SessionTree";
import { useT } from "../../i18n";
import type { ChatConnector } from "../../lib/chatWs";
import { FileBrowser } from "../terminal/FileBrowser";
import type { ChatSessionRef } from "../workspace/workspace";
import { QuestionNoticeBand } from "./QuestionNoticeBand";
import { QuestionWindow } from "./QuestionWindow";
import type { ApprovalRequest, ApprovalResponse } from "./QuestionWindow";
import { QuestionDraftProvider, questionDraftResponse, useApprovalQuestionDraft } from "./ApprovalDockQuestions";
import { approvalRequestOf } from "./chatSessionState";
import { questionKey } from "../../lib/chatWsParseApproval";
import { ActivityShelf } from "./ActivityShelf";
import { ChatComposer } from "./ChatComposer";
import { ExternalWriteBanner } from "./ExternalWriteBanner";
import { SessionActiveBanner } from "./SessionActiveBanner";
import { GoalBar } from "./GoalBar";
import { MissingOriginalBanner } from "./MissingOriginalBanner";
import { SendErrorBanner } from "./SendErrorBanner";
import { ModelPicker } from "./ModelPicker";
import { QueuePanel } from "./QueuePanel";
import { ChatTranscript } from "./ChatTranscript";
import type { SplitDir } from "./paneTree";
import { mergeTranscriptItems } from "./useChatFrameState";
import { sendErrorDetail } from "./useChatFrameHandler";
import { useChatSession } from "./useChatSession";
import { useUpdateDialog } from "./useUpdateDialog";

/** Every thinking level; an authoritative unknown value is still listed. */
const THINKING_LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const NARROW_PANE_MAX_WIDTH = 600;
const RECOVERY_LABEL_KEYS = {
  reconnecting: "chat.reconnecting",
  resuming: "chat.recoveryResuming",
  incomplete: "chat.recoveryIncomplete",
} as const;

type RequestWindowArrival = "open" | "close" | "preserve";

function useRequestWindow(requestId: string | null, arrival: RequestWindowArrival) {
  const [windowForId, setWindowForId] = useState<string | null>(null);
  const seenIdRef = useRef<string | null>(null);
  if (requestId !== seenIdRef.current) {
    seenIdRef.current = requestId;
    if (arrival === "open") setWindowForId(requestId);
    else if (arrival === "close") setWindowForId(null);
  }
  return [requestId !== null && windowForId === requestId, setWindowForId] as const;
}

interface QuestionSurfaceProps {
  readonly request: ApprovalRequest;
  readonly windowOpen: boolean;
  readonly onOpenWindow: () => void;
  readonly onCollapseWindow: () => void;
  readonly onRespond: (response: ApprovalResponse) => void;
  readonly focusComposer: () => void;
  /** Total pending questions (omo pendingOrder.length); >1 shows the count
   *  and a next-question control cycling the shown question. */
  readonly pendingCount?: number;
  readonly onNextQuestion?: () => void;
  /** Re-send the stored submitted answer after a failed delivery. */
  readonly onResend?: () => void;
}

/** One pending request's two surfaces: the notice band (always, while the
 *  request is pending) and the modal window (the answering surface). The
 *  band stays mounted behind the open window so closing it always lands on
 *  the band. */
function QuestionSurface({
  request,
  windowOpen,
  onOpenWindow,
  onCollapseWindow,
  onRespond,
  focusComposer,
  pendingCount,
  onNextQuestion,
  onResend,
}: QuestionSurfaceProps) {
  return (
    <>
      <QuestionNoticeBand
        request={request}
        onOpen={onOpenWindow}
        {...(pendingCount !== undefined ? { pendingCount } : {})}
        {...(onNextQuestion ? { onNextQuestion } : {})}
        {...(onResend ? { onResend } : {})}
      />
      <QuestionWindow
        request={request}
        open={windowOpen}
        onCollapse={onCollapseWindow}
        onRespond={onRespond}
        focusComposer={focusComposer}
        {...(pendingCount !== undefined ? { pendingCount } : {})}
        {...(onNextQuestion ? { onNextQuestion } : {})}
        {...(onResend ? { onResend } : {})}
      />
    </>
  );
}

export interface ChatPaneProps {
  readonly chatSession: ChatSessionRef;
  readonly focused: boolean;
  readonly resizeControl?: ReactNode;
  readonly splitEnabled: boolean;
  readonly onFocus: () => void;
  readonly onSplit: (dir: SplitDir) => void;
  readonly onClose: () => void;
  readonly onOpenSidebar: () => void;
  readonly onNewChat?: () => void;
  readonly connect: ChatConnector;
  readonly notify: (msg: string, kind?: ToastKind) => void;
  readonly onChatName?: (name: string, origin: "auto" | "user" | "provider") => void;
}

/** A render failure inside one pane shows this in place of the pane, so the
 *  sidebar and every other pane stay usable. */
function ChatPaneFallback({ error, retry, props }: {
  readonly error: Error;
  readonly retry: () => void;
  readonly props: ChatPaneProps;
}) {
  const { t } = useT();
  return (
    <section className={`th-stage th-pane th-chat-pane th-pane-error${props.focused ? " th-pane--focused" : ""}`}
      onPointerDown={props.onFocus}>
      <header className="th-termhead">
        {props.resizeControl}
        <button type="button" className="th-btn-icon th-mobile-menu" title={t("sidebar.expand")}
          aria-label={t("sidebar.expand")} onClick={props.onOpenSidebar}>
          <IconMenu size={16} />
        </button>
        <span className="th-termhead-name" title={props.chatSession.cwd}>{props.chatSession.name}</span>
      </header>
      <div className="th-pane-error-body" role="alert">
        <p className="th-pane-error-title">{t("chat.paneCrashed")}</p>
        <p className="th-pane-error-detail">{error.message}</p>
        <div className="th-pane-error-actions">
          <button type="button" className="th-btn th-btn--ghost th-pane-error-retry" onClick={retry}>
            {t("common.retry")}
          </button>
          <button type="button" className="th-btn th-btn--ghost th-pane-error-close" onClick={props.onClose}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </section>
  );
}

export function ChatPane(props: ChatPaneProps) {
  return (
    <ErrorBoundary fallback={(error, reset) => <ChatPaneFallback error={error} retry={reset} props={props} />}>
      <ChatPaneContent {...props} />
    </ErrorBoundary>
  );
}

function ChatPaneContent({
  chatSession,
  focused,
  resizeControl,
  splitEnabled,
  onFocus,
  onSplit,
  onClose,
  onOpenSidebar,
  onNewChat,
  connect,
  notify,
  onChatName,
}: ChatPaneProps) {
  const { t } = useT();
  const [pane, setPane] = useState<HTMLElement | null>(null);
  const [narrow, setNarrow] = useState(() => window.innerWidth <= NARROW_PANE_MAX_WIDTH);
  useLayoutEffect(() => {
    if (!pane || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setNarrow(entry.contentRect.width <= NARROW_PANE_MAX_WIDTH);
    });
    observer.observe(pane);
    return () => observer.disconnect();
  }, [pane]);
  const [showFiles, setShowFiles] = useState(false);
  const [filePanelWidth, setFilePanelWidth] = useState(320);
  const [showDisconnect, setShowDisconnect] = useState(false);
  const disconnectTitleId = useId();
  const originalTitleId = useId();
  const [inspectedOriginal, setInspectedOriginal] = useState<{ text: string; trigger: HTMLButtonElement } | null>(null);
  const chat = useChatSession(chatSession, connect, onChatName);
  const update = useUpdateDialog(chat.commands, chat.submit);
  // Question/approval surfaces: a one-line notice band in the column (where
  // the inline dock lived) plus a separate modal window per pending request.
  // A newly arrived request opens its window — the blocking surfaces' focus
  // takeover, the old dock's arrival expansion. Collapsing is keyed by
  // request id: a replay of the same id honours the user's collapse (or
  // keeps an open window open), while a new id re-opens. A non-blocking
  // question never auto-opens: its window opens only from the band, keeping
  // ordinary chat typing uninterrupted.
  const focusComposer = (): void => {
    pane?.querySelector<HTMLElement>(".th-chat-input textarea")?.focus();
  };
  const approvalId = chat.pendingApproval?.id ?? null;
  const [approvalWindowOpen, setApprovalWindowForId] = useRequestWindow(
    approvalId,
    approvalId === null ? "preserve" : "open",
  );
  const questionFrame = chat.shownQuestion;
  const questionId = questionFrame?.id ?? null;
  const [questionWindowOpen, setQuestionWindowForId] = useRequestWindow(
    questionId,
    questionFrame === null ? "close" : questionFrame.nonBlocking === true ? "preserve" : "open",
  );
  const questionRequest = questionFrame === null
    ? null
    : {
      ...approvalRequestOf({ ...questionFrame, method: "question" }),
      draftKey: questionFrame.requestId ?? questionFrame.id,
      ...(questionFrame.delivery ? { delivery: questionFrame.delivery } : {}),
      ...(questionFrame.deliveryError ? { deliveryError: questionFrame.deliveryError } : {}),
    };
  // The question draft is lifted into the pane (the provider below just
  // re-provides it) so the composer can answer with the current draft and
  // draft edits can be reported to omo as progress (IS-5).
  const questionDraftState = useApprovalQuestionDraft(
    questionFrame?.requestId ?? questionFrame?.id ?? "",
    questionFrame?.questions ?? [],
    questionFrame?.delivery === "failed" ? questionFrame.submittedAnswer : undefined,
    chat.pendingQuestions.map(question => question.requestId ?? question.id),
  );
  const questionDraft = questionDraftState[0];
  const lastProgressRef = useRef("");
  useEffect(() => {
    if (!questionFrame) {
      lastProgressRef.current = "";
      return;
    }
    const response = questionDraftResponse(questionDraft, questionFrame.questions ?? []);
    const serializedResponse = JSON.stringify(response);
    const serialized = JSON.stringify([questionFrame.requestId ?? questionFrame.id, response]);
    if (serialized === lastProgressRef.current) return;
    lastProgressRef.current = serialized;
    // An untouched draft carries nothing omo does not already know.
    if (serializedResponse === '{"answers":{}}') return;
    chat.reportQuestionProgress(questionFrame.id, response);
  }, [questionFrame, questionDraft, chat]);

  // A question whose delivery failed and that then ends without a resend was
  // answered or closed elsewhere: say so instead of vanishing silently.
  const lastQuestionDeliveryRef = useRef(new Map<string, string>());
  for (const question of chat.pendingQuestions) {
    lastQuestionDeliveryRef.current.set(question.id, question.delivery ?? "pending");
  }
  const [closedNoticeSeq, setClosedNoticeSeq] = useState(0);
  const [closedNoticeText, setClosedNoticeText] = useState("question.delivery.alreadyResolved");
  const endedSignal = chat.questionEndedSignal;
  useEffect(() => {
    if (!endedSignal) return;
    for (const ended of endedSignal.ended) {
      const delivery = lastQuestionDeliveryRef.current.get(ended.id);
      lastQuestionDeliveryRef.current.delete(ended.id);
      if (
        ended.outcome === "already_resolved" ||
        ended.outcome === "closed_while_disconnected" ||
        (delivery === "failed" && ended.outcome !== "answered" && ended.outcome !== "comment-submitted")
      ) {
        setClosedNoticeText(
          ended.outcome === "closed_while_disconnected"
            ? "question.delivery.closedWhileDisconnected"
            : "question.delivery.alreadyResolved",
        );
        setClosedNoticeSeq(endedSignal.seq);
      }
    }
  }, [endedSignal]);
  useEffect(() => {
    if (closedNoticeSeq === 0) return;
    const timer = setTimeout(() => setClosedNoticeSeq(0), 8_000);
    return () => clearTimeout(timer);
  }, [closedNoticeSeq]);

  // The composer's question destination (omo handleAskUserShortcut): the
  // shown question's first unanswered question provides the 1-9 options; a
  // collapsed blocking window forces reply mode.
  const composerQuestionTargets = chat.pendingQuestions.map(frame => {
    const key = frame.requestId ?? frame.id;
    const questions = frame.questions ?? [];
    const draft = key === (questionFrame?.requestId ?? questionFrame?.id)
      ? questionDraft : questionDraftState[2].get(key);
    const firstUnansweredIndex = questions.findIndex((question, index) => {
      const entry = draft?.answers.get(questionKey(question, index));
      return !entry || (entry.selected.length === 0 && entry.text.trim() === "");
    });
    const firstUnanswered = firstUnansweredIndex >= 0 ? questions[firstUnansweredIndex] : undefined;
    const response = () => {
      const saved = draft && questionDraftResponse(draft, questions);
      return frame.delivery === "failed" && frame.submittedAnswer
        && (!saved || (Object.keys(saved.answers).length === 0 && !saved.comment))
        ? frame.submittedAnswer : saved ?? { answers: {} };
    };
    return {
      key,
      id: frame.id,
      header: questions[0]?.header ?? frame.title ?? "",
      forceReply: frame.nonBlocking !== true && key === (questionFrame?.requestId ?? questionFrame?.id) && !questionWindowOpen,
      options: (firstUnanswered?.options ?? []).map((option) => option.label ?? ""),
      onAnswer: (comment: string): boolean => {
        return chat.respondQuestionByKey(key, { answers: response().answers, comment });
      },
      onProgress: (comment: string): void => {
        chat.reportQuestionProgressByKey(key, { answers: response().answers, comment });
      },
      onCancelProgress: () => chat.cancelQuestionProgressByKey(key),
      onPickOption: (optionIndex: number): void => {
        if (key !== (questionFrame?.requestId ?? questionFrame?.id) || firstUnansweredIndex < 0) return;
        const question = questions[firstUnansweredIndex];
        const label = question?.options?.[optionIndex]?.label;
        if (!question || !label) return;
        const answerKey = questionKey(question, firstUnansweredIndex);
        const [draft, setDraft] = questionDraftState;
        const previous = draft.answers.get(answerKey) ?? { selected: [], text: "", completed: false };
        setDraft({
          ...draft,
          activeIndex: firstUnansweredIndex,
          answering: false,
          answers: new Map(draft.answers).set(answerKey, {
            ...previous,
            invalidated: false,
            selected: question.multiSelect
              ? previous.selected.includes(label) ? previous.selected : [...previous.selected, label]
              : [label],
            completed: question.multiSelect !== true,
          }),
        });
        setQuestionWindowForId(frame.id);
      },
    };
  });
  const composerQuestionTarget = composerQuestionTargets.find(target =>
    target.key === (questionFrame?.requestId ?? questionFrame?.id)) ?? null;
  // Notices replay before history, so keep them gated until the monotonic
  // history lifecycle either completes or proves that history is unavailable.
  // Send-path command failures surface in the persistent banner below, so
  // they never also render as transcript notice blocks.
  const transcriptItems = useMemo(() => {
    const notices = chat.historyStatus !== "loading" ? chat.notices : [];
    // While the loaded range's root is unknown, a notice stamped earlier than
    // the first loaded message belongs to history no page has fetched yet;
    // rendering it now would pile it at the top of the transcript (G11). It
    // appears once its range is loaded. With the root known, every retained
    // notice is in range and renders exactly as before.
    // Parsed entries use 0 only as a display fallback for a missing time. An
    // unknown leading timestamp must not admit older notices before a real
    // timestamp establishes the loaded range.
    const boundary = chat.historyRootKnown ? undefined
      : chat.messages.find((message) => typeof message.ts === "number"
        && Number.isFinite(message.ts) && message.ts !== 0)?.ts;
    const inRange = chat.historyRootKnown || chat.messages.length === 0
      ? notices
      : boundary === undefined ? [] : notices.filter((notice) => notice.at >= boundary);
    return mergeTranscriptItems(
      // Zero-block assistant completions stay in transcript state (they anchor
      // current-turn tool results for run.done materialization, live and
      // restored alike) and therefore flow into the merged list unfiltered,
      // preserving notice placement around the authoritative message order.
      // ChatTranscript derives row identity from this unfiltered list and only
      // then hides blank rows, so an empty anchor appearing or disappearing
      // never shifts any other row's key — visible rows never remount.
      chat.messages,
      inRange,
    );
  }, [chat.messages, chat.notices, chat.historyStatus, chat.historyRootKnown]);
  const currentModel = chat.models.find((model) => `${model.provider}/${model.modelId}` === chat.currentModelKey);
  const imageSupported = currentModel ? (currentModel.input?.includes("image") ?? true) : true;
  const thinkingOptions = chat.thinkingLevel !== "" && !THINKING_LEVELS.includes(chat.thinkingLevel)
    ? [...THINKING_LEVELS, chat.thinkingLevel]
    : THINKING_LEVELS;

  const runState = !chat.connected ? "reconnecting" : chat.serverRunning ? "responding" : "idle";
  const runLabel = runState === "idle" ? undefined : t(`chat.${runState}`);
  // Distinct recovery phases (C3): the reconnecting run indicator alone
  // cannot tell a pending rebinding replay or a failed resume apart from a
  // plain drop. Incomplete recovery is always a warning with the server's
  // reason, never a normal or success treatment.
  const recoveryLabel = chat.recovery === null
    ? undefined
    : t(RECOVERY_LABEL_KEYS[chat.recovery.phase]);

  const modelPicker = (
    <ModelPicker
      compact={narrow}
      models={chat.models}
      currentModelKey={chat.currentModelKey}
      placeholder={t("chat.model")}
      searchPlaceholder={t("chat.searchModels")}
      onSelect={chat.changeModel}
      thinkingLevels={thinkingOptions}
      thinkingLevel={chat.thinkingLevel}
      thinkingLabel={t("chat.thinkingLevel")}
      onThinkingChange={chat.changeThinkingLevel}
    />
  );
  const resyncLabel = chat.resyncBusy ? t("chat.header.resyncBusy") : t("chat.header.resync");

  return (
    <section
      ref={setPane}
      className={`th-stage th-pane th-chat-pane${focused ? " th-pane--focused" : ""}`}
      onPointerDown={event => { if (event.target instanceof Node && event.currentTarget.contains(event.target)) onFocus(); }}
      onFocus={event => { if (event.currentTarget.contains(event.target)) onFocus(); }}
    >
      <header className="th-termhead">
        {resizeControl}
        <button
          type="button"
          className="th-btn-icon th-mobile-menu"
          title={t("sidebar.expand")}
          aria-label={t("sidebar.expand")}
          onClick={onOpenSidebar}
        >
          <IconMenu size={16} />
        </button>
        <span className="th-termhead-name" title={chatSession.cwd}>{chatSession.name}</span>
        <span className="th-provider-badge" data-provider={chatSession.provider}>{chatSession.provider}</span>
        <div className="th-termhead-group">
          <button
            type="button"
            className={`th-btn-icon th-files-toggle${showFiles ? " th-files-toggle--on" : ""}`}
            title={t("chat.header.files")}
            aria-label={t("chat.header.files")}
            aria-pressed={showFiles}
            onClick={() => setShowFiles((visible) => !visible)}
          >
            {showFiles ? <IconFolderOpen size={16} /> : <IconFolder size={16} />}
          </button>
          <button
            type="button"
            className="th-btn th-btn--ghost th-btn-icon th-chat-resync-btn"
            title={resyncLabel}
            aria-label={resyncLabel}
            aria-busy={chat.resyncBusy}
            disabled={chat.resyncDisabled || chat.running || chat.isCompacting}
            onClick={() => chat.resync()}
          >
            <svg
              className="th-chat-resync-icon"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M20 11a8 8 0 0 0-14.9-4M4 4v5h5M4 13a8 8 0 0 0 14.9 4M20 20v-5h-5" />
            </svg>
          </button>
        </div>
        <span className="th-termhead-divider" aria-hidden="true" />
        <div className="th-termhead-actions">
          <button
            type="button"
            className="th-btn-icon th-btn-icon--danger th-disconnect-btn"
            title={t("chat.header.disconnect")}
            aria-label={t("chat.header.disconnect")}
            onClick={() => setShowDisconnect(true)}
          >
            <IconPower size={14} />
          </button>
          {splitEnabled && (
            <>
              <button type="button" className="th-btn-icon th-termhead-split-btn" title={t("chat.header.splitRight")} aria-label={t("chat.header.splitRight")} onClick={() => onSplit("h")}><IconSplitH size={14} /></button>
              <button type="button" className="th-btn-icon th-termhead-split-btn" title={t("chat.header.splitDown")} aria-label={t("chat.header.splitDown")} onClick={() => onSplit("v")}><IconSplitV size={14} /></button>
              <button type="button" className="th-btn-icon th-btn-icon--danger th-termhead-close-btn" title={t("chat.header.closePane")} aria-label={t("chat.header.closePane")} onClick={onClose}><IconX size={14} /></button>
            </>
          )}
        </div>
      </header>
      <div className="th-chat-main">
        <div className="th-chat-main-content">
        {chat.missingOriginal && <MissingOriginalBanner candidates={chat.missingOriginal.candidates} />}
        {chat.externalWriteDetected && <ExternalWriteBanner onReload={chat.reloadExternalWrite} />}
        {chat.sessionActive && <SessionActiveBanner onForceOpen={chat.forceOpen} />}
        {chat.sendError && (
          <SendErrorBanner
            detail={sendErrorDetail(chat.sendError)}
            onDismiss={chat.dismissSendError}
          />
        )}
        <ChatTranscript
          items={transcriptItems}
          historyLoaded={chat.historyLoaded}
          streaming={chat.streaming}
          thinking={chat.thinking}
          toolCalls={chat.toolCalls}
          doneReason={chat.doneReason}
          error={chat.missingOriginal ? "" : chat.error}
          restoreVersion={chat.restoreVersion}
          focused={focused}
          olderHistory={chat.olderHistory}
          historyFailedEmpty={chat.historyFailedEmpty}
          onRetryHistory={chat.retryHistory}
          mediaSource={{ wsId: chatSession.wsId, chatId: chatSession.id }}
        />
        <GoalBar goal={chat.goal} />
        <ActivityShelf activities={chat.activities} dagSource={{ wsId: chatSession.wsId, chatId: chatSession.id, connected: chat.connected }} />
        {/* Fixed queue slot: run-time pending feedback renders here, outside
        the transcript scrollport, anchored above the status strip/composer. */}
        <QueuePanel
          items={chat.queueItems}
          engine={chat.queueEngine}
          placeholders={chat.queuePlaceholders}
          onRemove={chat.queueRemove}
          onMove={chat.queueMove}
          onClear={chat.queueClear}
        />
        {chat.failedDrafts.length > 0 && (
          <div className="th-failed-drafts" role="group" aria-label={t("chat.failedSends")}>
            {chat.failedDrafts.map((draft) => (
              <span key={draft.requestId} className="th-failed-draft-item">
              <button
                type="button"
                title={draft.text || draft.image?.name}
                className="th-btn th-btn--ghost th-failed-draft"
                data-request-id={draft.requestId}
                data-send-phase="failed"
                onClick={() => chat.recoverFailedDraft(draft.requestId)}
              >
                {t("common.retry")}: {draft.text || draft.image?.name || t("chat.image")}
              </button>
              <button type="button" className="th-btn th-btn--ghost th-send-dismiss"
                data-dismiss-request-id={draft.requestId}
                onClick={() => chat.dismissSendRequest(draft.requestId)}>{t("common.close")}</button>
              </span>
            ))}
          </div>
        )}
        </div>
        {/* Merged compact control row (DESIGN.md "Model control placement"): a
           fixed band between the content shell and the composer, so the
           desktop popup keeps the column-wide clip topology it had in the
           composer band and short panes retain a complete readable row. */}
        <div className="th-chat-controls">
          <div className="th-chat-status" role="status" aria-live="polite">
            <span className={`th-chat-run-indicator${runState === "reconnecting" ? " th-chat-status-item--warn" : runState === "responding" ? " th-chat-status-item--live" : ""}`}
              data-chat-run-state={runState} role={runLabel ? "img" : undefined}
              aria-label={runLabel} title={runLabel}>
              {runState !== "idle" && <span className="th-chat-status-spinner" aria-hidden="true" />}
            </span>
            <div className="th-chat-status-primary">
            {chat.recovery && recoveryLabel && (
              <span
                className={`th-chat-status-item th-chat-recovery${
                  chat.recovery.phase === "incomplete" || chat.recovery.phase === "reconnecting"
                    ? " th-chat-status-item--warn"
                    : ""}`}
                data-recovery-phase={chat.recovery.phase}
                title={chat.recovery.reason}
              >
                {recoveryLabel}
                {chat.recovery.phase === "incomplete" && chat.recovery.reason ? `: ${chat.recovery.reason}` : ""}
              </span>
            )}
            {chat.isCompacting && (
              <span className="th-chat-status-item th-chat-status-item--warn">{t("chat.compacting")}</span>
            )}
            {chat.sendRequests.filter(request => !request.queueOwned && request.phase !== "failed").map(request => (
              <span key={request.requestId} className="th-chat-status-item th-chat-send-status"
                data-request-id={request.requestId} data-send-phase={request.phase}
                title={request.draft.text || request.draft.image?.name}>
                <span className="th-chat-status-label">{t(`chat.send.${request.phase}`)}:</span>
                <button type="button" className="th-chat-send-preview" aria-label={t("chat.send.inspect")}
                  aria-haspopup="dialog"
                  onClick={event => setInspectedOriginal({ text: request.draft.text || request.draft.image?.name || "", trigger: event.currentTarget })}>
                  {request.draft.text || request.draft.image?.name}
                </button>
                {request.phase === "unknown" && <>
                  <button type="button" className="th-btn th-btn--ghost th-send-restore"
                    title={t("chat.send.unknownWarning")} onClick={() => chat.recoverFailedDraft(request.requestId)}>{t("chat.send.restore")}</button>
                  <button type="button" className="th-btn th-btn--ghost th-send-dismiss"
                    onClick={() => chat.dismissSendRequest(request.requestId)}>{t("common.close")}</button>
                </>}
              </span>
            ))}
            {/* Send confirmation only: one short line that self-retires. What is
               actually parked in the engine stays in the queue panel above,
               which the server republishes and a pane remount cannot lose. */}
            {chat.steerPending.length > 0 && (
              <span className="th-chat-status-item th-chat-status-item--steer" title={chat.steerPending[chat.steerPending.length - 1]?.text}>
                {t("chat.steerSent")}
              </span>
            )}
            </div>

          <div className="th-chat-status-metrics">
            {chat.contextUsage && (
              <span className="th-chat-status-item">
                {t("chat.contextUsage")}
                <span className="th-chat-status-num">{Math.round(chat.contextUsage.percent)}%</span>
              </span>
            )}
            {chat.cacheHitRate !== null && (
              <span className="th-chat-status-item">
                {t("chat.cacheHit")}
                <span className="th-chat-status-num">{Math.round(chat.cacheHitRate * 100)}%</span>
              </span>
            )}
          </div>
          </div>
          {modelPicker}
        </div>
        {/* Notice band + separate modal window for each pending request: the
           band is the request's one-line anchor in the column (closing the
           window leaves it; reopening happens from its Open button), and
           the window is the answering surface. A non-blocking question
           renders the band alone until the user opens the window, so
           ordinary typing is never interrupted. */}
        {chat.pendingApproval && (
          <QuestionSurface
            request={chat.pendingApproval}
            windowOpen={approvalWindowOpen}
            onOpenWindow={() => setApprovalWindowForId(chat.pendingApproval?.id ?? null)}
            onCollapseWindow={() => setApprovalWindowForId(null)}
            onRespond={chat.respondApproval}
            focusComposer={focusComposer}
          />
        )}
        {/* A structured question request is an approval-shaped ask: the same
           band + window renders it as one tabbed panel (a tab per question)
           and sends one structured response keyed by question id. The draft
           provider stays mounted across window collapse/reopen so typed
           answers never reset. */}
        {questionRequest && chat.shownQuestion && (
          <QuestionDraftProvider key={chat.shownQuestion.requestId ?? chat.shownQuestion.id}
            requestId={chat.shownQuestion.requestId ?? chat.shownQuestion.id}
            draftState={questionDraftState}
            {...(chat.shownQuestion.delivery === "failed" && chat.shownQuestion.submittedAnswer
              ? { submittedAnswer: chat.shownQuestion.submittedAnswer } : {})}>
            <QuestionSurface
              request={questionRequest}
              windowOpen={questionWindowOpen}
              onOpenWindow={() => setQuestionWindowForId(chat.shownQuestion?.id ?? null)}
              onCollapseWindow={() => setQuestionWindowForId(null)}
              onRespond={(response) => chat.respondQuestion(chat.shownQuestion?.id ?? "", response)}
              focusComposer={focusComposer}
              pendingCount={chat.pendingQuestions.length}
              onNextQuestion={chat.cycleQuestion}
              onResend={() => chat.resendQuestion(chat.shownQuestion?.id ?? "")}
            />
          </QuestionDraftProvider>
        )}
        {closedNoticeSeq !== 0 && (
          <div className="th-question-closed-notice" role="status">
            {t(closedNoticeText)}
          </div>
        )}
        <ChatComposer
          session={chatSession}
          commands={chat.commands}
          running={chat.running}
          blockingQuestion={chat.blockingQuestionPending}
          questionTarget={composerQuestionTarget}
          questionTargets={composerQuestionTargets}
          isCompacting={chat.isCompacting}
          disabled={chat.externalWriteDetected}
          retryDraft={chat.retryDraft}
          onSubmit={update.submit}
          onSteer={chat.steer}
          onStop={chat.stop}
          {...(onNewChat ? { onNewChat } : {})}
          provider={chatSession.provider}
          cwd={chatSession.cwd}
          imageSupported={imageSupported}
        />
      </div>
      {showFiles && (
        <FileBrowser
          path={chatSession.cwd}
          wsId={chatSession.wsId}
          tmId={chatSession.id}
          onClose={() => setShowFiles(false)}
          notify={notify}
          width={filePanelWidth}
          onWidthChange={setFilePanelWidth}
        />
      )}
      {update.dialog}
      {inspectedOriginal && (
        <ModalDialog open labelledBy={originalTitleId} closeLabel={t("common.close")}
          onClose={() => {
            setInspectedOriginal(null);
            if (!inspectedOriginal.trigger.isConnected) pane?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
          }}>
          <div className="th-chat-original">
            <h2 id={originalTitleId} className="th-confirm-title">{t("chat.send.original")}</h2>
            <div className="th-chat-original-text" tabIndex={0}>{inspectedOriginal.text}</div>
          </div>
        </ModalDialog>
      )}
      {showDisconnect && (
        <ModalDialog
          open={showDisconnect}
          onClose={() => setShowDisconnect(false)}
          closeLabel={t("common.close")}
          labelledBy={disconnectTitleId}
        >
          <div className="th-confirm">
            <h2 id={disconnectTitleId} className="th-confirm-title">{t("chat.disconnect")}</h2>
            <p className="th-confirm-message">{t("chat.disconnectConfirm")}</p>
            <div className="th-confirm-actions">
              <button type="button" className="th-btn th-btn--ghost" onClick={() => setShowDisconnect(false)}>
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="th-btn th-btn--danger"
                onClick={() => {
                  setShowDisconnect(false);
                  if (chat.disconnect()) {
                    notify(t("toast.disconnected"), "info");
                  }
                  onClose();
                }}
              >
                {t("chat.disconnect")}
              </button>
            </div>
          </div>
        </ModalDialog>
      )}
    </section>
  );
}
