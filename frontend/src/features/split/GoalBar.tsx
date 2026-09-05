import { useId, useState } from "react";
import { IconChevron } from "../../components/icons";
import { useT } from "../../i18n";
import type { ChatGoal } from "./goalState";
import { useShelfAvailableSpace } from "./useShelfAvailableSpace";

export interface GoalBarProps {
  readonly goal: ChatGoal | null;
}

/** Mirrors the `.th-goal-panel` max-height cap in chat-pane.css. */
const GOAL_PANEL_VIEWPORT_RATIO = 0.4;

function goalPanelMaxPx(): number {
  return Math.round(window.innerHeight * GOAL_PANEL_VIEWPORT_RATIO);
}

/** Expanded-panel height below which the panel would render as an
 *  unreadable sliver: the shelf collapses back to its summary bar instead
 *  (the bar's aria-expanded flips with it) until the column has room again. */
const GOAL_PANEL_FLOOR_PX = 48;

/**
 * Live-goal bar in the activity-shelf visual language: a collapsible
 * one-line summary (title, status chip, objective) that expands into a
 * panel with the unclamped objective and, when blocked, the reason.
 * Unknown statuses read as active.
 */
export function GoalBar({ goal }: GoalBarProps) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const [shelfElement, setShelfElement] = useState<HTMLElement | null>(null);
  const [panelElement, setPanelElement] = useState<HTMLDivElement | null>(null);
  const { availableSpacePx: columnClampPx } = useShelfAvailableSpace(
    open && goal !== null,
    shelfElement,
    panelElement,
  );
  if (goal === null) return null;

  // Expansion floor: clamped below a usable minimum, show the summary bar
  // only (never a sliver). `open` keeps the user's intent, so the panel
  // returns on its own when the column gains space again.
  const floorCollapsed = columnClampPx !== null && columnClampPx < GOAL_PANEL_FLOOR_PX;
  const expanded = open && !floorCollapsed;
  const panelMaxPx = columnClampPx === null
    ? null
    : Math.min(Math.max(columnClampPx, 0), goalPanelMaxPx());

  const tone = goal.status === "complete" ? "ok" : goal.status === "blocked" ? "error" : "running";
  const statusKey = goal.status === "complete"
    ? "chat.goal.statusComplete"
    : goal.status === "blocked"
      ? "chat.goal.statusBlocked"
      : "chat.goal.statusActive";

  return (
    <section
      ref={setShelfElement}
      className="th-goal-shelf"
      // See the clamp effect: no flexbox yield while the clamp is active.
      style={columnClampPx === null ? undefined : { flexShrink: 0 }}
    >
      <div className="th-activity-bar-row" role="status">
        <button
          type="button"
          className="th-activity-bar th-goal-bar"
          aria-expanded={expanded}
          aria-controls={panelId}
          aria-label={`${t("chat.goal.title")} — ${expanded ? t("chat.goal.collapse") : t("chat.goal.expand")}`}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="th-activity-bar-seg th-goal-title">{t("chat.goal.title")}</span>
          <span className={`th-activity-chip th-activity-chip--${tone}`}>{t(statusKey)}</span>
          <span className="th-activity-bar-text th-goal-summary">
            {goal.objective}
            {goal.objectiveTruncated ? "…" : ""}
          </span>
          <IconChevron
            size={12}
            className={`th-activity-caret${open ? " th-activity-caret--open" : ""}`}
          />
        </button>
      </div>
      {expanded && (
        <div
          ref={setPanelElement}
          id={panelId}
          role="group"
          aria-label={t("chat.goal.title")}
          className="th-goal-panel"
          style={panelMaxPx === null ? undefined : { maxHeight: `${panelMaxPx}px` }}
        >
          <div className="th-goal-content">
          <p className="th-goal-objective-full">
            {goal.objective}
            {goal.objectiveTruncated ? " …" : ""}
          </p>
          {goal.blockedReason && (
            <p className="th-goal-blocked-reason">{t("chat.goal.blockedReason")}: {goal.blockedReason}</p>
          )}
          </div>
        </div>
      )}
    </section>
  );
}
