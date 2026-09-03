import { useT } from "../../i18n";
import type { ChatGoal } from "./goalState";

export interface GoalBannerProps {
  readonly goal: ChatGoal;
}

/**
 * Stage-13 goal banner: the chat's live goal (objective + status + blocked
 * reason), hydrated at attach and updated live via chat.goal pushes while
 * the session is attached.
 */
export function GoalBanner({ goal }: GoalBannerProps) {
  const { t } = useT();
  const blocked = goal.status === "blocked";
  const statusKey = goal.status === "complete"
    ? "chat.goal.statusComplete"
    : blocked
      ? "chat.goal.statusBlocked"
      : "chat.goal.statusActive";
  return (
    <div className={`th-alert${blocked ? " th-alert--warning" : " th-alert--info"} th-goal-banner`} role="status">
      <span className="th-goal-headline">
        <strong>{t("chat.goal.title")}</strong>
        <span className={`th-goal-status th-goal-status--${goal.status || "active"}`}>{t(statusKey)}</span>
      </span>
      <p className="th-goal-objective">
        {goal.objective}
        {goal.objectiveTruncated ? "…" : ""}
      </p>
      {goal.blockedReason && <p className="th-goal-blocked">{t("chat.goal.blockedReason")}: {goal.blockedReason}</p>}
    </div>
  );
}
