import { useId, useState } from "react";
import { useT } from "../../i18n";
import { IconChevron } from "../../components/icons";

export interface ThinkingDisclosureProps {
  /** The reasoning text, verbatim. */
  readonly text: string;
  /** Live (streaming) disclosure: violet dotted spinner + shimmering label. */
  readonly running?: boolean | undefined;
  /** The previous transcript record is also a record: extend the rail up. */
  readonly continuesRail?: boolean | undefined;
  /** Extra classes for the record root (the transcript's one-shot row entrance). */
  readonly className?: string | undefined;
}

/**
 * A thinking record in the transcript timeline grammar: a transparent row
 * with a status dot on the 1px rail, the Thinking label, and a round
 * collapse chevron, over a body that opens with the documented
 * grid-template-rows disclosure transition. Accessible disclosure semantics
 * ride a real button (aria-expanded + aria-controls) so Enter/Space toggle
 * natively; the body stays mounted so the CSS transition retargets safely
 * mid-flight with no JS timers. The reasoning text stays on the reading
 * tier (>= 4.5:1), never the metadata-only faint tier.
 */
export function ThinkingDisclosure({ text, running = false, continuesRail = false, className = "" }: ThinkingDisclosureProps) {
  const { t } = useT();
  const regionId = useId();
  const [open, setOpen] = useState(false);
  return (
    <div
      className={
        "th-chat-thinking th-chat-record" +
        (running ? " th-chat-thinking--running" : "") +
        (continuesRail ? " th-chat-record--continue" : "") +
        className
      }
    >
      <span className="th-chat-record-rail" aria-hidden="true" />
      <button
        type="button"
        className="th-chat-thinking-head"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="th-chat-thinking-dot" aria-hidden="true" />
        <span className="th-chat-thinking-label">{t("chat.thinking")}</span>
        <span className={`th-chat-thinking-chevron${open ? " th-chat-thinking-chevron--open" : ""}`} aria-hidden="true">
          <IconChevron size={12} />
        </span>
      </button>
      <div className="th-chat-thinking-body" id={regionId}>
        <div className="th-chat-thinking-body-inner">
          <pre>{text}</pre>
        </div>
      </div>
    </div>
  );
}
