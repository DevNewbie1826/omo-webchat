import { useT } from "../../i18n";

export interface SendErrorBannerProps {
  /** The raw failure text of the send-path command that was rejected. */
  readonly detail: string;
  readonly onDismiss: () => void;
}

/**
 * Persistent surfacing for send-path command failures (chat.send,
 * chat.compact, chat.abort, and the busy-gate rejections). Unlike the
 * transient transcript error slot — which the next live frame overwrites —
 * this banner stays until the user dismisses it, and a newer failure
 * replaces the one shown.
 */
export function SendErrorBanner({ detail, onDismiss }: SendErrorBannerProps) {
  const { t } = useT();
  return (
    <div className="th-alert th-alert--warning th-send-error-banner" role="alert">
      <span className="th-send-error-banner-body">
        <strong className="th-send-error-banner-title">{t("chat.sendErrorTitle")}</strong>
        <span className="th-send-error-banner-detail">{detail}</span>
      </span>
      <button type="button" className="th-btn th-btn--ghost th-send-error-banner-actions" onClick={onDismiss}>
        {t("chat.sendErrorDismiss")}
      </button>
    </div>
  );
}
