import type { ParsedTaskUpdated } from "./activityParseTask";
import type { TaskDigest } from "../workspace/activityDigest";
import { parseDagUpdatedAt, type ParsedDagActivity } from "./activityParseDag";
import { TERMINAL_TASK_STATUSES } from "./activityShelfModel";
import type { ActivityTask } from "./activityTypes";

/** The PR86 RFC3339/millisecond profile, not receipt time or activity time. */
export const taskRevision = parseDagUpdatedAt;
const RAW_NONTERMINAL = new Set(["pending", "blocked", "scheduled", "running"]);

export function taskRawStatus(status: string, rawStatus: unknown): string | undefined {
  return typeof rawStatus === "string" && RAW_NONTERMINAL.has(rawStatus)
    && TERMINAL_TASK_STATUSES.has(status) ? rawStatus : undefined;
}

export interface TaskAuthority {
  readonly tasks: ReadonlyMap<string, ActivityTask>;
  /** Known revisions survive row omission until this pane/session owner retires. */
  readonly taskFreshness?: ReadonlyMap<string, number>;
  readonly truncatedTasks?: boolean;
  /** Server pre-truncation scalars; authoritative over the retained rows. */
  readonly taskRunningCount?: number;
  readonly taskTotalCount?: number;
  /** Oversized input without even a compact authority side is unknown. */
  readonly taskUnavailable?: boolean;
}

export function rawTaskRevision(task: ActivityTask): number | undefined {
  // Activity overlays explicitly capture even an unknown original raw clock.
  return taskRevision(task.activityAt === undefined ? task.updatedAt : task.rawUpdatedAt);
}

type TaskActivity = Pick<ParsedDagActivity, "at" | "activity" | "currentTool" | "lastAssistantLine" | "turns" | "toolCalls">;

export function applyTaskActivity(task: ActivityTask, activity: TaskActivity): ActivityTask {
  const incomingMs = taskRevision(activity.at)!;
  const activityMs = taskRevision(task.activityAt);
  const rawMs = rawTaskRevision(task);
  if ((activityMs !== undefined && incomingMs <= activityMs) || (rawMs !== undefined && incomingMs < rawMs)) return task;
  const progress = {
    ...task.activityProgress,
    ...(activity.activity === undefined ? {} : { activity: activity.activity }),
    ...(activity.currentTool === undefined ? {} : { currentTool: activity.currentTool }),
    ...(activity.lastAssistantLine === undefined ? {} : { lastAssistantLine: activity.lastAssistantLine }),
    ...(activity.turns === undefined ? {} : { turns: activity.turns }),
    ...(activity.toolCalls === undefined ? {} : { toolCalls: activity.toolCalls }),
  };
  return { ...task, rawUpdatedAt: task.activityAt === undefined ? task.updatedAt : task.rawUpdatedAt,
    updatedAt: activity.at, activityAt: activity.at, activityProgress: progress,
    liveProgress: { ...task.liveProgress, ...progress } };
}

function preserveActivity(previous: ActivityTask | undefined, incoming: ActivityTask): ActivityTask {
  if (previous?.activityAt === undefined) return incoming;
  return applyTaskActivity(incoming, { at: previous.activityAt, ...previous.activityProgress });
}

/** Equal raw versions retain all raw fields. Only provenance or missing compact
 * descriptions may change; a raw replay cannot erase an accepted correction. */
function equalTask(previous: ActivityTask, incoming: ActivityTask): ActivityTask {
  let next = previous;
  if (previous.compact === true && incoming.compact !== true) {
    const {
      status: _status, rawStatus: _rawStatus, updatedAt: _updatedAt, rawUpdatedAt: _rawUpdatedAt,
      activityAt: _activityAt, activityProgress: _activityProgress, truncated: _truncated, ...description
    } = incoming;
    next = { ...previous, ...description, compact: false };
    if (previous.activityProgress !== undefined) next = { ...next,
      liveProgress: { ...incoming.liveProgress, ...previous.activityProgress } };
  }
  if (previous.rawStatus === undefined && incoming.rawStatus === previous.status) {
    next = { ...next, status: incoming.status, rawStatus: incoming.rawStatus };
  }
  return next;
}

export function reconcileTaskAuthority<T extends TaskAuthority>(
  state: T,
  incoming: readonly ActivityTask[],
  options: { readonly truncated?: boolean | undefined; readonly partial?: boolean; readonly history?: boolean; readonly touched?: ReadonlySet<string>; readonly mergeOnly?: boolean; readonly taskRunningCount?: number; readonly taskTotalCount?: number } = {},
): T {
  const tasks = new Map(state.tasks);
  const taskFreshness = new Map(state.taskFreshness);
  const present = new Set(incoming.map(task => task.taskId));
  for (const [id, task] of tasks) {
    const revision = rawTaskRevision(task);
    if (revision !== undefined && !taskFreshness.has(id)) taskFreshness.set(id, revision);
    if (!options.mergeOnly && !options.truncated && !present.has(id) && !options.touched?.has(id)
      && (options.history || !TERMINAL_TASK_STATUSES.has(task.status))) tasks.delete(id);
  }
  let admitted = false;
  for (const row of incoming) {
    const revision = rawTaskRevision(row);
    const known = taskFreshness.get(row.taskId);
    const previous = tasks.get(row.taskId);
    if (known !== undefined && (revision === undefined || revision < known)) continue;
    if (known !== undefined && revision === known) {
      if (previous !== undefined) tasks.set(row.taskId, equalTask(previous, row));
      continue;
    }
    admitted = true;
    tasks.set(row.taskId, preserveActivity(previous, { ...row, truncated: options.truncated === true || options.partial === true }));
    if (revision !== undefined) {
      taskFreshness.delete(row.taskId);
      taskFreshness.set(row.taskId, revision);
    }
  }
  const sameTasks = tasks.size === state.tasks.size && [...tasks].every(([id, row]) => state.tasks.get(id) === row);
  const sameFreshness = taskFreshness.size === (state.taskFreshness?.size ?? 0)
    && [...taskFreshness].every(([id, revision]) => state.taskFreshness?.get(id) === revision);
  const truncatedTasks = options.truncated === true || options.partial === true || [...tasks.values()].some(task => task.truncated === true || task.compact === true)
    || (state.truncatedTasks === true && !admitted && incoming.length > 0);
  const taskUnavailable = state.taskUnavailable === true && !admitted && (incoming.length > 0 || options.mergeOnly === true);
  const taskRunningCount = options.taskRunningCount ?? state.taskRunningCount;
  const taskTotalCount = options.taskTotalCount ?? state.taskTotalCount;
  if (sameTasks && sameFreshness && truncatedTasks === (state.truncatedTasks ?? false)
    && taskUnavailable === (state.taskUnavailable ?? false)
    && taskRunningCount === state.taskRunningCount && taskTotalCount === state.taskTotalCount) return state;
  return { ...state, tasks: sameTasks ? state.tasks : tasks,
    taskFreshness: sameFreshness ? state.taskFreshness : taskFreshness, truncatedTasks, taskUnavailable,
    ...(taskRunningCount === state.taskRunningCount ? {} : { taskRunningCount }),
    ...(taskTotalCount === state.taskTotalCount ? {} : { taskTotalCount }) };
}

/** A compact side and its rich prefix form one membership envelope. Reconcile
 * the compact authority first, then enrich without a second omission operation. */
export function reconcileTaskSources<T extends TaskAuthority>(
  state: T, rich: ParsedTaskUpdated | null, digest: TaskDigest | undefined,
  options: { readonly history?: boolean; readonly touched?: ReadonlySet<string>; readonly oversized?: boolean } = {},
): T {
  if (rich === null && digest === undefined) return options.oversized === true
    ? { ...reconcileTaskAuthority(state, [], { mergeOnly: true, truncated: true }), taskUnavailable: true } : state;
  const truncated = digest === undefined ? rich?.truncatedTasks === true || options.oversized === true : digest.truncated;
  const partial = rich?.truncatedTasks === true || options.oversized === true;
  const scalars = {
    ...(digest?.taskRunningCount === undefined ? {} : { taskRunningCount: digest.taskRunningCount }),
    ...(digest?.taskTotalCount === undefined ? {} : { taskTotalCount: digest.taskTotalCount }),
    ...(rich?.taskRunningCount === undefined ? {} : { taskRunningCount: rich.taskRunningCount }),
    ...(rich?.taskTotalCount === undefined ? {} : { taskTotalCount: rich.taskTotalCount }),
  };
  if (digest === undefined) return reconcileTaskAuthority(state, rich!.tasks, { ...options, truncated, ...scalars });
  // Unknown revisions are still arrival-ordered, once per source envelope.
  // Carry matching unknown rich descriptions in the compact row rather than
  // applying the same envelope twice as two unknown raw mutations.
  const descriptions = new Map(rich?.tasks.map(task => [task.taskId, task]));
  const rows = digest.tasks.map(task => {
    const description = descriptions.get(task.taskId);
    if (taskRevision(task.updatedAt) === undefined && description !== undefined
      && rawTaskRevision(description) === undefined) {
      const { rawStatus: _rawStatus, ...fields } = description;
      return { ...fields, ...task, compact: false };
    }
    return { ...task, name: task.taskId, compact: true };
  });
  let next = reconcileTaskAuthority(state, rows, { ...options, truncated, partial: partial && rows.length > 0, ...scalars });
  const knownDescriptions = (rich?.tasks ?? []).filter(task => next.tasks.has(task.taskId) && rawTaskRevision(task) !== undefined);
  next = reconcileTaskAuthority(next, knownDescriptions, { mergeOnly: true, truncated, partial: partial && rows.length > 0 });
  return next;
}

/** Alias migration is a union of per-ID decisions, including removed-row clocks. */
export function mergeTaskAuthorities(first: TaskAuthority, second: TaskAuthority): TaskAuthority {
  let merged = reconcileTaskAuthority(first, [...second.tasks.values()], { mergeOnly: true });
  const tasks = new Map(merged.tasks), taskFreshness = new Map(merged.taskFreshness);
  for (const [id, row] of second.tasks) {
    const current = tasks.get(id);
    if (current !== undefined) tasks.set(id, preserveActivity(row, current));
  }
  for (const [id, revision] of second.taskFreshness ?? []) {
    const known = taskFreshness.get(id);
    if (known !== undefined && known > revision) continue;
    if (!second.tasks.has(id)) tasks.delete(id);
    taskFreshness.set(id, revision);
  }
  merged = { ...merged, tasks, taskFreshness, truncatedTasks: first.truncatedTasks === true || second.truncatedTasks === true,
    taskUnavailable: first.taskUnavailable === true || second.taskUnavailable === true,
    ...(second.taskRunningCount === undefined ? {} : { taskRunningCount: second.taskRunningCount }),
    ...(second.taskTotalCount === undefined ? {} : { taskTotalCount: second.taskTotalCount }) };
  return reconcileTaskAuthority(merged, [], { mergeOnly: true, truncated: merged.truncatedTasks });
}

/** Wire projection for existing shelf/sidebar parsers. Activity never changes updated_at. */
export function taskAuthorityPayload(authority: TaskAuthority): unknown {
  return { truncated_tasks: authority.truncatedTasks === true,
    ...(authority.taskRunningCount === undefined ? {} : { running_count: authority.taskRunningCount }),
    ...(authority.taskTotalCount === undefined ? {} : { total_count: authority.taskTotalCount }),
    tasks: [...authority.tasks.values()].map(task => ({
    task_id: task.taskId, name: task.name, status: task.status,
    raw_status: task.rawStatus, updated_at: task.activityAt === undefined ? task.updatedAt : task.rawUpdatedAt,
    task_summary: task.taskSummary, agent_type: task.agentType, category: task.category, model: task.model,
    created_at: task.createdAt, final_response: task.finalResponse, error_message: task.errorMessage,
    live_progress: task.liveProgress === undefined ? undefined : {
      activity: task.liveProgress.activity, started_at: task.liveProgress.startedAt,
      current_tool: task.liveProgress.currentTool, last_assistant_line: task.liveProgress.lastAssistantLine,
      turns: task.liveProgress.turns, tool_calls: task.liveProgress.toolCalls,
      total_tokens: task.liveProgress.totalTokens, tokens_per_second: task.liveProgress.tokensPerSecond,
    },
  })) };
}
