import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { summarizeLiveSession } from "./useLiveSessionSummaries";
import type { LiveSessionSummary } from "./useLiveSessionSummaries";
import type { LiveSessionInfo } from "./workspace";

/** How long a WS-pushed side stays authoritative, mirroring
 * STALE_RUNNING_WINDOW_MS in useLiveSessionSummaries. */
const OVERRIDE_TTL_MS = 90_000;
/** Re-evaluation cadence for expiry, mirroring the poll summaries' freshness tick. */
const FRESHNESS_TICK_MS = 15_000;

const TASK_FRAME = "omo.task.updated";
const DAG_FRAME = "omo.dag.updated";

interface SideOverride {
  readonly payload: unknown;
  readonly arrival: number;
}

/** Task and DAG payloads have independent arrival order. A one-sided frame
 * must not erase fresher data for the other side. */
interface SessionOverride {
  readonly task?: SideOverride;
  readonly dag?: SideOverride;
}

export interface LiveBadgeOverride {
  readonly summary: LiveSessionSummary;
  readonly receivedAt: number;
}

const listeners = new Set<() => void>();
let overrides: ReadonlyMap<string, SessionOverride> = new Map();
let lastArrivalMs = 0;

interface PollSideArrival {
  readonly fingerprint: string;
  readonly arrival: number;
}

interface PollSessionArrival {
  readonly task: PollSideArrival;
  readonly dag: PollSideArrival;
}

// Poll-side arrival is tracked by content because the summary freshness tick
// can regenerate equal rows without a new source update. Keeping it per
// session prevents an unrelated overview push from aging every attached frame.
let pollArrivals: ReadonlyMap<string, PollSessionArrival> = new Map();
let sessionAliases: ReadonlyMap<string, string> = new Map();

function emit(): void {
  for (const listener of listeners) listener();
}

/** One strictly-monotonic sequence orders both WS receipts and poll content
 * changes, including multiple arrivals in one wall-clock millisecond. */
function nextArrival(): number {
  const now = Date.now();
  lastArrivalMs = now > lastArrivalMs ? now : lastArrivalMs + 1;
  return lastArrivalMs;
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

/** Expire each side independently and retain a session while either side is fresh. */
function sweepExpired(nowMs: number): void {
  let changed = false;
  const next = new Map<string, SessionOverride>();
  for (const [id, entry] of overrides) {
    const task = entry.task !== undefined && nowMs - entry.task.arrival <= OVERRIDE_TTL_MS
      ? entry.task
      : undefined;
    const dag = entry.dag !== undefined && nowMs - entry.dag.arrival <= OVERRIDE_TTL_MS
      ? entry.dag
      : undefined;
    if (task !== entry.task || dag !== entry.dag) changed = true;
    if (task !== undefined || dag !== undefined) {
      next.set(id, {
        ...(task === undefined ? {} : { task }),
        ...(dag === undefined ? {} : { dag }),
      });
    }
  }
  if (!changed) return;
  overrides = next;
  emit();
}

/** Feed a WS extensionEvent frame into the badge store. Recognized null data
 * clears that side; unknown frame names leave the store untouched. */
export function ingestExtensionEvent(sessionId: string, frameName: string, data: unknown): void {
  if (frameName !== TASK_FRAME && frameName !== DAG_FRAME) return;
  const id = sessionAliases.get(sessionId) ?? sessionId;
  const previous = overrides.get(id) ?? {};
  const side = { payload: data ?? null, arrival: nextArrival() };
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
      const receivedAt = Math.max(entry.task?.arrival ?? 0, entry.dag?.arrival ?? 0);
      summaries.set(id, {
        summary: summarizeLiveSession({
          id,
          title: "",
          task: entry.task?.payload ?? null,
          dag: entry.dag?.payload ?? null,
        }),
        receivedAt,
      });
    }
    return summaries;
  }, [snapshot]);
}

function newerPayload(
  side: SideOverride | undefined,
  pollPayload: unknown,
  pollArrival: number,
  nowMs: number,
): { readonly payload: unknown; readonly replaced: boolean } {
  if (side === undefined || side.payload === null) return { payload: pollPayload, replaced: false };
  if (side.arrival <= pollArrival) return { payload: pollPayload, replaced: false };
  if (nowMs - side.arrival > OVERRIDE_TTL_MS) return { payload: pollPayload, replaced: false };
  return { payload: side.payload, replaced: true };
}

function parentSessionIdOf(summary: LiveSessionSummary): string | undefined {
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
  const nextPollArrivals = new Map<string, PollSessionArrival>();
  const nextAliases = new Map<string, string>();
  for (const poll of pollSummaries) {
    const parentId = parentSessionIdOf(poll);
    if (parentId !== undefined && parentId !== poll.id) nextAliases.set(parentId, poll.id);
    const previous = pollArrivals.get(poll.id);
    const taskFingerprint = JSON.stringify([poll.task ?? null, poll.taskSideOversized, poll.taskDigest]);
    const dagFingerprint = JSON.stringify([poll.dag ?? null, poll.dagSideOversized, poll.dagDigest]);
    nextPollArrivals.set(poll.id, {
      task: previous?.task.fingerprint === taskFingerprint
        ? previous.task
        : { fingerprint: taskFingerprint, arrival: nextArrival() },
      dag: previous?.dag.fingerprint === dagFingerprint
        ? previous.dag
        : { fingerprint: dagFingerprint, arrival: nextArrival() },
    });
  }
  pollArrivals = nextPollArrivals;
  sessionAliases = nextAliases;
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
      const arrivals = pollArrivals.get(poll.id);
      const task = newerPayload(entry.task, poll.task ?? null, arrivals?.task.arrival ?? 0, clockMs);
      const dag = newerPayload(entry.dag, poll.dag ?? null, arrivals?.dag.arrival ?? 0, clockMs);
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
      return summarizeLiveSession(mergedInfo, clockMs);
    }),
    [pollSummaries, snapshot, clockMs],
  );
}

/** Reset module state so fake-clock ordering and TTL tests are isolated. */
export function __resetLiveBadgeStoreForTests(): void {
  overrides = new Map();
  lastArrivalMs = 0;
  pollArrivals = new Map();
  sessionAliases = new Map();
  emit();
}
