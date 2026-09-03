import { useT } from "../../i18n";

export interface ExternalWriteBannerProps {
  readonly onReload: () => void;
}

/** Visible recovery state for an original session changed outside webchat. */
export function ExternalWriteBanner({ onReload }: ExternalWriteBannerProps) {
  const { t } = useT();
  return (
    <div className="th-alert th-alert--warning th-external-write-banner" role="alert">
      <span className="th-external-write-banner-body">
        <strong className="th-external-write-banner-title">{t("chat.externalWriteTitle")}</strong>
        <span className="th-external-write-banner-detail">{t("chat.externalWriteDetail")}</span>
      </span>
      <button type="button" className="th-btn th-btn--primary th-external-write-banner-actions" onClick={onReload}>
        {t("chat.externalWriteReload")}
      </button>
    </div>
  );
}
