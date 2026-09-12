import type { ReactNode } from "react";
import { useId, useLayoutEffect, useMemo, useState } from "react";
import { IconMenu, IconPower, IconSplitH, IconSplitV, IconX } from "../../components/icons";
import { ModalDialog } from "../../components/ModalDialog";
import type { ToastKind } from "../../components/SessionTree";
import { useT } from "../../i18n";
import type { ChatConnector } from "../../lib/chatWs";
import { FileBrowser } from "../terminal/FileBrowser";
import type { ChatSessionRef } from "../workspace/workspace";
import { ApprovalModal } from "./ApprovalModal";
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

export function ChatPane({
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
  const [narrow, setNarrow] = useState(() => window.innerWidth <= 600);
  useLayoutEffect(() => {
    if (!pane || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setNarrow(entry.contentRect.width <= 600);
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
  // Notices replay before history, so keep them gated until the monotonic
  // history lifecycle either completes or proves that history is unavailable.
  // Send-path command failures surface in the persistent banner below, so
  // they never also render as transcript notice blocks.
  const transcriptItems = useMemo(
    () => mergeTranscriptItems(
      // Zero-block assistant completions stay in transcript state (they anchor
      // current-turn tool results for run.done materialization, live and
      // restored alike) and therefore flow into the merged list unfiltered,
      // preserving notice placement around the authoritative message order.
      // ChatTranscript derives row identity from this unfiltered list and only
      // then hides blank rows, so an empty anchor appearing or disappearing
      // never shifts any other row's key — visible rows never remount.
      chat.messages,
      chat.historyStatus !== "loading" ? chat.notices : [],
    ),
    [chat.messages, chat.notices, chat.historyStatus],
  );
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
  const recoveryLabel = chat.recovery === null ? undefined
    : chat.recovery.phase === "reconnecting" ? t("chat.reconnecting")
    : chat.recovery.phase === "resuming" ? t("chat.recoveryResuming")
    : t("chat.recoveryIncomplete");

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
        <span className="th-termhead-name">{chatSession.name}</span>
        <span className="th-provider-badge" data-provider={chatSession.provider}>{chatSession.provider}</span>
        <span className="th-termhead-path" title={chatSession.cwd}>{chatSession.cwd}</span>
        <button
          type="button"
          className={`th-btn-icon th-files-toggle${showFiles ? " th-files-toggle--on" : ""}`}
          title={t("chat.files")}
          aria-label={t("chat.files")}
          aria-pressed={showFiles}
          onClick={() => setShowFiles((visible) => !visible)}
        >
          {t("chat.files")}
        </button>
        <button
          type="button"
          className="th-btn th-btn--ghost th-btn-icon th-chat-resync-btn"
          title={t("chat.resync")}
          aria-label={t("chat.resync")}
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
          <span className="th-chat-resync-label">
            {chat.resyncBusy ? t("chat.resyncBusy") : t("chat.resync")}
          </span>
        </button>
        <button
          type="button"
          className="th-btn-icon th-btn-icon--danger th-disconnect-btn"
          title={t("chat.disconnect")}
          aria-label={t("chat.disconnect")}
          onClick={() => setShowDisconnect(true)}
        >
          <IconPower size={14} />
        </button>
        {splitEnabled && (
          <div className="th-termhead-actions">
            <button type="button" className="th-btn-icon" title={t("split.h")} onClick={() => onSplit("h")}><IconSplitH size={14} /></button>
            <button type="button" className="th-btn-icon" title={t("split.v")} onClick={() => onSplit("v")}><IconSplitV size={14} /></button>
            <button type="button" className="th-btn-icon th-btn-icon--danger" title={t("split.close")} aria-label={t("split.close")} onClick={onClose}><IconX size={14} /></button>
          </div>
        )}
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
        />
        <GoalBar goal={chat.goal} />
        <ActivityShelf activities={chat.activities} dagSource={{ wsId: chatSession.wsId, chatId: chatSession.id, connected: chat.connected }} />
        {/* Fixed queue slot: run-time pending feedback renders here, outside
        the transcript scrollport, anchored above the status strip/composer. */}
        <QueuePanel
          items={chat.queueItems}
          engine={chat.queueEngine}
          placeholders={chat.queuePlaceholders}
          steerPending={chat.steerPending}
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
            {chat.steerPending.map((item) => (
              <span key={item.requestId} className="th-chat-status-item th-chat-status-item--steer" title={item.text}>
                <span className="th-chat-status-label">{t("chat.steerPending", { text: "" })}</span>
                <button type="button" className="th-chat-send-preview" aria-label={t("chat.send.inspect")}
                  aria-haspopup="dialog" onClick={event => setInspectedOriginal({ text: item.text, trigger: event.currentTarget })}>
                  {item.text}
                </button>
              </span>
            ))}
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
        <ChatComposer
          session={chatSession}
          commands={chat.commands}
          running={chat.running}
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
      {chat.pendingApproval && <ApprovalModal request={chat.pendingApproval} onRespond={chat.respondApproval} />}
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
