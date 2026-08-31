import {
  parseDagActivity,
  parseDagHeartbeat,
  parseDagUpdated,
  parseTaskUpdated,
  parseTodoDetails,
  type ParsedDagActivity,
} from "./activityParse";
import type {
  ActivityDagNode,
  ActivityDagRun,
  ActivityHeartbeat,
  ActivityLiveProgress,
  ActivityState,
  ActivityTask,
} from "./activityTypes";
import { TERMINAL_DAG_STATUSES, TERMINAL_TASK_STATUSES, lastActivityMs } from "./activityShelfModel";

/* The terminal-status rule lives once in activityShelfModel.ts (exported for
   the shelf); this module imports it instead of keeping a second copy that
   could drift. */

// Measured against real omo captures: active work emits event bursts with a
// max quiet gap of ~6.7s, so 30s of quiet means something stalled and 90s
// means the signal is gone.
export const STALE_ACTIVITY_MS = 30_000;
export const SEVERED_ACTIVITY_MS = 90_000;

export function emptyActivityState(): ActivityState {
  return { tasks: new Map(), dags: new Map(), todo: null, heartbeats: new Map() };
}

/**
 * Flip the chat-run latch that gates shelf staleness. Wired to the
 * run.started/run.done frames in useChatFrameHandler; a no-op (same
 * reference) when the flag already matches so the version bump stays honest.
 */
export function applyRunFlight(state: ActivityState, inFlight: boolean): ActivityState {
  if ((state.runInFlight ?? false) === inFlight) return state;
  return { ...state, runInFlight: inFlight };
}

export type AgentFreshness = "fresh" | "stale" | "severed";

/**
 * Freshness of an agent row, judged only while a run is in flight: an idle
 * pane never cries stale. >30s of quiet is stale; >90s means the run is in
 * flight but the agent has gone silent - a distinct severed state.
 */
export function agentFreshness(task: ActivityTask, nowMs: number, runInFlight: boolean): AgentFreshness {
  if (!runInFlight || TERMINAL_TASK_STATUSES.has(task.status)) return "fresh";
  const lastMs = lastActivityMs(task);
  if (lastMs === null) return "fresh";
  const quietMs = nowMs - lastMs;
  if (quietMs > SEVERED_ACTIVITY_MS) return "severed";
  if (quietMs > STALE_ACTIVITY_MS) return "stale";
  return "fresh";
}

function isTerminalTask(task: ActivityTask): boolean {
  // Snapshot replace: keep previous entries only when they are terminal and
  // absent from the new snapshot.
  return TERMINAL_TASK_STATUSES.has(task.status);
}

function isTerminalDag(run: ActivityDagRun): boolean {
  return TERMINAL_DAG_STATUSES.has(run.status);
}

function replaceKeepingTerminal<T>(
  previous: ReadonlyMap<string, T>,
  incoming: readonly T[],
  policy: {
    readonly keyOf: (item: T) => string;
    readonly keepPrevious: (item: T) => boolean;
    readonly merge: (prev: T | undefined, next: T) => T;
  },
): Map<string, T> {
  const present = new Set(incoming.map(policy.keyOf));
  const next = new Map<string, T>();
  for (const [key, item] of previous) {
    if (!present.has(key) && policy.keepPrevious(item)) next.set(key, item);
  }
  for (const item of incoming) {
    const key = policy.keyOf(item);
    next.set(key, policy.merge(previous.get(key), item));
  }
  return next;
}

function mergePreservedNode(previous: ActivityDagNode | undefined, incoming: ActivityDagNode): ActivityDagNode {
  if (previous === undefined) return incoming;
  return {
    ...incoming,
    ...(incoming.taskId === undefined && previous.taskId !== undefined ? { taskId: previous.taskId } : {}),
    ...(incoming.activity === undefined && previous.activity !== undefined ? { activity: previous.activity } : {}),
    ...(incoming.currentTool === undefined && previous.currentTool !== undefined
      ? { currentTool: previous.currentTool }
      : {}),
    ...(incoming.lastAssistantLine === undefined && previous.lastAssistantLine !== undefined
      ? { lastAssistantLine: previous.lastAssistantLine }
      : {}),
    ...(incoming.turns === undefined && previous.turns !== undefined ? { turns: previous.turns } : {}),
    ...(incoming.toolCalls === undefined && previous.toolCalls !== undefined ? { toolCalls: previous.toolCalls } : {}),
    ...(incoming.lastActivityAt === undefined && previous.lastActivityAt !== undefined
      ? { lastActivityAt: previous.lastActivityAt }
      : {}),
  };
}

function mergeDagRun(previous: ActivityDagRun | undefined, incoming: ActivityDagRun): ActivityDagRun {
  if (previous === undefined) return incoming;
  const prevNodes = new Map(previous.nodes.map((node) => [node.id, node]));
  return {
    ...incoming,
    nodes: incoming.nodes.map((node) => mergePreservedNode(prevNodes.get(node.id), node)),
    ...(incoming.lastActivityAt === undefined && previous.lastActivityAt !== undefined
      ? { lastActivityAt: previous.lastActivityAt }
      : {}),
  };
}

function applyTaskSnapshot(state: ActivityState, data: unknown): ActivityState {
  const parsed = parseTaskUpdated(data);
  if (parsed === null) return state;
  return {
    ...state,
    tasks: replaceKeepingTerminal(state.tasks, parsed.tasks, {
      keyOf: (task) => task.taskId,
      keepPrevious: isTerminalTask,
      merge: (_prev, next) => next,
    }),
  };
}

function applyDagSnapshot(state: ActivityState, data: unknown): ActivityState {
  const parsed = parseDagUpdated(data);
  if (parsed === null) return state;
  return {
    ...state,
    dags: replaceKeepingTerminal(state.dags, parsed.runs, {
      keyOf: (run) => run.runId,
      keepPrevious: isTerminalDag,
      merge: mergeDagRun,
    }),
  };
}

function liveProgressFromActivity(
  activity: ParsedDagActivity,
  previous: ActivityLiveProgress | undefined,
): ActivityLiveProgress {
  return {
    ...previous,
    ...(activity.activity !== undefined ? { activity: activity.activity } : {}),
    ...(activity.currentTool !== undefined ? { currentTool: activity.currentTool } : {}),
    ...(activity.lastAssistantLine !== undefined ? { lastAssistantLine: activity.lastAssistantLine } : {}),
    ...(activity.turns !== undefined ? { turns: activity.turns } : {}),
    ...(activity.toolCalls !== undefined ? { toolCalls: activity.toolCalls } : {}),
  };
}

function applyNodeActivity(state: ActivityState, data: unknown): ActivityState {
  const parsed = parseDagActivity(data);
  if (parsed === null) return state;
  const run = state.dags.get(parsed.runId);
  if (run === undefined) return state;
  let matched = false;
  const nodes = run.nodes.map((node) => {
    if (node.id !== parsed.nodeId) return node;
    matched = true;
    return {
      ...node,
      ...(parsed.taskId !== undefined ? { taskId: parsed.taskId } : {}),
      ...(parsed.activity !== undefined ? { activity: parsed.activity } : {}),
      ...(parsed.currentTool !== undefined ? { currentTool: parsed.currentTool } : {}),
      ...(parsed.lastAssistantLine !== undefined ? { lastAssistantLine: parsed.lastAssistantLine } : {}),
      ...(parsed.turns !== undefined ? { turns: parsed.turns } : {}),
      ...(parsed.toolCalls !== undefined ? { toolCalls: parsed.toolCalls } : {}),
      lastActivityAt: parsed.at,
    };
  });
  if (!matched) return state;
  const dags = new Map(state.dags);
  dags.set(parsed.runId, { ...run, nodes, lastActivityAt: parsed.at });
  if (parsed.taskId === undefined) return { ...state, dags };
  const task = state.tasks.get(parsed.taskId);
  if (task === undefined) return { ...state, dags };
  const tasks = new Map(state.tasks);
  // The heartbeat is the freshest evidence of life for the task row the shelf
  // keeps after taskId dedup drops the node projection - stamp updatedAt so
  // staleness follows the heartbeat, not the last task.updated event.
  tasks.set(parsed.taskId, {
    ...task,
    ...(parsed.at > (task.updatedAt ?? "") ? { updatedAt: parsed.at } : {}),
    liveProgress: liveProgressFromActivity(parsed, task.liveProgress),
  });
  return { ...state, dags, tasks };
}

function applyHeartbeat(state: ActivityState, data: unknown): ActivityState {
  const parsed = parseDagHeartbeat(data);
  if (parsed === null) return state;
  const heartbeats = new Map<string, ActivityHeartbeat>();
  for (const run of parsed.runs) {
    heartbeats.set(run.runId, { runId: run.runId, headSeq: run.headSeq, at: parsed.at });
  }
  return { ...state, heartbeats };
}

export function applyActivityEvent(state: ActivityState, name: string, data: unknown): ActivityState {
  switch (name) {
    case "omo.task.updated":
      return applyTaskSnapshot(state, data);
    case "omo.dag.updated":
      return applyDagSnapshot(state, data);
    case "omo.dag.activity":
      return applyNodeActivity(state, data);
    case "omo.dag.heartbeat":
      return applyHeartbeat(state, data);
    default:
      return state;
  }
}

export function applyTodoToolDetails(state: ActivityState, details: unknown): ActivityState {
  const parsed = parseTodoDetails(details);
  if (parsed === null) return state;
  return { ...state, todo: parsed.phases };
}
