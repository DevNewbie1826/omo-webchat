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

// Freshness is edge-triggered, not level-triggered: goal-continuation wakes
// start runs whose tasks legitimately stay quiet for minutes, so elapsed
// quiet alone proves nothing. Only a task that showed life during THIS run
// (a frame actually changed it) can then be declared severed after 90s of
// quiet; every other in-flight row is merely quiet. STALE_ACTIVITY_MS no
// longer gates any alarm (kept only for external reference).
export const STALE_ACTIVITY_MS = 30_000;
export const SEVERED_ACTIVITY_MS = 90_000;
export const ACTIVITY_HYDRATION_SIDE_LIMIT = 100;

export type ActivityEventName =
  | "omo.task.updated"
  | "omo.dag.updated"
  | "omo.dag.activity"
  | "omo.dag.heartbeat";

export interface BufferedActivityEvent {
  readonly name: ActivityEventName;
  readonly data: unknown;
  readonly side: "task" | "dag";
  readonly key: string;
  readonly snapshot: boolean;
}

export interface ActivityHydrationBuffer {
  readonly events: BufferedActivityEvent[];
  dropped: number;
  taskSuperseded: boolean;
  dagSuperseded: boolean;
}

export function createActivityHydrationBuffer(): ActivityHydrationBuffer {
  return { events: [], dropped: 0, taskSuperseded: false, dagSuperseded: false };
}

/** Validate and classify activity extension payloads before retaining them. */
export function validatedActivityEvent(name: string, data: unknown): BufferedActivityEvent | null {
  switch (name) {
    case "omo.task.updated":
      return parseTaskUpdated(data) === null
        ? null
        : { name, data, side: "task", key: name, snapshot: true };
    case "omo.dag.updated":
      return parseDagUpdated(data) === null
        ? null
        : { name, data, side: "dag", key: name, snapshot: true };
    case "omo.dag.activity": {
      const parsed = parseDagActivity(data);
      return parsed === null
        ? null
        : { name, data, side: "dag", key: `${name}:${parsed.runId}:${parsed.nodeId}`, snapshot: false };
    }
    case "omo.dag.heartbeat":
      return parseDagHeartbeat(data) === null
        ? null
        : { name, data, side: "dag", key: name, snapshot: false };
    default:
      return null;
  }
}

/** Retain only recent, relevant activity while REST hydration is pending. */
export function bufferActivityHydrationEvent(
  buffer: ActivityHydrationBuffer,
  event: BufferedActivityEvent,
): void {
  if (event.snapshot) {
    if (event.side === "task") buffer.taskSuperseded = true;
    else buffer.dagSuperseded = true;
  }
  const previousIndex = buffer.events.findIndex((item) => item.key === event.key);
  let nextEvent = event;
  if (previousIndex >= 0) {
    const previous = buffer.events[previousIndex]!;
    buffer.events.splice(previousIndex, 1);
    if (!event.snapshot && typeof previous.data === "object" && previous.data !== null
      && typeof event.data === "object" && event.data !== null) {
      nextEvent = { ...event, data: { ...previous.data, ...event.data } };
    }
  }
  buffer.events.push(nextEvent);
  const sideCount = buffer.events.reduce((count, item) => count + (item.side === event.side ? 1 : 0), 0);
  if (sideCount <= ACTIVITY_HYDRATION_SIDE_LIMIT) return;
  const oldest = buffer.events.findIndex((item) => item.side === event.side);
  if (oldest >= 0) {
    buffer.events.splice(oldest, 1);
    buffer.dropped += 1;
  }
}

/**
 * ActivityState extended with the per-run life latches this module manages.
 * Declared here (not in activityTypes.ts) so the whole lane lives in one
 * file; reducers attach the field, UI reads it through lifeSeenThisRunOf.
 */
export interface LifeLatchedActivityState extends ActivityState {
  /** Task ids that showed life (any frame change) during the current run. */
  readonly lifeSeenThisRun?: ReadonlySet<string>;
}

/** The latch set of a state, never null: absent means nothing latched yet. */
export function lifeSeenThisRunOf(state: ActivityState): ReadonlySet<string> {
  return (state as LifeLatchedActivityState).lifeSeenThisRun ?? new Set<string>();
}

export function emptyActivityState(): ActivityState {
  return { tasks: new Map(), dags: new Map(), todo: null, heartbeats: new Map() };
}

/**
 * Flip the chat-run latch that gates shelf freshness. Wired to the
 * run.started/run.done frames in useChatFrameHandler. An idle no-op keeps the
 * same reference. Every observation of an in-flight run resets task life
 * latches, including true->true after reconnect, because run boundaries may
 * have occurred while the socket was disconnected. Stopping drops the latch
 * set entirely.
 */
export function applyRunFlight(state: ActivityState, inFlight: boolean): ActivityState {
  if (!inFlight) {
    if ((state.runInFlight ?? false) === false) return state;
    const next: ActivityState & { lifeSeenThisRun?: ReadonlySet<string> } = { ...state, runInFlight: false };
    delete next.lifeSeenThisRun;
    return next;
  }
  const next: LifeLatchedActivityState = { ...state, runInFlight: true, lifeSeenThisRun: new Set<string>() };
  return next;
}

export type AgentFreshness = "fresh" | "quiet" | "severed";

/** Everything agentFreshness judges a row against. */
export interface AgentFreshnessContext {
  readonly runInFlight: boolean;
  /** Task ids that showed life at least once during the current run. */
  readonly lifeSeenThisRun: ReadonlySet<string>;
}

/**
 * Freshness of an agent row, judged only while a run is in flight: an idle
 * pane is always fresh. A non-terminal row is "severed" only when it showed
 * life this run and then went quiet past SEVERED_ACTIVITY_MS - the real
 * mid-run death signal. Every other in-flight row is "quiet": muted, with
 * an informational last-update age, never an alarm.
 */
export function agentFreshness(task: ActivityTask, nowMs: number, ctx: AgentFreshnessContext): AgentFreshness {
  if (!ctx.runInFlight || TERMINAL_TASK_STATUSES.has(task.status)) return "fresh";
  const lastMs = lastActivityMs(task);
  if (lastMs === null) return "quiet";
  if (!ctx.lifeSeenThisRun.has(task.taskId)) return "quiet";
  return nowMs - lastMs > SEVERED_ACTIVITY_MS ? "severed" : "quiet";
}

function liveProgressChanged(
  previous: ActivityLiveProgress | undefined,
  incoming: ActivityLiveProgress | undefined,
): boolean {
  // Absence of progress fields is absence of evidence, not life. First
  // appearance is evidence even when updatedAt and status are unchanged.
  if (incoming === undefined) return false;
  if (previous === undefined) return true;
  return previous.activity !== incoming.activity
    || previous.startedAt !== incoming.startedAt
    || previous.currentTool !== incoming.currentTool
    || previous.lastAssistantLine !== incoming.lastAssistantLine
    || previous.turns !== incoming.turns
    || previous.toolCalls !== incoming.toolCalls
    || previous.totalTokens !== incoming.totalTokens
    || previous.tokensPerSecond !== incoming.tokensPerSecond;
}

function taskShowedLife(previous: ActivityTask | undefined, incoming: ActivityTask): boolean {
  if (previous === undefined) return true; // first sight of a task is life
  return previous.updatedAt !== incoming.updatedAt
    || previous.status !== incoming.status
    || liveProgressChanged(previous.liveProgress, incoming.liveProgress);
}

/** Next latch set when any incoming task showed life; null when none did. */
function latchedTaskLife(
  state: ActivityState,
  incoming: readonly ActivityTask[],
): ReadonlySet<string> | null {
  let latched: Set<string> | null = null;
  for (const task of incoming) {
    if (!taskShowedLife(state.tasks.get(task.taskId), task)) continue;
    if (latched === null) latched = new Set(lifeSeenThisRunOf(state));
    latched.add(task.taskId);
  }
  return latched;
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
  const tasks = replaceKeepingTerminal(state.tasks, parsed.tasks, {
    keyOf: (task) => task.taskId,
    keepPrevious: isTerminalTask,
    merge: (_prev, next) => next,
  });
  const snapshot = {
    ...state,
    tasks,
    ...(parsed.truncatedTasks === undefined ? {} : { truncatedTasks: parsed.truncatedTasks }),
  };
  if (state.runInFlight !== true) return snapshot;
  const lifeSeenThisRun = latchedTaskLife(state, parsed.tasks);
  if (lifeSeenThisRun === null) return snapshot;
  const next: LifeLatchedActivityState = { ...snapshot, lifeSeenThisRun };
  return next;
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
    ...(parsed.truncatedRuns === undefined ? {} : { truncatedDags: parsed.truncatedRuns }),
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
  const next: ActivityState = { ...state, dags, tasks };
  // Node activity mapped to a task is life by definition; keep the previous
  // latch reference when that task already latched so the version bump stays
  // honest.
  if (state.runInFlight !== true || lifeSeenThisRunOf(state).has(parsed.taskId)) return next;
  const latched: LifeLatchedActivityState = {
    ...next,
    lifeSeenThisRun: new Set([...lifeSeenThisRunOf(state), parsed.taskId]),
  };
  return latched;
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

/** Replace one activity side from a REST history response. Unlike live
 * snapshots, authoritative hydration does not retain terminal rows omitted by
 * the store projection; ordering is decided by the caller per side. */
export function applyActivityHistorySnapshot(state: ActivityState, name: string, data: unknown): ActivityState {
  if (name === "omo.task.updated") {
    const parsed = parseTaskUpdated(data);
    if (parsed === null) return state;
    return {
      ...state,
      tasks: new Map(parsed.tasks.map((task) => [task.taskId, task])),
      ...(parsed.truncatedTasks === undefined ? {} : { truncatedTasks: parsed.truncatedTasks }),
    };
  }
  if (name === "omo.dag.updated") {
    const parsed = parseDagUpdated(data);
    if (parsed === null) return state;
    return {
      ...state,
      dags: new Map(parsed.runs.map((run) => [run.runId, run])),
      ...(parsed.truncatedRuns === undefined ? {} : { truncatedDags: parsed.truncatedRuns }),
    };
  }
  return state;
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
