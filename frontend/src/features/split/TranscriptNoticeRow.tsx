import { useT } from "../../i18n";
import type { ChatNotice } from "./useChatFrameState";

export interface TranscriptNoticeRowProps {
  readonly notice: ChatNotice;
}

/** Kinds rendered with the warning tone; every other kind renders as info. */
const WARNING_KINDS: ReadonlySet<string> = new Set([
  "high_reasoning_warning",
  "retry_fallback_applied",
  "retry_fallback_reverted",
  "retry_fallback_exhausted",
  "server_fallback_aborted",
  "compaction_error",
]);

function payloadMessage(payload: ChatNotice["payload"]): string | null {
  if (payload === null) return null;
  const value = payload["message"];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function showPayloadDetails(payload: ChatNotice["payload"]): payload is NonNullable<ChatNotice["payload"]> {
  if (payload === null) return false;
  if (payloadMessage(payload) === null) return true;
  return Object.keys(payload).some((key) => key !== "message");
}

/**
 * One server advisory rendered as a distinct bordered system block in the
 * virtualized transcript flow — never inside the live region. The body is the
 * wire kind plus payload.message when present; extra payload fields (or a
 * payload with no message) sit in a collapsed JSON disclosure. Rows are
 * permanent, non-interactive display blocks: no dismissal control is rendered.
 */
export function TranscriptNoticeRow({ notice }: TranscriptNoticeRowProps) {
  const { t } = useT();
  const payload = notice.payload;
  const message = payloadMessage(payload);
  const rawLine = message !== null ? `${notice.kind} ${message}` : notice.kind;
  return (
    <div
      className={`th-chat-notice th-alert ${WARNING_KINDS.has(notice.kind) ? "th-alert--warning" : "th-alert--info"}`}
      role="status"
    >
      <div className="th-chat-notice-content">
        <span className="th-chat-notice-tag">{t("notice.system")}</span>
        <span className="th-notice-body">
          <span className="th-notice-raw">{rawLine}</span>
          {showPayloadDetails(payload) && (
            <details className="th-notice-payload">
              <summary />
              <pre>{JSON.stringify(payload, null, 2)}</pre>
            </details>
          )}
        </span>
      </div>
    </div>
  );
}
