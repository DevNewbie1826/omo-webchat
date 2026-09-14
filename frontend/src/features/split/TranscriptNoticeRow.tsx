import type { ChatNotice } from "./useChatFrameState";
import { SummaryNoticeBox } from "./SummaryNoticeBox";

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
/** {kind, text} one-liners that render as a warning-toned single line. */
const WARNING_LINE_KINDS = new Set(["compaction_cost", "cache_miss", "engine_warning"]);
/** {kind, text} one-liners that render as a dim single-line status row. */
const DIM_LINE_KINDS = new Set(["thinking_dropped", "continuity_notice", "compaction_history"]);

function payloadText(payload: ChatNotice["payload"]): string {
  const value = payload?.["text"];
  return typeof value === "string" ? value : "";
}

/** First present of message/reason/error, verbatim; undefined when none is a string. */
function payloadMessageText(payload: ChatNotice["payload"]): string | undefined {
  for (const key of ["message", "reason", "error"] as const) {
    const value = payload?.[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

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

  // compaction_summary renders as the summary box: a "[compaction]" label, an
  // optional tokens line, and the summary collapsed to one line + expandable.
  if (notice.kind === "compaction_summary") {
    const summaryValue = payload?.["summary"];
    const tokensValue = payload?.["tokensBefore"];
    return (
      <SummaryNoticeBox
        label="[compaction]"
        summary={typeof summaryValue === "string" ? summaryValue : ""}
        {...(typeof tokensValue === "number" ? { tokensBefore: tokensValue } : {})}
        at={notice.at}
      />
    );
  }

  // auto_retry_start / auto_retry_end render as warning-toned single-line
  // status rows (same visual language as the engine_notify row, warning
  // variant): the payload's own text verbatim — first present of
  // message/reason/error — falling back to the notice kind itself when no
  // text field exists. Receipt time kept.
  if (notice.kind === "auto_retry_start" || notice.kind === "auto_retry_end") {
    const text = payloadMessageText(payload) ?? notice.kind;
    return (
      <div className="th-notice-status th-notice-status--warning" role="status">
        <span className="th-notice-status-text">{text}</span>
        <span className="th-notice-time">{formatNoticeTime(notice.at)}</span>
      </div>
    );
  }

  // {kind, text} one-liners: warning-toned or dim single-line status rows,
  // text verbatim, receipt time kept.
  if (WARNING_LINE_KINDS.has(notice.kind) || DIM_LINE_KINDS.has(notice.kind)) {
    const tone = WARNING_LINE_KINDS.has(notice.kind) ? "warning" : "info";
    return (
      <div className={`th-notice-status th-notice-status--${tone}`} role="status">
        <span className="th-notice-status-text">{payloadText(payload)}</span>
        <span className="th-notice-time">{formatNoticeTime(notice.at)}</span>
      </div>
    );
  }

  // extension_error renders as an error-toned block: a title line (the
  // extension path, plus the event when present) and the error text block.
  if (notice.kind === "extension_error") {
    const pathValue = payload?.["extensionPath"];
    const eventValue = payload?.["event"];
    const errorValue = payload?.["error"];
    const path = typeof pathValue === "string" ? pathValue : "";
    const title = typeof eventValue === "string" ? `${path} (${eventValue})` : path;
    return (
      <div className="th-chat-notice th-alert th-alert--error" role="status">
        <div className="th-chat-notice-content">
          <span className="th-notice-title">{title}</span>
          <span className="th-notice-time">{formatNoticeTime(notice.at)}</span>
          <span className="th-notice-line th-notice-error-text">
            {typeof errorValue === "string" ? errorValue : ""}
          </span>
        </div>
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
