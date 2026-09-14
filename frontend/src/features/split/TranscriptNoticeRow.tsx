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

type NotifyTone = "info" | "warning" | "error";

function notifyTone(payload: ChatNotice["payload"]): NotifyTone {
  const value = payload?.["notifyType"];
  return value === "warning" || value === "error" ? value : "info";
}

/** One payload field rendered as text: arrays joined, objects compact JSON. */
function fieldText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(fieldText).join(", ");
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Field keys already surfaced as the title or primary line of the box. */
const PRIMARY_KEYS = ["why", "message", "reason"] as const;

/**
 * One server advisory rendered in the observed engine display format inside
 * the virtualized transcript flow — never inside the live region.
 *
 * `engine_notify` advisories render as a single dim one-line status row: the
 * payload message verbatim, toned by `notifyType` (info/warning/error).
 *
 * Every other kind renders as a notice box: a bold title line (payload.title
 * when it is a string, else the kind), one primary explanatory line (the first of
 * payload.why / payload.message / payload.reason), then every remaining
 * payload field as a dim "key: value" line. All information stays visible as
 * text — no JSON blob, no disclosure. Rows are permanent and non-interactive.
 */
export function TranscriptNoticeRow({ notice }: TranscriptNoticeRowProps) {
  const payload = notice.payload;

  if (notice.kind === "engine_notify") {
    const message = typeof payload?.["message"] === "string" ? payload["message"] : "";
    return (
      <div className={`th-notice-status th-notice-status--${notifyTone(payload)}`} role="status">
        <span className="th-notice-status-text">{message}</span>
        <span className="th-notice-time">{formatNoticeTime(notice.at)}</span>
      </div>
    );
  }

  const fields = payload ?? {};
  const titleValue = fields["title"];
  // Only a string title takes the bold-title role; a non-string title is not
  // special-cased and flows through the remaining "key: value" lines below so
  // every present value stays visible.
  const title = typeof titleValue === "string" ? titleValue : notice.kind;
  const primaryKey = PRIMARY_KEYS.find((key) => fields[key] !== undefined);
  const primary = primaryKey === undefined ? undefined : fieldText(fields[primaryKey]);
  const rest = Object.entries(fields).filter(
    ([key]) => (typeof titleValue === "string" ? key !== "title" : true) && key !== primaryKey,
  );

  return (
    <div className="th-chat-notice th-alert th-alert--info" role="status">
      <div className="th-chat-notice-content">
        <span className="th-notice-title">{title}</span>
        <span className="th-notice-time">{formatNoticeTime(notice.at)}</span>
        {primary !== undefined && <span className="th-notice-line">{primary}</span>}
        {rest.map(([key, value]) => (
          <span key={key} className="th-notice-line">{`${key}: ${fieldText(value)}`}</span>
        ))}
      </div>
    </div>
  );
}
