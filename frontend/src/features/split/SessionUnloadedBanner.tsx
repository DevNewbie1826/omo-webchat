import { useT } from "../../i18n";

export interface SessionUnloadedBannerProps {
  readonly onResume: () => void;
}

/**
 * Shown when the engine unloaded this idle session (session_unloaded): the
 * engine process is still alive and the conversation is durable on disk, so
 * this is a calm, resumable state - not a terminal error. Resuming re-sends
 * the same chat.create frame the open path uses; the banner clears on the
 * ready frame of that sequence (see useChatFrameState).
 */
export function SessionUnloadedBanner({ onResume }: SessionUnloadedBannerProps) {
  const { t } = useT();
  return (
    <div className="th-alert th-alert--info th-unloaded-banner" role="status">
      <span className="th-unloaded-banner-body">
        <strong className="th-unloaded-banner-title">{t("chat.sessionUnloadedTitle")}</strong>
        <span className="th-unloaded-banner-detail">{t("chat.sessionUnloadedDetail")}</span>
      </span>
      <button type="button" className="th-btn th-btn--primary th-unloaded-banner-actions" onClick={onResume}>
        {t("chat.sessionUnloadedResume")}
      </button>
    </div>
  );
}
