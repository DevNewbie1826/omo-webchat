import type { Translate } from "../../i18n";
import { agentFreshness, type AgentFreshnessContext } from "./activityState";
import {
  agoText,
  agentTimeMs,
  compactTokRate,
  glyphKind,
  lastActivityMs,
  statusKind,
  statusLabel,
  type GlyphKind,
  type StatusKind,
} from "./activityShelfModel";
import type { ActivityTask, TodoPhase } from "./activityTypes";

export function ActivityChip({ kind, label }: {
  readonly kind: StatusKind;
  readonly label: string;
}) {
  return <span className={`th-activity-chip th-activity-chip--${kind}`}>{label}</span>;
}

/** Rail lane (drawn by CSS pseudo-elements); `live` spins only observably running work. */
function StatusGlyph({ kind, live = false }: {
  readonly kind: GlyphKind;
  readonly live?: boolean;
}) {
  return (
    <span className="th-activity-lane" aria-hidden="true">
      <span className={`th-activity-glyph th-activity-glyph--${kind}${live ? " th-activity-glyph--live" : ""}`} />
    </span>
  );
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
  // Severed work is not observably progressing: alarm glyph, no spin.
  const glyph: GlyphKind = freshness === "severed" ? "error" : glyphKind(task.status);
  const hasDetail = tool !== undefined || lastLine !== undefined || turns !== undefined
    || toolCalls !== undefined || tokensPerSecond !== undefined;
  return (
    <li
      className={`th-activity-agent th-activity-agent--${glyph}${freshness === "severed" ? " th-activity-severed" : ""}`}
    >
      <StatusGlyph kind={glyph} live={glyph === "running"} />
      <div className="th-activity-agent-body">
        <div className="th-activity-agent-head">
          <span className="th-activity-agent-name">
            {route !== undefined ? `(${route}) - ${title}` : title}
          </span>
          <ActivityChip kind={statusKind(task.status)} label={statusLabel(t, task.status)} />
          <span className="th-activity-agent-trail">
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
          </span>
        </div>
        {hasDetail && (
          <div className="th-activity-agent-detail">
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
          </div>
        )}
      </div>
    </li>
  );
}

export function AgentSection({ tasks, nowMs, freshnessCtx, t }: {
  readonly tasks: readonly ActivityTask[];
  readonly nowMs: number;
  readonly freshnessCtx: AgentFreshnessContext;
  readonly t: Translate;
}) {
  // The tab carries the section title and compact counts; the panel body
  // stays pure rows.
  return (
    <section className="th-activity-section">
      <ul className="th-activity-agents th-activity-timeline">
        {tasks.map((task) => (
          <AgentRow key={task.taskId} task={task} nowMs={nowMs} freshnessCtx={freshnessCtx} t={t} />
        ))}
      </ul>
    </section>
  );
}

export function TodoSection({ phases, runInFlight, t }: {
  readonly phases: readonly TodoPhase[];
  readonly runInFlight: boolean;
  readonly t: Translate;
}) {
  // The tab carries the section title; the panel body stays pure phases.
  return (
    <section className="th-activity-section">
      <ul className="th-activity-phases">
        {phases.map((phase) => (
          <li key={phase.name} className="th-activity-phase">
            <span className="th-activity-phase-name">{phase.name}</span>
            <ul className="th-activity-timeline">
              {phase.tasks.map((task, index) => (
                <li
                  key={`${phase.name}:${index}`}
                  className={`th-activity-todo-task th-activity-todo-task--${task.status}`}
                >
                  <StatusGlyph kind={glyphKind(task.status)} live={runInFlight && task.status === "in_progress"} />
                  <span className="th-activity-sr">{t(`activity.todoStatus.${task.status}`)}</span>
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
