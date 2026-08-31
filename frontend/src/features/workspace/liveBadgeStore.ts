import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { summarizeLiveSession } from "./useLiveSessionSummaries";
import type { LiveSessionSummary } from "./useLiveSessionSummaries";

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

// Poll arrival is tracked by content rather than array identity because the
// summary freshness tick can regenerate an equal array without a new poll.
let lastPollFingerprint = "";
let pollArrivalMs = 0;

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
  const previous = overrides.get(sessionId) ?? {};
  const side = { payload: data ?? null, arrival: nextArrival() };
  const next = new Map(overrides);
  next.set(sessionId, frameName === TASK_FRAME
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

function newerPayload(side: SideOverride | undefined, pollPayload: unknown, nowMs: number): unknown {
  if (side === undefined || side.payload === null) return pollPayload;
  if (side.arrival <= pollArrivalMs) return pollPayload;
  if (nowMs - side.arrival > OVERRIDE_TTL_MS) return pollPayload;
  return side.payload;
}

/** Poll summaries and WS frames merged last-writer-wins independently for the
 * task and DAG sides. The poll provides one shared arrival stamp for both. */
export function useMergedLiveSummaries(pollSummaries: readonly LiveSessionSummary[]): readonly LiveSessionSummary[] {
  const fingerprint = JSON.stringify(pollSummaries);
  if (fingerprint !== lastPollFingerprint) {
    lastPollFingerprint = fingerprint;
    pollArrivalMs = nextArrival();
  }
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
      const entry = snapshot.get(poll.id);
      if (entry === undefined) return poll;
      const task = newerPayload(entry.task, poll.task ?? null, clockMs);
      const dag = newerPayload(entry.dag, poll.dag ?? null, clockMs);
      return summarizeLiveSession({
        id: poll.id,
        title: poll.title,
        task,
        dag,
        taskOversized: poll.taskOversized,
        dagOversized: poll.dagOversized,
      }, clockMs);
    }),
    [pollSummaries, snapshot, clockMs],
  );
}

/** Reset module state so fake-clock ordering and TTL tests are isolated. */
export function __resetLiveBadgeStoreForTests(): void {
  overrides = new Map();
  lastArrivalMs = 0;
  lastPollFingerprint = "";
  pollArrivalMs = 0;
  emit();
}
