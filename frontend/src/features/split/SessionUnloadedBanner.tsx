import { useT } from "../../i18n";
import type { ResumableCause } from "./useChatFrameState";

export interface SessionUnloadedBannerProps {
  readonly onResume: () => void;
  readonly cause: ResumableCause;
}

/**
 * The calm, resumable state for a chat that outlived its runtime: the engine
 * unloaded the idle session (session_unloaded), or the shared provider
 * process ended (pi_eof). Either way the conversation is durable on disk, so
 * this is not a terminal error. Resuming re-sends the same chat.create frame
 * the open path uses; the banner clears on the state frame proving get_state
 * completed against a live provider route.
 */
export function SessionUnloadedBanner({ onResume, cause }: SessionUnloadedBannerProps) {
  const { t } = useT();
  const title = t(cause === "providerEnded" ? "chat.providerEndedTitle" : "chat.sessionUnloadedTitle");
  const detail = t(cause === "providerEnded" ? "chat.providerEndedDetail" : "chat.sessionUnloadedDetail");
  return (
    <div className="th-alert th-alert--info th-unloaded-banner" role="status">
      <span className="th-unloaded-banner-body">
        <strong className="th-unloaded-banner-title">{title}</strong>
        <span className="th-unloaded-banner-detail">{detail}</span>
      </span>
      <button type="button" className="th-btn th-btn--primary th-unloaded-banner-actions" onClick={onResume}>
        {t("chat.sessionUnloadedResume")}
      </button>
    </div>
  );
}
