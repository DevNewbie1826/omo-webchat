import { useMemo, useState } from "react";
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
import { GoalBar } from "./GoalBar";
import { MissingOriginalBanner } from "./MissingOriginalBanner";
import { SessionUnloadedBanner } from "./SessionUnloadedBanner";
import { SendErrorBanner } from "./SendErrorBanner";
import { ModelPicker } from "./ModelPicker";
import { ChatTranscript } from "./ChatTranscript";
import type { SplitDir } from "./paneTree";
import { mergeTranscriptItems } from "./useChatFrameState";
import { sendErrorDetail } from "./useChatFrameHandler";
import { useChatSession } from "./useChatSession";

/** Every thinking level; an authoritative unknown value is still listed. */
const THINKING_LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface ChatPaneProps {
  readonly chatSession: ChatSessionRef;
  readonly focused: boolean;
  readonly splitEnabled: boolean;
  readonly onFocus: () => void;
  readonly onSplit: (dir: SplitDir) => void;
  readonly onClose: () => void;
  readonly onOpenSidebar: () => void;
  readonly connect: ChatConnector;
  readonly notify: (msg: string, kind?: ToastKind) => void;
  readonly onChatName?: (name: string, origin: "auto" | "user" | "provider") => void;
}

export function ChatPane({
  chatSession,
  focused,
  splitEnabled,
  onFocus,
  onSplit,
  onClose,
  onOpenSidebar,
  connect,
  notify,
  onChatName,
}: ChatPaneProps) {
  const { t } = useT();
  const [showFiles, setShowFiles] = useState(false);
  const [filePanelWidth, setFilePanelWidth] = useState(320);
  const [showDisconnect, setShowDisconnect] = useState(false);
  const chat = useChatSession(chatSession, connect, onChatName);
  // Notices replay before history, so keep them gated until the monotonic
  // history lifecycle either completes or proves that history is unavailable.
  // Send-path command failures surface in the persistent banner below, so
  // they never also render as transcript notice blocks.
  const transcriptItems = useMemo(
    () => mergeTranscriptItems(chat.messages, chat.historyStatus !== "loading" ? chat.notices : []),
    [chat.messages, chat.notices, chat.historyStatus],
  );
  const sendQueued = chat.hasPendingFollowUp;
  const currentModel = chat.models.find((model) => `${model.provider}/${model.modelId}` === chat.currentModelKey);
  const imageSupported = currentModel ? (currentModel.input?.includes("image") ?? true) : true;
  const thinkingOptions = chat.thinkingLevel !== "" && !THINKING_LEVELS.includes(chat.thinkingLevel)
    ? [...THINKING_LEVELS, chat.thinkingLevel]
    : THINKING_LEVELS;

  return (
    <section
      className={`th-stage th-pane th-chat-pane${focused ? " th-pane--focused" : ""}`}
      onPointerDown={onFocus}
    >
      <header className="th-termhead">
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
        <select
          className="th-thinking-select"
          aria-label={t("chat.thinkingLevel")}
          value={chat.thinkingLevel}
          onChange={(event) => chat.changeThinkingLevel(event.target.value)}
        >
          {thinkingOptions.map((level) => (
            <option key={level} value={level}>{t("chat.thinkingLevel")}: {level}</option>
          ))}
        </select>
        {chat.models.length > 0 && (
          <ModelPicker
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
        )}
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
        {chat.missingOriginal && <MissingOriginalBanner candidates={chat.missingOriginal.candidates} />}
        {chat.sessionUnloaded && <SessionUnloadedBanner onResume={chat.resume} />}
        {chat.externalWriteDetected && <ExternalWriteBanner onReload={chat.reloadExternalWrite} />}
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
        <ActivityShelf activities={chat.activities} />
        <div className="th-chat-status" role="status" aria-live="polite">
          {chat.running && (
            <span className="th-chat-status-item th-chat-status-item--live">
              <span className="th-chat-status-spinner" aria-hidden="true" />
              {t("chat.responding")}
            </span>
          )}
          {sendQueued && (
            <span className="th-chat-status-item">{t("chat.sendQueued")}</span>
          )}
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
          {chat.isCompacting && (
            <span className="th-chat-status-item th-chat-status-item--warn">{t("chat.compacting")}</span>
          )}
          {!chat.connected && (
            <span className="th-chat-status-item th-chat-status-item--warn">{t("chat.reconnecting")}</span>
          )}
        </div>
        {chat.failedDrafts.length > 0 && (
          <div className="th-failed-drafts" role="group" aria-label={t("chat.failedSends")}>
            {chat.failedDrafts.map((draft) => (
              <button
                key={draft.requestId}
                type="button"
                className="th-btn th-btn--ghost th-failed-draft"
                onClick={() => chat.recoverFailedDraft(draft.requestId)}
              >
                {t("common.retry")}: {draft.text || draft.image?.name || t("chat.image")}
              </button>
            ))}
          </div>
        )}
        <ChatComposer
          commands={chat.commands}
          running={chat.running}
          isCompacting={chat.isCompacting}
          disabled={chat.externalWriteDetected}
          retryDraft={chat.retryDraft}
          onSubmit={chat.submit}
          onSteer={chat.steer}
          onStop={chat.stop}
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
      {showDisconnect && (
        <ModalDialog
          open={showDisconnect}
          onClose={() => setShowDisconnect(false)}
          closeLabel={t("common.close")}
        >
          <div className="th-confirm">
            <h2 className="th-confirm-title">{t("chat.disconnect")}</h2>
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
