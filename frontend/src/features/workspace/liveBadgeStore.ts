import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { parseDagActivity } from "../split/activityParse";
import { summarizeLiveSession } from "./useLiveSessionSummaries";
import type { LiveSessionSummary } from "./useLiveSessionSummaries";
import type { LiveSessionInfo } from "./workspace";

/** How long a WS-pushed side or heartbeat-stamp set stays authoritative,
 * mirroring STALE_RUNNING_WINDOW_MS in useLiveSessionSummaries. */
const OVERRIDE_TTL_MS = 90_000;
/** Re-evaluation cadence for expiry, mirroring the poll summaries' freshness tick. */
const FRESHNESS_TICK_MS = 15_000;

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
let sessionAliases: ReadonlyMap<string, string> = new Map();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Shared logical clock for REST request starts, overview pushes, and attached
 * extension events. Wall time is deliberately excluded from source ordering. */
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
    const task = entry.task !== undefined && nowMs - entry.task.receivedAt <= OVERRIDE_TTL_MS
      ? entry.task
      : undefined;
    const dag = entry.dag !== undefined && nowMs - entry.dag.receivedAt <= OVERRIDE_TTL_MS
      ? entry.dag
      : undefined;
    const activity = entry.activity !== undefined && nowMs - entry.activity.receivedAt <= OVERRIDE_TTL_MS
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

function mergeOverrides(first: SessionOverride, second: SessionOverride): SessionOverride {
  const task = (first.task?.sequence ?? -1) >= (second.task?.sequence ?? -1) ? first.task : second.task;
  const dag = (first.dag?.sequence ?? -1) >= (second.dag?.sequence ?? -1) ? first.dag : second.dag;
  const activity = (first.activity?.sequence ?? -1) >= (second.activity?.sequence ?? -1)
    ? first.activity
    : second.activity;
  return {
    ...(task === undefined ? {} : { task }),
    ...(dag === undefined ? {} : { dag }),
    ...(activity === undefined ? {} : { activity }),
  };
}

function remapOverride(next: Map<string, SessionOverride>, fromId: string, toId: string): void {
  if (fromId === toId) return;
  sessionAliases = new Map(sessionAliases).set(fromId, toId);
  const source = next.get(fromId);
  if (source === undefined) return;
  const target = next.get(toId);
  next.set(toId, target === undefined ? source : mergeOverrides(source, target));
  next.delete(fromId);
}

/** Settle attached-socket overrides against a successful REST response. Each
 * side is compared with the sequence captured when the request started. */
export function settleLiveBadgePoll(
  infos: readonly { readonly id: string; readonly task?: unknown; readonly dag?: unknown }[],
  requestSequence: number,
): void {
  const next = new Map(overrides);
  let changed = false;
  for (const info of infos) {
    const parentId = parentSessionIdOf(info);
    if (parentId !== undefined && parentId !== info.id) {
      const before = next.get(parentId);
      remapOverride(next, parentId, info.id);
      if (before !== undefined) changed = true;
    }
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

/** Settle attached overrides when the overview socket publishes the same side,
 * and atomically migrate any provisional durable identity. */
export function settleLiveBadgePush(
  sessionId: string,
  sourceIds: readonly string[],
  taskUpdated: boolean,
  dagUpdated: boolean,
  pushSequence: number,
): void {
  const next = new Map(overrides);
  let changed = false;
  for (const sourceId of sourceIds) {
    if (next.has(sourceId)) changed = true;
    remapOverride(next, sourceId, sessionId);
  }
  const entry = next.get(sessionId);
  if (entry === undefined) return;
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
  if (!changed) return;
  overrides = next;
  emit();
}

/** Feed a WS extensionEvent frame into the badge store. Recognized null data
 * clears that side; omo.dag.activity frames only refresh per-task freshness
 * stamps; unknown frame names leave the store untouched. */
export function ingestExtensionEvent(sessionId: string, frameName: string, data: unknown): void {
  if (frameName !== TASK_FRAME && frameName !== DAG_FRAME && frameName !== ACTIVITY_FRAME) return;
  const id = sessionAliases.get(sessionId) ?? sessionId;
  if (frameName === ACTIVITY_FRAME) {
    const parsed = parseDagActivity(data);
    if (parsed === null || parsed.taskId === undefined) return;
    const previous = overrides.get(id);
    const stamps = new Map(previous?.activity?.stamps ?? []);
    const known = stamps.get(parsed.taskId);
    if (known === undefined || parsed.at > known) stamps.set(parsed.taskId, parsed.at);
    const next = new Map(overrides);
    next.set(id, {
      ...previous,
      activity: { stamps, sequence: nextLiveActivitySequence(), receivedAt: Date.now() },
    });
    overrides = next;
    emit();
    return;
  }
  const previous = overrides.get(id) ?? {};
  const side = { payload: data ?? null, sequence: nextLiveActivitySequence(), receivedAt: Date.now() };
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
  return useMemo(() => {
    const summaries = new Map<string, LiveBadgeOverride>();
    for (const [id, entry] of snapshot) {
      const receivedAt = Math.max(
        entry.task?.receivedAt ?? 0,
        entry.dag?.receivedAt ?? 0,
        entry.activity?.receivedAt ?? 0,
      );
      summaries.set(id, {
        summary: summarizeLiveSession(
          { id, title: "", task: entry.task?.payload ?? null, dag: entry.dag?.payload ?? null },
          Date.now(),
          entry.activity === undefined ? undefined : { heartbeatStamps: entry.activity.stamps },
        ),
        receivedAt,
      });
    }
    return summaries;
  }, [snapshot]);
}

function newerPayload(
  side: SideOverride | undefined,
  pollPayload: unknown,
  nowMs: number,
): { readonly payload: unknown; readonly replaced: boolean } {
  if (side === undefined || side.payload === null) return { payload: pollPayload, replaced: false };
  if (nowMs - side.receivedAt > OVERRIDE_TTL_MS) return { payload: pollPayload, replaced: false };
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
      if (entry === undefined) return poll;
      const task = newerPayload(entry.task, poll.task ?? null, clockMs);
      const dag = newerPayload(entry.dag, poll.dag ?? null, clockMs);
      const mergedInfo = {
        id: poll.id,
        title: poll.title,
        task: task.payload,
        dag: dag.payload,
        taskOversized: task.replaced ? false : poll.taskSideOversized,
        dagOversized: dag.replaced ? false : poll.dagSideOversized,
        ...(!task.replaced && poll.taskDigest !== undefined ? { taskDigest: poll.taskDigest } : {}),
        ...(!dag.replaced && poll.dagDigest !== undefined ? { dagDigest: poll.dagDigest } : {}),
      } as LiveSessionInfo;
      // The poller listing the session is the process-alive signal, so the
      // merged summary never ages out its running tasks; heartbeat stamps
      // keep per-task freshness honest under the replaced payload.
      return summarizeLiveSession(mergedInfo, clockMs, {
        sessionLive: true,
        ...(entry.activity === undefined ? {} : { heartbeatStamps: entry.activity.stamps }),
      });
    }),
    [pollSummaries, snapshot, clockMs],
  );
}

/** Reset module state so fake-clock ordering and TTL tests are isolated. */
export function __resetLiveBadgeStoreForTests(): void {
  overrides = new Map();
  activitySequence = 0;
  sessionAliases = new Map();
  emit();
}
