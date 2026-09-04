import { useId, useState } from "react";
import { IconArrowUp, IconChevron, IconTrash } from "../../components/icons";
import { useT } from "../../i18n";
import type { QueueEngineSummary, QueuePlaceholder, QueueSlotItem, SteerPendingItem } from "./chatSessionTypes";

export type QueueClearScope = "webchat" | "engine" | "all";

interface QueuePanelProps {
  /** Webchat-owned queued sends, head-first (server queue snapshot order). */
  readonly items: readonly QueueSlotItem[];
  /** Engine queue mirror as reported by the server queue frame. */
  readonly engine: QueueEngineSummary;
  /** Local submissions awaiting their confirming queue frame. */
  readonly placeholders: readonly QueuePlaceholder[];
  /** Steers forwarded to the engine whose user echo has not rendered yet. */
  readonly steerPending: readonly SteerPendingItem[];
  readonly onRemove: (itemId: string) => boolean | void;
  readonly onMove: (itemId: string, toIndex: number) => boolean | void;
  readonly onClear: (scope: QueueClearScope) => boolean | void;
}

/**
 * Fixed queue slot between the shelves and the composer: run-time pending
 * feedback lives here, never inside the transcript scrollport. The header
 * stays visible as a compact count; the list expands on demand. Queued items
 * carry a distinct waiting style so they cannot be mistaken for sent
 * messages; engine-queue rows are a read-only mirror.
 */
export function QueuePanel({ items, engine, placeholders, steerPending, onRemove, onMove, onClear }: QueuePanelProps) {
  const { t } = useT();
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  if (items.length === 0 && placeholders.length === 0 && engine.pendingMessageCount === 0) return null;
  const count = items.length + placeholders.length;

  return (
    <section className="th-queue" role="region" aria-label={t("queue.region")}>
      <button
        type="button"
        className="th-queue-header"
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        onClick={() => setExpanded((open) => !open)}
      >
        <span className="th-queue-title">{t("queue.count", { count })}</span>
        {engine.pendingMessageCount > 0 && (
          <span className="th-queue-engine">{t("queue.engineCount", { count: engine.pendingMessageCount })}</span>
        )}
        <IconChevron size={12} className={`th-queue-chevron${expanded ? " th-queue-chevron--open" : ""}`} />
      </button>
      {expanded && (
        <div className="th-queue-body" id={listId}>
          <ul className="th-queue-list">
            {items.map((item, index) => (
              <li key={item.id} className="th-queue-row th-queue-row--waiting">
                <span className="th-queue-pos">{index + 1}</span>
                <span className="th-queue-text" title={item.text}>{item.text}</span>
                <span className="th-queue-actions">
                  <button
                    type="button"
                    className="th-btn-icon th-queue-btn"
                    aria-label={t("queue.moveUp")}
                    disabled={index === 0}
                    onClick={() => onMove(item.id, index - 1)}
                  >
                    <IconArrowUp size={12} />
                  </button>
                  <button
                    type="button"
                    className="th-btn-icon th-queue-btn th-queue-btn--down"
                    aria-label={t("queue.moveDown")}
                    disabled={index === items.length - 1}
                    onClick={() => onMove(item.id, index + 1)}
                  >
                    <IconArrowUp size={12} />
                  </button>
                  <button
                    type="button"
                    className="th-btn-icon th-queue-btn th-queue-btn--remove"
                    aria-label={t("queue.remove")}
                    onClick={() => onRemove(item.id)}
                  >
                    <IconTrash size={12} />
                  </button>
                </span>
              </li>
            ))}
            {placeholders.map((placeholder) => (
              <li
                key={placeholder.requestId}
                className="th-queue-row th-queue-row--waiting th-queue-row--placeholder"
              >
                <span className="th-queue-text" title={placeholder.text}>
                  {t("queue.waiting")}
                  {placeholder.text ? `: ${placeholder.text}` : ""}
                </span>
              </li>
            ))}
            {engine.ordered.map((engineItem, index) => (
              <li key={`engine-${index}`} className="th-queue-row th-queue-row--engine">
                <span className="th-queue-text" title={engineItem.text}>{engineItem.text}</span>
              </li>
            ))}
          </ul>
          {count > 0 || engine.pendingMessageCount > 0 ? (
            <button type="button" className="th-btn th-btn--ghost th-queue-clear" onClick={() => onClear("all")}>
              {t("queue.clearAll")}
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}
