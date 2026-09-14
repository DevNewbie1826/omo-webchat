import { useT } from "../../i18n";
import type { ChatNotice } from "./useChatFrameState";

export interface TranscriptNoticeRowProps {
  readonly notice: ChatNotice;
}

/** Receipt time of the advisory, formatted as local HH:MM:SS. */
function formatNoticeTime(at: number): string {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * One server advisory rendered as a distinct bordered system block in the
 * virtualized transcript flow — never inside the live region. Every notice
 * renders the same uniform structure regardless of kind: the system tag, the
 * receipt time, and the full original payload as always-visible JSON with the
 * wire kind merged in as a non-colliding wrapper `{ type, payload }`, so a
 * payload's own fields — including its own `type` — are preserved verbatim (a
 * null payload renders as `{"type": kind, "payload": null}`).
 * Rows are permanent, non-interactive display blocks: no disclosure and no
 * dismissal control is rendered.
 */
export function TranscriptNoticeRow({ notice }: TranscriptNoticeRowProps) {
  const { t } = useT();
  const fullPayload = { type: notice.kind, payload: notice.payload };
  return (
    <div className="th-chat-notice th-alert th-alert--info" role="status">
      <div className="th-chat-notice-content">
        <span className="th-chat-notice-tag">{t("notice.system")}</span>
        <span className="th-notice-time">{formatNoticeTime(notice.at)}</span>
        <pre className="th-notice-payload">{JSON.stringify(fullPayload, null, 2)}</pre>
      </div>
    </div>
  );
}
