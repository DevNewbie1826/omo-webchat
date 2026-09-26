import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { parseDagActivity, parseTaskUpdated } from "../split/activityParse";
import { parseDagCounts } from "../split/activityParseDag";
import { FRESHNESS_TICK_MS, STALE_RUNNING_WINDOW_MS, summarizeLiveSession } from "./useLiveSessionSummaries";
import type { AcceptedAgentAggregate, LiveSessionSummary } from "./useLiveSessionSummaries";
import { applyTaskActivity, mergeTaskAuthorities, reconcileTaskSources, taskAuthorityPayload, applyCountAuthority, type CountAuthority, type TaskAuthority } from "../split/taskAuthority";
import type { TaskDigest, DagDigest } from "./activityDigest";
import type { LiveSessionInfo } from "./useLiveSessionsLean";
import { admitCurrentLiveFrame, applyLiveIdentity, canonicalLiveSessionId, isResidentLiveSession, liveAcceptedBinding, liveAcceptedDurable, resetLiveIdentities, retireLiveIdentities } from "./liveSessionIdentity";
import { admitsAttachedBinding, bindAttachedSource, resetAttachedSourcesForTests } from "./liveAttachedBindings";
import type { AttachedBadgeProvenance } from "./liveAttachedBindings";
import { acceptAttachedContentRevision } from "./liveContentRevision";
export { releaseAttachedBadgeSource } from "./liveAttachedBindings";
export type { AttachedBadgeProvenance } from "./liveAttachedBindings";
export { canonicalLiveSessionId } from "./liveSessionIdentity";

const TASK_FRAME = "omo.task.updated";
const DAG_FRAME = "omo.dag.updated";
const ACTIVITY_FRAME = "omo.dag.activity";

interface SideOverride {
  readonly payload: unknown;
  readonly sequence: number;
  readonly receivedAt: number;
}

/** Per-task freshness stamps extracted from omo.dag.activity frames: the
 * latest activity `at` wins per task id. Stamps are not a payload side - a
 * snapshot cannot carry them (row stamps only advance on task state changes),
 * so they age out only through the TTL sweep, never through settling. */
interface ActivityStamps {
  readonly stamps: ReadonlyMap<string, string>;
  /** Receipt time contributed by the latest valid heartbeat for each task. */
  readonly receivedAtByTask: ReadonlyMap<string, number>;
  readonly sequence: number;
  readonly receivedAt: number;
}

/** Task and DAG payloads have independent arrival order. A one-sided frame
 * must not erase fresher data for the other side. */
interface SessionOverride {
  readonly task?: SideOverride;
  readonly dag?: SideOverride;
  readonly activity?: ActivityStamps;
}

export interface LiveBadgeOverride {
  readonly summary: LiveSessionSummary;
  readonly receivedAt: number;
}

const listeners = new Set<() => void>();
let overrides: ReadonlyMap<string, SessionOverride> = new Map();
let activitySequence = 0;
let adoptedInstanceId: string | undefined;
/** Only the overview transport adopts an instance; attached sockets observe it. */
export function adoptLiveBadgeInstance(instanceId: string | undefined): void {
  adoptedInstanceId = instanceId;
}

/** Hold ready claims until the overview accepts their server incarnation. */
export function bindAttachedBadgeSource(sessionId: string, provenance: AttachedBadgeProvenance): void {
  const id = canonicalLiveSessionId(sessionId);
  bindAttachedSource(id, provenance, liveAcceptedBinding(id));
}

interface SessionTasks extends TaskAuthority {
  readonly mutations: ReadonlyMap<string, number>;
}
let taskAuthorities: ReadonlyMap<string, SessionTasks> = new Map();

function pruneTaskAuthorities(all: Map<string, SessionTasks>): void {
  while (all.size > 256) {
    const oldest = [...all.keys()].find((id) => !isResidentLiveSession(id));
    if (oldest === undefined) break;
    all.delete(oldest);
  }
}

export function hasProvisionalLiveData(id: string): boolean {
  return overrides.has(id) || taskAuthorities.has(id);
}

function getTaskAuthorities(): ReadonlyMap<string, SessionTasks> { return taskAuthorities; }

/** All three task transports enter this reducer before any consumer counts rows.
 * The acceptance sequence (live deliveries) or the captured request sequence
 * (REST settles) is the admission ordering for the agent-count aggregate, so
 * a deferred stale REST response can never resurrect counts over newer live
 * state. */
export function acceptLiveTaskInfo(
  info: { readonly id: string; readonly task?: unknown; readonly taskDigest?: TaskDigest; readonly taskOversized?: boolean },
  sequence: number,
  requestSequence?: number,
): void {
  const id = canonicalLiveSessionId(info.id);
  const previous: SessionTasks = taskAuthorities.get(id) ?? { tasks: new Map(), mutations: new Map() };
  const rich = parseTaskUpdated(info.task);
  const digest = info.taskDigest;
  if (rich === null && digest === undefined && info.taskOversized !== true) return;
  const touched = new Set([...previous.mutations].filter(([, at]) => requestSequence !== undefined && at > requestSequence).map(([key]) => key));
  const next = reconcileTaskSources(previous, rich, digest, {
    history: requestSequence !== undefined, touched, oversized: info.taskOversized === true,
    ...(requestSequence === undefined ? { countAdmissionMs: sequence } : { countRequestedMs: requestSequence }),
  });
  if (next === previous) return;
  const mutations = new Map(previous.mutations);
  for (const key of new Set([...previous.tasks.keys(), ...next.tasks.keys()])) {
    if (previous.tasks.get(key) !== next.tasks.get(key)) mutations.set(key, sequence);
  }
  for (const key of mutations.keys()) if (!next.tasks.has(key) && !next.taskFreshness?.has(key)) mutations.delete(key);
  const all = new Map(taskAuthorities);
  all.delete(id); all.set(id, { ...next, mutations });
  pruneTaskAuthorities(all);
  taskAuthorities = all;
  emit();
}

/** The DAG-side agent aggregate joins the same count authority: the caller
 * supplies the delivery's admission ordering (acceptance sequence for live
 * frames, request sequence for poll settles), and row clocks never elect.
 * Count-only deliveries are first-class. */
export function acceptLiveDagCounts(
  info: { readonly id: string; readonly dag?: unknown; readonly dagDigest?: DagDigest },
  admission: number,
): void {
  const id = canonicalLiveSessionId(info.id);
  const counts = dagCountsOf(info);
  if (counts === null) return;
  const previous: SessionTasks = taskAuthorities.get(id) ?? { tasks: new Map(), mutations: new Map() };
  const next = applyCountAuthority(previous, counts, admission);
  if (next === previous) return;
  const all = new Map(taskAuthorities);
  all.set(id, { ...next, mutations: previous.mutations });
  pruneTaskAuthorities(all);
  taskAuthorities = all;
  emit();
}

/** The aggregate rides beside the DAG rows; a digest backs an absent or
 * oversized payload. No agent scalar means no delivery. Within one envelope
 * the digest is the server's current computed aggregate: the snapshot
 * payload's per-side scalar can be a cached older snapshot and only fills
 * fields the digest does not carry. */
function dagCountsOf(
  info: { readonly dag?: unknown; readonly dagDigest?: DagDigest },
): CountAuthority | null {
  const payload = parseDagCounts(info.dag);
  const running = info.dagDigest?.agentRunningCount ?? payload?.taskAgentRunningCount;
  const total = info.dagDigest?.agentTotalCount ?? payload?.taskAgentTotalCount;
  if (running === undefined && total === undefined) return null;
  return {
    ...(running === undefined ? {} : { taskAgentRunningCount: running }),
    ...(total === undefined ? {} : { taskAgentTotalCount: total }),
  };
}

export function projectLiveTaskInfo<T extends { readonly id: string }>(info: T): T {
  const authority = taskAuthorities.get(canonicalLiveSessionId(info.id));
  if (authority === undefined) return info;
  return { ...info, task: taskAuthorityPayload(authority), taskOversized: authority.taskUnavailable === true, taskDigest: undefined };
}

/** The accepted agent-count aggregate per canonical session id: the running
 * authority the shared store elected by admission ordering across task and
 * DAG deliveries. */
export function useLiveAgentAggregates(): ReadonlyMap<string, AcceptedAgentAggregate> {
  const authority = useSyncExternalStore(subscribeOverrides, getTaskAuthorities);
  return useMemo(() => {
    const aggregates = new Map<string, AcceptedAgentAggregate>();
    for (const [id, tasks] of authority) {
      if (tasks.taskAgentRunningCount === undefined) continue;
      aggregates.set(id, { running: tasks.taskAgentRunningCount, total: tasks.taskAgentTotalCount });
    }
    return aggregates;
  }, [authority]);
}

export function retireLiveTaskSessions(ids: readonly string[]): void {
  const all = new Map(taskAuthorities);
  const remaining = new Map(overrides);
  for (const id of ids) {
    all.delete(id);
    remaining.delete(id);
  }
  retireLiveIdentities(ids);
  if (all.size === taskAuthorities.size && remaining.size === overrides.size) return;
  taskAuthorities = all;
  overrides = remaining;
  emit();
}

function emit(): void {
  for (const listener of listeners) listener();
}

/** Request/membership correlation for the three transports, never a raw task revision. */
export function nextLiveActivitySequence(): number {
  activitySequence += 1;
  return activitySequence;
}

function subscribeOverrides(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

function getOverridesSnapshot(): ReadonlyMap<string, SessionOverride> {
  return overrides;
}

/** Expire each side independently and retain a session while any side is fresh. */
function sweepExpired(nowMs: number): void {
  let changed = false;
  const next = new Map<string, SessionOverride>();
  for (const [id, entry] of overrides) {
    const task = entry.task !== undefined && nowMs - entry.task.receivedAt <= STALE_RUNNING_WINDOW_MS
      ? entry.task
      : undefined;
    const dag = entry.dag !== undefined && nowMs - entry.dag.receivedAt <= STALE_RUNNING_WINDOW_MS
      ? entry.dag
      : undefined;
    const activity = entry.activity !== undefined && nowMs - entry.activity.receivedAt <= STALE_RUNNING_WINDOW_MS
      ? entry.activity
      : undefined;
    if (task !== entry.task || dag !== entry.dag || activity !== entry.activity) changed = true;
    if (task !== undefined || dag !== undefined || activity !== undefined) {
      next.set(id, {
        ...(task === undefined ? {} : { task }),
        ...(dag === undefined ? {} : { dag }),
        ...(activity === undefined ? {} : { activity }),
      });
    }
  }
  if (!changed) return;
  overrides = next;
  emit();
}

function activityStampMs(at: string): number {
  return Date.parse(at);
}

function mergeActivityStamps(
  first: ActivityStamps | undefined,
  second: ActivityStamps | undefined,
): ActivityStamps | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;
  const stamps = new Map<string, string>();
  const receivedAtByTask = new Map<string, number>();
  for (const activity of [first, second]) {
    for (const [taskId, at] of activity.stamps) {
      const epochMs = activityStampMs(at);
      const known = stamps.get(taskId);
      const knownMs = known === undefined ? undefined : activityStampMs(known);
      if (knownMs === undefined || epochMs > knownMs) stamps.set(taskId, at);
      const receivedAt = activity.receivedAtByTask.get(taskId);
      if (receivedAt !== undefined) {
        receivedAtByTask.set(taskId, Math.max(receivedAtByTask.get(taskId) ?? 0, receivedAt));
      }
    }
  }
  return {
    stamps,
    receivedAtByTask,
    sequence: Math.max(first.sequence, second.sequence),
    receivedAt: Math.max(first.receivedAt, second.receivedAt),
  };
}

function renewTaskFromActivity(
  task: SideOverride | undefined,
  activity: ActivityStamps | undefined,
): SideOverride | undefined {
  if (task === undefined || activity === undefined) return task;
  const parsed = parseTaskUpdated(task.payload);
  if (parsed === null) return task;
  let receivedAt = task.receivedAt;
  for (const entry of parsed.tasks) {
    if (!activity.stamps.has(entry.taskId)) continue;
    receivedAt = Math.max(receivedAt, activity.receivedAtByTask.get(entry.taskId) ?? receivedAt);
  }
  return receivedAt === task.receivedAt ? task : { ...task, receivedAt };
}

function mergeOverrides(first: SessionOverride, second: SessionOverride): SessionOverride {
  const selectedTask = (first.task?.sequence ?? -1) >= (second.task?.sequence ?? -1) ? first.task : second.task;
  const dag = (first.dag?.sequence ?? -1) >= (second.dag?.sequence ?? -1) ? first.dag : second.dag;
  const activity = mergeActivityStamps(first.activity, second.activity);
  const task = renewTaskFromActivity(selectedTask, activity);
  return {
    ...(task === undefined ? {} : { task }),
    ...(dag === undefined ? {} : { dag }),
    ...(activity === undefined ? {} : { activity }),
  };
}

/** Move an admitted replacement's override and task authority together. */
function migrateReplacementData(next: Map<string, SessionOverride>, fromId: string, target: string): void {
  const source = next.get(fromId);
  if (source !== undefined) {
    const targetOverride = next.get(target);
    next.set(target, targetOverride === undefined ? source : mergeOverrides(source, targetOverride));
    next.delete(fromId);
  }
  const sourceTasks = taskAuthorities.get(fromId);
  if (sourceTasks === undefined) return;
  const all = new Map(taskAuthorities);
  const targetTasks = taskAuthorities.get(target);
  if (targetTasks === undefined) {
    all.set(target, sourceTasks);
  } else {
    const merged = mergeTaskAuthorities(targetTasks, sourceTasks);
    const mutations = new Map(targetTasks.mutations);
    for (const [id, at] of sourceTasks.mutations) mutations.set(id, Math.max(mutations.get(id) ?? 0, at));
    all.set(target, { ...merged, mutations });
  }
  all.delete(fromId);
  taskAuthorities = all;
}

/** Settle attached-socket overrides against a successful REST response. Each
 * side is compared with the sequence captured when the request started; the
 * response's own scalars enter the shared count authority with that request
 * ordering on both the task and the DAG side. */
export function settleLiveBadgePoll(
  infos: readonly { readonly id: string; readonly durableSessionId?: string; readonly bindingId?: string; readonly lean?: { readonly last_activity_ms?: number }; readonly task?: unknown; readonly dag?: unknown; readonly taskDigest?: TaskDigest; readonly taskOversized?: boolean; readonly dagDigest?: DagDigest }[],
  requestSequence: number,
): void {
  const next = new Map(overrides);
  let changed = false;
  for (const info of infos) {
    const admission = admitCurrentLiveFrame({ kind: "poll", chatId: info.id, requestSequence,
      ...(info.durableSessionId === undefined ? {} : { durableId: info.durableSessionId }),
      ...(info.bindingId === undefined ? {} : { bindingId: info.bindingId }),
      ...(info.lean?.last_activity_ms === undefined ? {} : { receipt: info.lean.last_activity_ms }),
    });
    if (!admission.accept) continue;
    applyLiveIdentity(admission);
    const settlementSequence = nextLiveActivitySequence();
    acceptLiveTaskInfo(info, settlementSequence, requestSequence);
    acceptLiveDagCounts(info, requestSequence);
    const entry = next.get(info.id);
    if (entry === undefined) continue;
    const task = entry.task !== undefined && entry.task.sequence > requestSequence ? entry.task : undefined;
    const dag = entry.dag !== undefined && entry.dag.sequence > requestSequence ? entry.dag : undefined;
    if (task === entry.task && dag === entry.dag) continue;
    changed = true;
    if (task === undefined && dag === undefined && entry.activity === undefined) next.delete(info.id);
    else next.set(info.id, {
      ...(task === undefined ? {} : { task }),
      ...(dag === undefined ? {} : { dag }),
      ...(entry.activity === undefined ? {} : { activity: entry.activity }),
    });
  }
  if (!changed) return;
  overrides = next;
  emit();
}

/** Settle attached overrides and migrate only admitted replacement sources.
 * Ownership and alias changes are committed by the identity reducer. */
export function settleLiveBadgePush(
  sessionId: string,
  sourceIds: readonly string[],
  taskUpdated: boolean,
  dagUpdated: boolean,
  pushSequence: number,
): void {
  const beforeAuthorities = taskAuthorities;
  const next = new Map(overrides);
  let changed = false;
  for (const sourceId of sourceIds) {
    if (next.has(sourceId)) changed = true;
    migrateReplacementData(next, sourceId, sessionId);
  }
  const entry = next.get(sessionId);
  if (entry === undefined) {
    if (changed || beforeAuthorities !== taskAuthorities) { overrides = next; emit(); }
    return;
  }
  const task = taskUpdated && (entry.task?.sequence ?? -1) <= pushSequence ? undefined : entry.task;
  const dag = dagUpdated && (entry.dag?.sequence ?? -1) <= pushSequence ? undefined : entry.dag;
  if (task !== entry.task || dag !== entry.dag) {
    changed = true;
    if (task === undefined && dag === undefined && entry.activity === undefined) next.delete(sessionId);
    else next.set(sessionId, {
      ...(task === undefined ? {} : { task }),
      ...(dag === undefined ? {} : { dag }),
      ...(entry.activity === undefined ? {} : { activity: entry.activity }),
    });
  }
  if (!changed && beforeAuthorities === taskAuthorities) return;
  overrides = next;
  emit();
}

/** Task snapshots enter per-ID authority; null cannot clear task membership.
 * Server content revisions fence all shared mutations before arrival ordering. */
export function ingestExtensionEvent(
  sessionId: string, frameName: string, data: unknown, provenance?: AttachedBadgeProvenance,
  revision?: number,
): void {
  const acceptedDurable = liveAcceptedDurable(sessionId);
  if (provenance !== undefined && (provenance.connection !== provenance.currentConnection
    || provenance.instanceId !== adoptedInstanceId
    || (acceptedDurable !== undefined && provenance.durableSessionId !== acceptedDurable))) return;
  if (frameName !== TASK_FRAME && frameName !== DAG_FRAME && frameName !== ACTIVITY_FRAME) return;
  const id = canonicalLiveSessionId(sessionId);
  if (provenance !== undefined && !admitsAttachedBinding(provenance, liveAcceptedBinding(id)?.bindingId)) return;
  if (!acceptAttachedContentRevision(id, provenance?.bindingId ?? liveAcceptedBinding(id)?.bindingId, revision)) return;
  if (frameName === TASK_FRAME) acceptLiveTaskInfo({ id, task: data }, nextLiveActivitySequence());
  if (frameName === ACTIVITY_FRAME) {
    const parsed = parseDagActivity(data);
    if (parsed === null || parsed.taskId === undefined) return;
    const authority = taskAuthorities.get(id);
    const currentTask = authority?.tasks.get(parsed.taskId);
    if (authority !== undefined && currentTask !== undefined) {
      const task = applyTaskActivity(currentTask, parsed);
      if (task !== currentTask) {
        taskAuthorities = new Map(taskAuthorities).set(id, { ...authority,
          tasks: new Map(authority.tasks).set(parsed.taskId, task),
          mutations: new Map(authority.mutations).set(parsed.taskId, nextLiveActivitySequence()),
        });
      }
    }
    const epochMs = activityStampMs(parsed.at);
    const previous = overrides.get(id);
    const stamps = new Map(previous?.activity?.stamps ?? []);
    const known = stamps.get(parsed.taskId);
    const knownMs = known === undefined ? undefined : activityStampMs(known);
    if (knownMs === undefined || epochMs > knownMs) stamps.set(parsed.taskId, parsed.at);
    const receivedAt = Date.now();
    const receivedAtByTask = new Map(previous?.activity?.receivedAtByTask ?? []);
    receivedAtByTask.set(parsed.taskId, receivedAt);
    const task = previous?.task !== undefined
      && parseTaskUpdated(previous.task.payload)?.tasks.some((entry) => entry.taskId === parsed.taskId) === true
      ? { ...previous.task, receivedAt }
      : previous?.task;
    const next = new Map(overrides);
    next.set(id, {
      ...previous,
      ...(task === undefined ? {} : { task }),
      activity: { stamps, receivedAtByTask, sequence: nextLiveActivitySequence(), receivedAt },
    });
    overrides = next;
    emit();
    return;
  }
  const previous = overrides.get(id) ?? {};
  const sequence = nextLiveActivitySequence();
  if (frameName === DAG_FRAME) acceptLiveDagCounts({ id, dag: data }, sequence);
  const side = { payload: data ?? null, sequence, receivedAt: Date.now() };
  const next = new Map(overrides);
  next.set(id, frameName === TASK_FRAME
    ? { ...previous, task: side }
    : { ...previous, dag: side });
  overrides = next;
  emit();
}

/** WS-pushed per-session override summaries built from the raw payloads. */
export function useLiveBadgeOverrides(): ReadonlyMap<string, LiveBadgeOverride> {
  const snapshot = useSyncExternalStore(subscribeOverrides, getOverridesSnapshot);
  const authority = useSyncExternalStore(subscribeOverrides, getTaskAuthorities);
  return useMemo(() => {
    const summaries = new Map<string, LiveBadgeOverride>();
    for (const [id, entry] of snapshot) {
      const receivedAt = Math.max(
        entry.task?.receivedAt ?? 0,
        entry.dag?.receivedAt ?? 0,
        entry.activity?.receivedAt ?? 0,
      );
      const aggregate = agentAggregateOf(id);
      summaries.set(id, {
        summary: summarizeLiveSession(
          projectLiveTaskInfo({ id, title: "", task: entry.task?.payload ?? null, dag: entry.dag?.payload ?? null }),
          Date.now(),
          {
            ...(entry.activity === undefined ? {} : { heartbeatStamps: entry.activity.stamps }),
            ...(aggregate === undefined ? {} : { agentAggregate: aggregate }),
          },
        ),
        receivedAt,
      });
    }
    return summaries;
  }, [snapshot, authority]);
}

/** The session's accepted agent-count aggregate, when the store holds one. */
function agentAggregateOf(id: string): AcceptedAgentAggregate | undefined {
  const authority = taskAuthorities.get(canonicalLiveSessionId(id));
  return authority?.taskAgentRunningCount === undefined
    ? undefined
    : { running: authority.taskAgentRunningCount, total: authority.taskAgentTotalCount };
}

function newerPayload(
  side: SideOverride | undefined,
  pollPayload: unknown,
  nowMs: number,
): { readonly payload: unknown; readonly replaced: boolean } {
  if (side === undefined || side.payload === null) return { payload: pollPayload, replaced: false };
  if (nowMs - side.receivedAt > STALE_RUNNING_WINDOW_MS) return { payload: pollPayload, replaced: false };
  return { payload: side.payload, replaced: true };
}

function parentSessionIdOf(summary: { readonly task?: unknown; readonly dag?: unknown }): string | undefined {
  for (const payload of [summary.task, summary.dag]) {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) continue;
    const parent = (payload as Record<string, unknown>)["parent_session_id"];
    if (typeof parent === "string" && parent.length > 0) return parent;
  }
  return undefined;
}

/** Poll summaries and attached-socket frames merged independently for each
 * session and activity side. */
export function useMergedLiveSummaries(pollSummaries: readonly LiveSessionSummary[]): readonly LiveSessionSummary[] {
  const snapshot = useSyncExternalStore(subscribeOverrides, getOverridesSnapshot);
  const authority = useSyncExternalStore(subscribeOverrides, getTaskAuthorities);
  const [clockMs, setClockMs] = useState(() => Date.now());

  useEffect(() => {
    const tick = (): void => {
      const now = Date.now();
      sweepExpired(now);
      setClockMs(now);
    };
    tick();
    const timer = window.setInterval(tick, FRESHNESS_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  return useMemo(
    () => pollSummaries.map((poll) => {
      const parentId = parentSessionIdOf(poll);
      const entry = snapshot.get(poll.id) ?? (parentId === undefined ? undefined : snapshot.get(parentId));
      if (entry === undefined && !authority.has(canonicalLiveSessionId(poll.id))) return poll;
      const task = newerPayload(entry?.task, poll.task ?? null, clockMs);
      const dag = newerPayload(entry?.dag, poll.dag ?? null, clockMs);
      const mergedInfo = projectLiveTaskInfo({
        id: poll.id,
        title: poll.title,
        ...(poll.lean === undefined ? {} : { lean: poll.lean }),
        ...(poll.active === undefined ? {} : { active: poll.active }),
        task: task.payload,
        dag: dag.payload,
        taskOversized: task.replaced ? false : poll.taskSideOversized,
        dagOversized: dag.replaced ? false : poll.dagSideOversized,
        ...(!task.replaced && poll.taskDigest !== undefined ? { taskDigest: poll.taskDigest } : {}),
        ...(!dag.replaced && poll.dagDigest !== undefined ? { dagDigest: poll.dagDigest } : {}),
      } as LiveSessionInfo);
      const aggregate = agentAggregateOf(poll.id);
      // The poller listing the session is the process-alive signal, so the
      // merged summary never ages out its running tasks; heartbeat stamps
      // keep per-task freshness honest under the replaced payload.
      return summarizeLiveSession(mergedInfo, clockMs, {
        sessionLive: true,
        ...(entry?.activity === undefined ? {} : { heartbeatStamps: entry.activity.stamps }),
        ...(aggregate === undefined ? {} : { agentAggregate: aggregate }),
      });
    }),
    [pollSummaries, snapshot, authority, clockMs],
  );
}

/** Reset module state so fake-clock ordering and TTL tests are isolated. */
export function __resetLiveBadgeStoreForTests(): void {
  activitySequence = 0;
  resetAttachedSourcesForTests();
  resetLiveBadgeState();
}

/** An instance change invalidates all task, alias and revision provenance. */
export function resetLiveBadgeState(): void {
  overrides = new Map();
  taskAuthorities = new Map();
  adoptedInstanceId = undefined;
  resetLiveIdentities();
  emit();
}
