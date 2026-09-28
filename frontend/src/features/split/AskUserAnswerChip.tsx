import { useState } from "react";
import { useT } from "../../i18n";
import { IconChevron } from "../../components/icons";
import { askUserAnswerRows, type AskUserAnswerFrame } from "./askUserAnswer";

export interface AskUserAnswerChipProps {
  readonly frame: AskUserAnswerFrame;
  readonly headers: readonly string[];
}

/**
 * One answered ask_user_question / request_user_input rendered in the
 * transcript (IS-2): muted summary rows (`↳ Header: answer`, or the
 * localized `(no answer)` marker for timeout/dismissed/orphaned/unavailable
 * outcomes), collapsed by default; the disclosure toggle expands to the full
 * verbatim body. Never a user bubble — the text is the engine's answer
 * frame, not the user's own words.
 */
export function AskUserAnswerChip({ frame, headers }: AskUserAnswerChipProps) {
  const { t } = useT();
  const [expanded, setExpanded] = useState(false);
  const rows = askUserAnswerRows(frame, headers);
  return (
    <div className="th-ask-answer" role="note" aria-label={t("question.answerChip.label")}>
      <button
        type="button"
        className="th-ask-answer-toggle"
        aria-expanded={expanded}
        aria-label={expanded ? t("question.answerChip.collapse") : t("question.answerChip.expand")}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className={`th-ask-answer-chevron${expanded ? " th-ask-answer-chevron--open" : ""}`} aria-hidden="true">
          <IconChevron size={12} />
        </span>
        <span className="th-ask-answer-rows">
          {rows.map((row, index) => (
            <span key={`${row.header}:${index}`} className="th-ask-answer-row">
              {`↳ ${row.header}: ${row.value ?? t("question.answerChip.noAnswer")}`}
            </span>
          ))}
        </span>
      </button>
      {expanded && <div className="th-ask-answer-body">{frame.body}</div>}
    </div>
  );
}
