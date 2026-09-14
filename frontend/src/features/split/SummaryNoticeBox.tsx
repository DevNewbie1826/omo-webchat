/** Receipt time of the entry, formatted as local HH:MM:SS. */
function formatSummaryTime(at: number): string {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export interface SummaryNoticeBoxProps {
  /** Bold label line, e.g. "[compaction]" or "[branch]". */
  readonly label: string;
  /** The summary text, passed through verbatim. */
  readonly summary: string;
  /** Compacted token count; the tokens line is omitted when absent. */
  readonly tokensBefore?: number;
  /** Receipt/entry time (epoch ms); the time element is omitted when absent. */
  readonly at?: number;
}

/**
 * A persisted or live compaction/branch summary rendered in the notice-box
 * visual language: a bold label line, an optional dim tokens line, and the
 * summary text collapsed to a single line behind a native disclosure that
 * expands to the full verbatim text. The receipt-time element stays on the
 * box whenever a timestamp is known.
 */
export function SummaryNoticeBox({ label, summary, tokensBefore, at }: SummaryNoticeBoxProps) {
  const firstLine = summary.split("\n", 1)[0] ?? "";
  return (
    <div className="th-chat-notice th-alert th-alert--info" role="status">
      <div className="th-chat-notice-content">
        <span className="th-notice-title">{label}</span>
        {at !== undefined && <span className="th-notice-time">{formatSummaryTime(at)}</span>}
        {tokensBefore !== undefined && (
          <span className="th-notice-line">{`Tokens before compaction: ${tokensBefore}`}</span>
        )}
        <details className="th-notice-summary">
          <summary className="th-notice-summary-toggle">{firstLine}</summary>
          <span className="th-notice-line th-notice-summary-full">{summary}</span>
        </details>
      </div>
    </div>
  );
}
