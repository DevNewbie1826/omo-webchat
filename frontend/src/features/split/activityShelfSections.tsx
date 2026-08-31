import type { Translate } from "../../i18n";
import { agentFreshness, type AgentFreshnessContext } from "./activityState";
import {
  agoText,
  agentTimeMs,
  compactTokRate,
  lastActivityMs,
  statusKind,
  statusLabel,
  taskStatusCounts,
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

function AgentRow({ task, nowMs, freshnessCtx, t }: {
  readonly task: ActivityTask;
  readonly nowMs: number;
  readonly freshnessCtx: AgentFreshnessContext;
  readonly t: Translate;
}) {
  const freshness = agentFreshness(task, nowMs, freshnessCtx);
  const time = agentTimeMs(task);
  const lastMs = lastActivityMs(task);
  const progress = task.liveProgress;
  const tool = progress?.currentTool;
  const turns = progress?.turns;
  const lastLine = progress?.lastAssistantLine;
  const tokensPerSecond = progress?.tokensPerSecond;
  const toolCalls = progress?.toolCalls;
  const route = task.agentType ?? task.category;
  const title = task.taskSummary ?? task.name;
  return (
    <li
      className={`th-activity-agent${freshness === "severed" ? " th-activity-severed" : ""}`}
    >
      <span className="th-activity-agent-name">
        {route !== undefined ? `(${route}) - ${title}` : title}
      </span>
      <ActivityChip kind={statusKind(task.status)} label={statusLabel(t, task.status)} />
      {tool !== undefined && <span className="th-activity-agent-tool">{tool}</span>}
      {lastLine !== undefined && (
        <span className="th-activity-agent-lastline">{lastLine}</span>
      )}
      {turns !== undefined && (
        <span className="th-activity-agent-meta th-activity-agent-turns">
          {t("activity.turns")}
          {" "}
          {turns}
        </span>
      )}
      {toolCalls !== undefined && (
        <span className="th-activity-agent-meta th-activity-agent-toolcalls">
          {t("activity.toolCalls")}
          {" "}
          {toolCalls}
        </span>
      )}
      {tokensPerSecond !== undefined && (
        <span className="th-activity-agent-meta th-activity-agent-rate">
          {t("activity.tokensPerSecond", { n: compactTokRate(tokensPerSecond) })}
        </span>
      )}
      {time !== null && (
        <span className="th-activity-agent-meta">
          {t("activity.startedAgo", { n: agoText(nowMs - time) })}
        </span>
      )}
      {freshness === "quiet" && lastMs !== null && (
        <span className="th-activity-agent-meta th-activity-quiet-note">
          {t("activity.lastUpdateAgo", { n: agoText(nowMs - lastMs) })}
        </span>
      )}
      {freshness === "severed" && (
        <span className="th-activity-severed-note">{t("activity.severed")}</span>
      )}
    </li>
  );
}

export function AgentSection({ tasks, nowMs, freshnessCtx, t }: {
  readonly tasks: readonly ActivityTask[];
  readonly nowMs: number;
  readonly freshnessCtx: AgentFreshnessContext;
  readonly t: Translate;
}) {
  const { running, done } = taskStatusCounts(tasks);
  return (
    <section className="th-activity-section">
      <div className="th-activity-section-head">
        <span className="th-activity-section-title">{t("activity.agents")}</span>
        <span className="th-activity-section-counts">
          {t("activity.agentCounts", { running, done })}
        </span>
      </div>
      <ul className="th-activity-agents">
        {tasks.map((task) => (
          <AgentRow key={task.taskId} task={task} nowMs={nowMs} freshnessCtx={freshnessCtx} t={t} />
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
