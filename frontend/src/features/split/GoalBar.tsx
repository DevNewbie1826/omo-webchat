import { useId, useState } from "react";
import { IconChevron } from "../../components/icons";
import { useT } from "../../i18n";
import type { ChatGoal } from "./goalState";

export interface GoalBarProps {
  readonly goal: ChatGoal | null;
}

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
  if (goal === null) return null;

  const tone = goal.status === "complete" ? "ok" : goal.status === "blocked" ? "error" : "running";
  const statusKey = goal.status === "complete"
    ? "chat.goal.statusComplete"
    : goal.status === "blocked"
      ? "chat.goal.statusBlocked"
      : "chat.goal.statusActive";

  return (
    <section className="th-goal-shelf">
      <div className="th-activity-bar-row" role="status">
        <button
          type="button"
          className="th-activity-bar th-goal-bar"
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={`${t("chat.goal.title")} — ${open ? t("chat.goal.collapse") : t("chat.goal.expand")}`}
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
      {open && (
        <div id={panelId} role="group" aria-label={t("chat.goal.title")} className="th-goal-panel">
          <p className="th-goal-objective-full">
            {goal.objective}
            {goal.objectiveTruncated ? " …" : ""}
          </p>
          {goal.blockedReason && (
            <p className="th-goal-blocked-reason">{t("chat.goal.blockedReason")}: {goal.blockedReason}</p>
          )}
        </div>
      )}
    </section>
  );
}
