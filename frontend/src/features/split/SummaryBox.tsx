import { useState } from "react";

export interface SummaryBoxProps {
  /** Bold bracket label of the box, e.g. "[compaction]" or "[branch]". */
  readonly label: string;
  /** Token count line, always visible when present ("{tokens} tokens"). */
  readonly tokens?: number;
  /** Full summary text; collapsed to its first line until expanded. */
  readonly summary: string;
  /** Receipt time, pre-formatted HH:MM:SS. */
  readonly time: string;
}

/**
 * Labeled summary box in the notice-box visual language: a bold bracket
 * label, an always-visible tokens line, and the summary folded to its first
 * line behind an expand toggle. Folding never hides information — the toggle
 * reveals the full summary text in place, and the row grows so the
 * virtualized transcript keeps its measured height.
 */
export function SummaryBox({ label, tokens, summary, time }: SummaryBoxProps) {
  const [open, setOpen] = useState(false);
  const newline = summary.indexOf("\n");
  const firstLine = newline === -1 ? summary : summary.slice(0, newline);
  const hasMore = newline !== -1 && summary.slice(newline + 1).trim().length > 0;

  return (
    <div className="th-chat-notice th-alert th-alert--info" role="status">
      <div className="th-chat-notice-content">
        <span className="th-notice-title">{label}</span>
        <span className="th-notice-time">{time}</span>
        {tokens !== undefined && (
          <span className="th-notice-line th-notice-summary-tokens">{`${tokens} tokens`}</span>
        )}
        {hasMore ? (
          <>
            <button
              type="button"
              className="th-notice-summary-toggle"
              aria-expanded={open}
              onClick={() => setOpen((value) => !value)}
            >
              <span className="th-notice-summary-first">{firstLine}</span>
              <span className="th-notice-summary-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
            </button>
            {open && <span className="th-notice-line th-notice-summary-full">{summary}</span>}
          </>
        ) : (
          <span className="th-notice-line">{summary}</span>
        )}
      </div>
    </div>
  );
}
