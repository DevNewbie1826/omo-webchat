import {
  parseDagActivity,
  parseDagHeartbeat,
  parseDagUpdated,
  parseTaskUpdated,
  parseTodoDetails,
} from "./activityParse";
import type {
  ActivityDagNode,
  ActivityDagRun,
  ActivityHeartbeat,
  ActivityLiveProgress,
  ActivityState,
  ActivityTask,
} from "./activityTypes";
import { applyTaskActivity, reconcileTaskAuthority, reconcileTaskSources, taskRevision, type CountAuthority } from "./taskAuthority";
import type { TaskDigest } from "../workspace/activityDigest";
import { parseDagUpdatedAt, type ParsedDagUpdated } from "./activityParseDag";
import { TERMINAL_DAG_STATUSES, TERMINAL_TASK_STATUSES, lastActivityMs } from "./activityShelfModel";

/* The terminal-status rule lives once in activityShelfModel.ts (exported for
   the shelf); this module imports it instead of keeping a second copy that
   could drift. */

// Freshness is edge-triggered, not level-triggered: goal-continuation wakes
// start runs whose tasks legitimately stay quiet for minutes, so elapsed
// quiet alone proves nothing. Only a task that showed life during THIS run
// (a frame actually changed it) can then be declared severed after 90s of
// quiet - and even then only when the run CONTAINING the row has gone silent
// too (see AgentFreshnessContext.runActivityMsByTask). Every other in-flight
// row is merely quiet. STALE_ACTIVITY_MS no longer gates any alarm (kept only
// for external reference).
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
  /** Actual reducer mutation bits (post-apply), set by the buffering caller. */
  mutatedTask?: boolean;
  mutatedDag?: boolean;
}

export interface ActivityHydrationBuffer {
  readonly events: BufferedActivityEvent[];
  dropped: number;
  taskSuperseded: boolean;
  dagSuperseded: boolean;
  taskOverflowed: boolean;
  dagOverflowed: boolean;
  /** Whether any buffered event actually carried a task-domain mutation. */
  taskTouched: boolean;
  /** Whether any buffered event actually carried a DAG-domain mutation. */
  dagTouched: boolean;
}

/** The pane's newest accepted live count delivery, retained with its own
   admission ordering independently of the bounded hydration-event buffer.
   The buffer may drop the snapshot frame that carried the scalars; this
   record keeps both the ordering and the winning aggregate, so an older
   hydration response registered before that admission cannot resurrect
   superseded scalars. */
export interface LiveCountAdmission {
  readonly counts: CountAuthority;
  /** Pane-local admission sequence, assigned when the live delivery was
     accepted; request registration captures the current value to compare. */
  readonly seq: number;
}

export function createActivityHydrationBuffer(): ActivityHydrationBuffer {
  return {
    events: [],
    dropped: 0,
    taskSuperseded: false,
    dagSuperseded: false,
    taskOverflowed: false,
    dagOverflowed: false,
    taskTouched: false,
    dagTouched: false,
  };
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
  const mutatedTask = event.mutatedTask ?? (event.side === "task" || event.name === "omo.dag.activity");
  const mutatedDag = event.mutatedDag ?? (event.side === "dag" || event.name === "omo.dag.activity");
  if (previousIndex >= 0) {
    const previous = buffer.events[previousIndex]!;
    buffer.events.splice(previousIndex, 1);
    if (!event.snapshot && typeof previous.data === "object" && previous.data !== null
      && typeof event.data === "object" && event.data !== null) {
      const previousActivity = event.name === "omo.dag.activity" ? parseDagActivity(previous.data) : null;
      const incomingActivity = event.name === "omo.dag.activity" ? parseDagActivity(event.data) : null;
      const staleActivity = previousActivity !== null && incomingActivity !== null
        && taskRevision(incomingActivity.at)! < taskRevision(previousActivity.at)!;
      nextEvent = {
        ...event,
        data: staleActivity ? previous.data : { ...previous.data, ...event.data },
        mutatedTask: (event.mutatedTask ?? mutatedTask) || (previous.mutatedTask ?? false),
        mutatedDag: (event.mutatedDag ?? mutatedDag) || (previous.mutatedDag ?? false),
      };
    }
  }
  buffer.events.push(nextEvent);
  buffer.taskTouched = buffer.taskTouched || mutatedTask;
  buffer.dagTouched = buffer.dagTouched || mutatedDag;
  const sideCount = buffer.events.reduce((count, item) => count + (item.side === event.side ? 1 : 0), 0);
  if (sideCount <= ACTIVITY_HYDRATION_SIDE_LIMIT) return;
  const oldest = buffer.events.findIndex((item) => item.side === event.side);
  if (oldest >= 0) {
    const [dropped] = buffer.events.splice(oldest, 1);
    buffer.dropped += 1;
    // Overflow protection only guards domains the dropped event actually
    // mutated — stale cached rows from before the fetch must not fence a
    // fresh REST base when every buffered event was a no-op for them.
    if ((dropped?.side === "task" || dropped?.name === "omo.dag.activity")
      && (dropped?.mutatedTask ?? buffer.taskTouched)) {
      buffer.taskOverflowed = true;
    }
    if (dropped?.side === "dag" && (dropped?.mutatedDag ?? buffer.dagTouched)) {
      buffer.dagOverflowed = true;
    }
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

/**
 * Per-row dag membership: taskId -> the containing run's lastActivityAt, in
 * epoch ms. Run nodes carry the taskIds of the children they project, and
 * workflowNodeTasks keys unmapped node rows as `${runId}/${nodeId}`, so both
 * identities resolve to the row's OWN run - the only run allowed to
 * corroborate that row's silence. A run that never carried activity
 * contributes nothing: no stamp means nothing to corroborate with. Should a
 * taskId ever appear in two runs, the freshest containing stamp wins so no
 * containing run's freshness is ignored.
 */
export function runActivityMsByTaskOf(state: ActivityState): ReadonlyMap<string, number> {
  const byTask = new Map<string, number>();
  for (const run of state.dags.values()) {
    if (run.lastActivityAt === undefined) continue;
    const ms = Date.parse(run.lastActivityAt);
    if (Number.isNaN(ms)) continue;
    for (const node of run.nodes) {
      const key = node.taskId ?? `${run.runId}/${node.id}`;
      const known = byTask.get(key);
      if (known === undefined || ms > known) byTask.set(key, ms);
    }
  }
  return byTask;
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
  /**
   * Per-row dag membership: taskId -> the containing run's lastActivityAt in
   * epoch ms (absent when no run contains the row). Corroborates a row's
   * silence: a quiet row may only be called severed when the run that
   * CONTAINS it has gone silent too - a row without dag membership never
   * severs, and an unrelated run's pulse is irrelevant either way.
   */
  readonly runActivityMsByTask: ReadonlyMap<string, number>;
}

/**
 * Freshness of an agent row, judged only while a run is in flight: an idle
 * pane is always fresh. A non-terminal row is "severed" only when all of
 * these hold: it showed life this run, it has been quiet past
 * SEVERED_ACTIVITY_MS, it has dag membership, and its OWN run's
 * lastActivityAt is also older than SEVERED_ACTIVITY_MS - the row's silence
 * and the silence of the run containing it must agree that the agent is
 * gone. Every other in-flight row is "quiet": muted, with an informational
 * last-update age, never an alarm.
 */
export function agentFreshness(task: ActivityTask, nowMs: number, ctx: AgentFreshnessContext): AgentFreshness {
  if (!ctx.runInFlight || TERMINAL_TASK_STATUSES.has(task.status)) return "fresh";
  const lastMs = lastActivityMs(task);
  if (lastMs === null) return "quiet";
  if (!ctx.lifeSeenThisRun.has(task.taskId)) return "quiet";
  if (nowMs - lastMs <= SEVERED_ACTIVITY_MS) return "quiet";
  // Corroboration is per-row: only the run that CONTAINS this row can speak
  // for it. A row with no dag membership never severs - silence alone proves
  // nothing - and a run it does not contain is irrelevant in both
  // directions.
  const ownRunMs = ctx.runActivityMsByTask.get(task.taskId);
  if (ownRunMs === undefined || nowMs - ownRunMs <= SEVERED_ACTIVITY_MS) return "quiet";
  return "severed";
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

function isTerminalDag(run: ActivityDagRun): boolean {
  return TERMINAL_DAG_STATUSES.has(run.status);
}

function mergePreservedNode(previous: ActivityDagNode | undefined, incoming: ActivityDagNode): ActivityDagNode {
  if (previous === undefined) return incoming;
  return {
    ...incoming,
    ...(incoming.taskId === undefined && incoming.taskIdPrefix === undefined && previous.taskId !== undefined
      ? { taskId: previous.taskId } : {}),
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
  const snapshot = reconcileTaskAuthority(state, parsed.tasks, { truncated: parsed.truncatedTasks });
  if (state.runInFlight !== true) return snapshot;
  const lifeSeenThisRun = latchedTaskLife(state, [...snapshot.tasks.values()]);
  if (lifeSeenThisRun === null) return snapshot;
  const next: LifeLatchedActivityState = { ...snapshot, lifeSeenThisRun };
  return next;
}

function reconcileDagSnapshot(
  state: ActivityState,
  parsed: ParsedDagUpdated,
  keepOmitted: (run: ActivityDagRun) => boolean,
): ActivityState {
  const present = new Set(parsed.runs.map(run => run.runId));
  const dags = new Map(state.dags);
  const dagFreshness = new Map(state.dagFreshness);
  // Row acceptance is not membership authority: an omission needs a newer
  // inventory high-water revision, and a mixed delivery is not a stale replay.
  let rowAccepted = false;
  let staleDelivery = false;
  for (const [id, run] of state.dags) {
    const revision = parseDagUpdatedAt(run.updatedAt);
    if (revision !== undefined && !dagFreshness.has(id)) dagFreshness.set(id, revision);
  }
  const membership = state.dagMembership;
  const acceptedIds = membership?.ids ?? new Set(state.dags.keys());
  const previousHighWater = Math.max(membership?.highWater ?? -Infinity, ...dagFreshness.values());
  const incomingHighWater = Math.max(-Infinity, ...parsed.runs.map(run => parseDagUpdatedAt(run.updatedAt) ?? -Infinity));
  const membershipChanged = present.size !== acceptedIds.size || [...present].some(id => !acceptedIds.has(id));
  for (const incoming of parsed.runs) {
    const revision = parseDagUpdatedAt(incoming.updatedAt);
    const currentRevision = dagFreshness.get(incoming.runId);
    // Equal known revisions keep the incumbent as a complete unit. Unknown
    // pairs remain arrival-ordered for legacy payloads, never terminal-latched.
    if (currentRevision !== undefined && (revision === undefined || revision < currentRevision)) staleDelivery = true;
    if (currentRevision !== undefined && (revision === undefined || revision <= currentRevision)) continue;
    rowAccepted = true;
    dags.set(incoming.runId, mergeDagRun(dags.get(incoming.runId), {
      ...incoming, truncated: incoming.truncated === true || parsed.truncatedRuns === true,
    }));
    if (revision !== undefined) dagFreshness.set(incoming.runId, revision);
  }
  const membershipAccepted = !parsed.truncatedRuns && !staleDelivery && (state.truncatedDagRuns === undefined
    || (rowAccepted && ((!membershipChanged && !membership?.unresolved) || incomingHighWater > previousHighWater)));
  const unresolved = staleDelivery && !rowAccepted
    ? membership?.unresolved ?? state.truncatedDagRuns ?? true
    : parsed.truncatedRuns === true || (staleDelivery && rowAccepted)
      ? true
      : membershipAccepted
        ? false
        : membershipChanged || (membership?.unresolved ?? state.truncatedDagRuns ?? true);
  // An accepted inventory can reintroduce an equal-revision row removed by
  // an earlier unaccepted omission; freshness alone cannot restore it.
  if (membershipAccepted) {
    for (const run of parsed.runs) {
      if (!dags.has(run.runId)) dags.set(run.runId, run);
    }
  }
  // Rich-row replacement preserves legacy arrival ordering and empty-list
  // clearing. Neither certifies exact count membership without the authority
  // above; an equal-row subset cannot even authorize row omission.
  if (!parsed.truncatedRuns && !staleDelivery && (rowAccepted || present.size === 0)) {
    for (const [id, run] of state.dags) {
      if (!present.has(id) && !keepOmitted(run)) dags.delete(id);
    }
  }
  return {
    ...state,
    dags,
    dagFreshness,
    dagMembership: {
      ids: membershipAccepted ? present : acceptedIds,
      // Admitted observations fence later omissions even when this delivery
      // cannot establish membership. Rejected rows never advance freshness.
      highWater: Math.max(previousHighWater, ...dagFreshness.values()),
      unresolved,
    },
    truncatedDags: parsed.truncatedRuns === true || [...dags.values()].some(run => run.truncated === true),
    // Membership completeness is tracked on its own signal: per-run graph/
    // node loss (run.truncated) must never read as missing run membership.
    truncatedDagRuns: unresolved,
  };
}

function applyDagSnapshot(state: ActivityState, data: unknown): ActivityState {
  const parsed = parseDagUpdated(data);
  return parsed === null ? state : reconcileDagSnapshot(state, parsed, isTerminalDag);
}

/** REST membership may remove terminal rows, except IDs changed during the request. */
export function applyDagHistorySnapshot(
  state: ActivityState,
  data: unknown,
  touched: ReadonlySet<string> = new Set(),
): ActivityState {
  const parsed = parseDagUpdated(data);
  return parsed === null ? state : reconcileDagSnapshot(state, parsed, run => touched.has(run.runId));
}

function applyNodeActivity(state: ActivityState, data: unknown): ActivityState {
  const parsed = parseDagActivity(data);
  if (parsed === null) return state;
  const run = state.dags.get(parsed.runId);
  if (run === undefined) return state;
  let matched = false;
  let changed = false;
  const nodes = run.nodes.map((node) => {
    if (node.id !== parsed.nodeId) return node;
    matched = true;
    const nextNode = {
      ...node,
      ...(parsed.taskId !== undefined ? { taskId: parsed.taskId } : {}),
      ...(parsed.activity !== undefined ? { activity: parsed.activity } : {}),
      ...(parsed.currentTool !== undefined ? { currentTool: parsed.currentTool } : {}),
      ...(parsed.lastAssistantLine !== undefined ? { lastAssistantLine: parsed.lastAssistantLine } : {}),
      ...(parsed.turns !== undefined ? { turns: parsed.turns } : {}),
      ...(parsed.toolCalls !== undefined ? { toolCalls: parsed.toolCalls } : {}),
      lastActivityAt: parsed.at,
    };
    if (node.taskId === nextNode.taskId && node.activity === nextNode.activity
      && node.currentTool === nextNode.currentTool && node.lastAssistantLine === nextNode.lastAssistantLine
      && node.turns === nextNode.turns && node.toolCalls === nextNode.toolCalls
      && node.lastActivityAt === nextNode.lastActivityAt) return node;
    changed = true;
    return nextNode;
  });
  if (!matched) return state;
  const dags = changed || run.lastActivityAt !== parsed.at
    ? new Map(state.dags).set(parsed.runId, { ...run, nodes, lastActivityAt: parsed.at })
    : state.dags;
  const dagState = dags === state.dags ? state : { ...state, dags };
  if (parsed.taskId === undefined) return dagState;
  const task = state.tasks.get(parsed.taskId);
  if (task === undefined) return dagState;
  const updatedTask = applyTaskActivity(task, parsed);
  if (updatedTask === task) return dagState;
  const tasks = new Map(state.tasks).set(parsed.taskId, updatedTask);
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

/** Complete REST membership removes even terminal rows unless actually touched. */
export function applyTaskHistorySnapshot(
  state: ActivityState, data: unknown, touched: ReadonlySet<string> = new Set(),
  digest?: TaskDigest, oversized = false, countRequestedMs?: number,
): ActivityState {
  return reconcileTaskSources(state, parseTaskUpdated(data), digest, { history: true, touched, oversized, ...(countRequestedMs === undefined ? {} : { countRequestedMs }) });
}

export function applyActivityHistorySnapshot(state: ActivityState, name: string, data: unknown): ActivityState {
  if (name === "omo.task.updated") return applyTaskHistorySnapshot(state, data);
  if (name === "omo.dag.updated") return applyDagHistorySnapshot(state, data);
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
