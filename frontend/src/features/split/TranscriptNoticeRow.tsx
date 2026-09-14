import type { ChatNotice } from "./useChatFrameState";
import { SummaryBox } from "./SummaryBox";

export interface TranscriptNoticeRowProps {
  readonly notice: ChatNotice;
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
 * Advisory kinds that render as a single toned status line, mirroring the
 * observed engine display: warning-toned (yellow) for cost/cache-miss/
 * thinking-dropped/engine warnings, dim gray for continuity and compaction
 * history. The payload message renders verbatim.
 */
const WARNING_LINE_KINDS = new Set([
  "compaction_cost",
  "cache_miss",
  "thinking_dropped",
  "engine_warning",
]);
const DIM_LINE_KINDS = new Set(["continuity_notice", "compaction_history"]);

function payloadString(payload: ChatNotice["payload"], key: string): string | undefined {
  const value = payload?.[key];
  return typeof value === "string" ? value : undefined;
}

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
      </div>
    );
  }

  // Compaction and branch summaries render as labeled boxes: the tokens line
  // stays visible and the summary folds to its first line behind a toggle.
  if (notice.kind === "compaction_summary" || notice.kind === "branchSummary") {
    const tokensValue = payload?.["tokens"];
    const summary =
      payloadString(payload, "summary") ?? payloadString(payload, "message") ?? payloadString(payload, "text") ?? "";
    return (
      <SummaryBox
        label={notice.kind === "compaction_summary" ? "[compaction]" : "[branch]"}
        {...(typeof tokensValue === "number" ? { tokens: tokensValue } : {})}
        summary={summary}
      />
    );
  }

  // Cost/cache-miss/thinking-dropped/warning advisories are warning-toned
  // single lines; continuity and compaction-history advisories are dim gray.
  if (WARNING_LINE_KINDS.has(notice.kind) || DIM_LINE_KINDS.has(notice.kind)) {
    const tone = WARNING_LINE_KINDS.has(notice.kind) ? "warning" : "info";
    const message = payloadString(payload, "message") ?? "";
    return (
      <div className={`th-notice-status th-notice-status--${tone}`} role="status">
        <span className="th-notice-status-text">{message}</span>
      </div>
    );
  }

  // Extension failures render as an error-toned notice block: the extension
  // path as the bold title and the error string/stack in a muted pre block.
  if (notice.kind === "extension_error") {
    const title = payloadString(payload, "extensionPath") ?? "Extension error";
    const error = payloadString(payload, "error") ?? "";
    return (
      <div className="th-chat-notice th-alert th-alert--error" role="status">
        <div className="th-chat-notice-content">
          <span className="th-notice-title">{title}</span>
          {error !== "" && <pre className="th-notice-pre">{error}</pre>}
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
        {primary !== undefined && <span className="th-notice-line">{primary}</span>}
        {rest.map(([key, value]) => (
          <span key={key} className="th-notice-line">{`${key}: ${fieldText(value)}`}</span>
        ))}
      </div>
    </div>
  );
}
