import type { Translate } from "../../i18n";
import { STALE_ACTIVITY_MS } from "./activityState";
import {
  agoText,
  agentTimeMs,
  lastActivityMs,
  statusKind,
  statusLabel,
  TERMINAL_TASK_STATUSES,
  type StatusKind,
} from "./activityShelfModel";
import type { ActivityTask, TodoPhase, TodoTask } from "./activityTypes";

const TODO_MARKERS: Readonly<Record<TodoTask["status"], string>> = {
  completed: "[✓]",
  in_progress: "[•]",
  abandoned: "[×]",
  pending: "[ ]",
};

export function ActivityChip({ kind, label }: {
  readonly kind: StatusKind;
  readonly label: string;
}) {
  return <span className={`th-activity-chip th-activity-chip--${kind}`}>{label}</span>;
}

function AgentRow({ task, nowMs, t }: {
  readonly task: ActivityTask;
  readonly nowMs: number;
  readonly t: Translate;
}) {
  const lastMs = lastActivityMs(task);
  const time = agentTimeMs(task);
  const stale = !TERMINAL_TASK_STATUSES.has(task.status)
    && lastMs !== null
    && nowMs - lastMs > STALE_ACTIVITY_MS;
  const tool = task.liveProgress?.currentTool;
  const turns = task.liveProgress?.turns;
  const route = task.agentType ?? task.category;
  const title = task.taskSummary ?? task.name;
  return (
    <li className={`th-activity-agent${stale ? " th-activity-stale" : ""}`}>
      <span className="th-activity-agent-name">
        {route !== undefined ? `(${route}) - ${title}` : title}
      </span>
      <ActivityChip kind={statusKind(task.status)} label={statusLabel(t, task.status)} />
      {tool !== undefined && <span className="th-activity-agent-tool">{tool}</span>}
      {turns !== undefined && (
        <span className="th-activity-agent-meta th-activity-agent-turns">
          {t("activity.turns")}
          {" "}
          {turns}
        </span>
      )}
      {time !== null && (
        <span className="th-activity-agent-meta">
          {t("activity.startedAgo", { n: agoText(nowMs - time) })}
        </span>
      )}
      {stale && <span className="th-activity-stale-note">{t("activity.stale")}</span>}
    </li>
  );
}

export function AgentSection({ tasks, nowMs, t }: {
  readonly tasks: readonly ActivityTask[];
  readonly nowMs: number;
  readonly t: Translate;
}) {
  return (
    <section className="th-activity-section">
      <span className="th-activity-section-title">{t("activity.agents")}</span>
      <ul className="th-activity-agents">
        {tasks.map((task) => (
          <AgentRow key={task.taskId} task={task} nowMs={nowMs} t={t} />
        ))}
      </ul>
    </section>
  );
}

export function TodoSection({ phases, t }: {
  readonly phases: readonly TodoPhase[];
  readonly t: Translate;
}) {
  return (
    <section className="th-activity-section">
      <span className="th-activity-section-title">{t("activity.todo")}</span>
      <ul className="th-activity-phases">
        {phases.map((phase) => (
          <li key={phase.name} className="th-activity-phase">
            <span className="th-activity-phase-name">{phase.name}</span>
            <ul>
              {phase.tasks.map((task, index) => (
                <li
                  key={`${phase.name}:${index}`}
                  className={`th-activity-todo-task th-activity-todo-task--${task.status}`}
                >
                  <span className="th-activity-todo-marker" aria-hidden="true">
                    {TODO_MARKERS[task.status]}
                  </span>
                  <span className="th-activity-sr">{task.status.replace("_", " ")}</span>
                  <span className="th-activity-todo-text">{task.content}</span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}
