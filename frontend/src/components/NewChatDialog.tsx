import { useT } from "../i18n";
import type { ProviderDiscoveryState } from "../features/workspace/workspace";
import { ModalDialog } from "./ModalDialog";

export interface NewChatDialogProps {
  readonly open: boolean;
  readonly providerDiscovery: ProviderDiscoveryState;
  readonly onRetryProviders: () => void;
  readonly onClose: () => void;
}

export function NewChatDialog({ open, providerDiscovery, onRetryProviders, onClose }: NewChatDialogProps) {
  const { t } = useT();
  const unavailable = providerDiscovery.status === "loaded"
    && !providerDiscovery.providers.some((provider) => provider.id === "omo" && provider.available);
  const messageKey = providerDiscovery.status === "error"
    ? "newChat.providersError"
    : unavailable
      ? "newChat.unavailable"
      : "newChat.providersLoading";
  const messageRole = providerDiscovery.status === "loading" ? "status" : "alert";

  return (
    <ModalDialog
      open={open}
      onClose={onClose}
      labelledBy="th-new-chat-title"
      closeLabel={t("common.close")}
      initialFocusSelector="[data-new-chat-retry]"
    >
      <div className="th-new-chat">
        <h2 id="th-new-chat-title" className="th-new-chat-title">{t("newChat.title")}</h2>
        <p className="th-new-chat-description">{t("newChat.description")}</p>
        <p className={messageRole === "alert" ? "th-new-chat-error" : undefined} role={messageRole}>
          {t(messageKey)}
        </p>
        <div className="th-new-chat-actions">
          <button type="button" className="th-btn th-btn--ghost" onClick={onClose}>
            {t("wizard.cancel")}
          </button>
          <button
            type="button"
            className="th-btn th-btn--primary"
            data-new-chat-retry
            onClick={onRetryProviders}
          >
            {t("common.retry")}
          </button>
        </div>
      </div>
    </ModalDialog>
  );
}
