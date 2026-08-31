import { useState } from "react";
import { IconX } from "../../components/icons";
import { useT } from "../../i18n";
import type { ChatNotice } from "./useChatFrameState";

export interface NoticeBannerProps {
  readonly notices: readonly ChatNotice[];
}

/** Kinds rendered with the warning tone; every other kind renders as info. */
const WARNING_KINDS: ReadonlySet<string> = new Set([
  "high_reasoning_warning",
  "retry_fallback_applied",
  "retry_fallback_reverted",
  "retry_fallback_exhausted",
  "server_fallback_aborted",
]);

type NoticePayload = NonNullable<ChatNotice["payload"]>;

function payloadString(payload: NoticePayload | null, key: string): string | null {
  const value = payload?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function arrowLine(from: string | null, to: string | null): string | null {
  const parts = [from, to].filter((part) => part !== null);
  return parts.length > 0 ? parts.join(" → ") : null;
}

/**
 * Body of one advisory. Known kinds get rich lines; every other kind —
 * including kinds this build has never heard of — falls back to the kind
 * name plus the payload's message field, so a newer server can never crash
 * an older UI.
 */
function NoticeBody({ notice }: { readonly notice: ChatNotice }) {
  const { t } = useT();
  const payload = notice.payload;
  switch (notice.kind) {
    case "retry_fallback_applied":
    case "retry_fallback_reverted": {
      const line = arrowLine(payloadString(payload, "from"), payloadString(payload, "to"));
      const reason = payloadString(payload, "reason");
      return (
        <>
          <strong className="th-notice-title">
            {t(notice.kind === "retry_fallback_applied" ? "notice.fallbackApplied" : "notice.fallbackReverted")}
          </strong>
          {line !== null && <span className="th-notice-detail">{line}</span>}
          {reason !== null && <span className="th-notice-detail">{t("notice.fallbackReason")}: {reason}</span>}
        </>
      );
    }
    case "server_fallback_aborted": {
      const line = arrowLine(payloadString(payload, "from"), payloadString(payload, "to"));
      return (
        <>
          <strong className="th-notice-title">{t("notice.fallbackAborted")}</strong>
          {line !== null && <span className="th-notice-detail">{line}</span>}
        </>
      );
    }
    case "high_reasoning_warning": {
      const provider = payloadString(payload, "provider");
      const modelId = payloadString(payload, "modelId");
      const level = payloadString(payload, "thinkingLevel");
      const model = provider !== null || modelId !== null
        ? [provider, modelId].filter((part) => part !== null).join("/")
        : null;
      const line = [model, level].filter((part) => part !== null).join(" @ ");
      return (
        <>
          <strong className="th-notice-title">{t("notice.highReasoningWarning")}</strong>
          {line !== "" && <span className="th-notice-detail">{line}</span>}
          <span className="th-notice-detail">{t("notice.highReasoningGuidance")}</span>
        </>
      );
    }
    case "extension_notify": {
      const title = payloadString(payload, "title");
      const message = payloadString(payload, "message");
      if (title === null && message === null) break;
      return (
        <>
          {title !== null && <strong className="th-notice-title">{title}</strong>}
          {message !== null && <span>{message}</span>}
        </>
      );
    }
  }
  const message = payloadString(payload, "message");
  return (
    <>
      <strong className="th-notice-title">{notice.kind}</strong>
      {message !== null && <span>{message}</span>}
    </>
  );
}

/**
 * Ephemeral server advisories, stacked above the transcript, newest first.
 * Dismissal is view-local: the state list stays append-only from the frame
 * handler, and nothing is persisted or replayed across reconnects.
 */
export function NoticeBanner({ notices }: NoticeBannerProps) {
  const { t } = useT();
  const [dismissed, setDismissed] = useState<ReadonlySet<number>>(() => new Set());
  const visible = notices.filter((notice) => !dismissed.has(notice.id));
  if (visible.length === 0) return null;
  return (
    <div className="th-notice-stack">
      {visible.map((notice) => (
        <div
          key={notice.id}
          className={`th-alert ${WARNING_KINDS.has(notice.kind) ? "th-alert--warning" : "th-alert--info"}`}
          role="status"
        >
          <span className="th-notice-body">
            <NoticeBody notice={notice} />
          </span>
          <button
            type="button"
            className="th-btn-icon th-notice-dismiss"
            aria-label={t("notice.dismiss")}
            onClick={() => setDismissed((current) => new Set(current).add(notice.id))}
          >
            <IconX size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
