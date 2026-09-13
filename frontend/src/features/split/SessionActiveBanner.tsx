import { useT } from "../../i18n";

export interface SessionActiveBannerProps {
  readonly onForceOpen: () => void;
}

/** Visible recovery state when the in-place source file shows concurrent
 * write activity: a second device attach that hit the activity gate gets an
 * explicit authorize-and-retry affordance instead of a dead error pane. */
export function SessionActiveBanner({ onForceOpen }: SessionActiveBannerProps) {
  const { t } = useT();
  return (
    <div className="th-alert th-alert--warning th-session-active-banner" role="alert">
      <span className="th-session-active-banner-body">
        <strong className="th-session-active-banner-title">{t("chat.sessionActiveTitle")}</strong>
        <span className="th-session-active-banner-detail">{t("chat.sessionActiveDetail")}</span>
      </span>
      <button type="button" className="th-btn th-btn--primary th-session-active-banner-actions" onClick={onForceOpen}>
        {t("sidebar.tm.forceOpen")}
      </button>
    </div>
  );
}
