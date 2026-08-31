import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { summarizeLiveSession } from "./useLiveSessionSummaries";
import type { LiveSessionSummary } from "./useLiveSessionSummaries";

/** How long a WS-pushed override stays authoritative, mirroring
 * STALE_RUNNING_WINDOW_MS in useLiveSessionSummaries. */
const OVERRIDE_TTL_MS = 90_000;
/** Re-evaluation cadence for expiry, mirroring the poll summaries' freshness tick. */
const FRESHNESS_TICK_MS = 15_000;

const TASK_FRAME = "omo.task.updated";
const DAG_FRAME = "omo.dag.updated";

/** Raw per-session WS payloads plus the (monotonic) receipt time of the most
 * recent accepted frame. Payloads accumulate per side: a task frame keeps the
 * previously seen dag payload and vice versa. */
interface SessionOverride {
  readonly task: unknown;
  readonly dag: unknown;
  readonly receivedAt: number;
}

export interface LiveBadgeOverride {
  readonly summary: LiveSessionSummary;
  readonly receivedAt: number;
}

// One module-level store feeds every consumer, mirroring the shared poller in
// useLiveSessions: snapshots are replaced immutably so useSyncExternalStore
// sees a new identity exactly when content changes, and the map survives
// unmounts so the badge stays live while no chat pane is attached.
const listeners = new Set<() => void>();
let overrides: ReadonlyMap<string, SessionOverride> = new Map();
let lastReceiptMs = 0;

// Arrival time of the poll content currently being merged. Tracked by content
// fingerprint rather than array identity: useLiveSessionSummaries regenerates
// its array every 15s freshness tick even when content is unchanged, which
// would stamp a false "newer poll" arrival and wrongly outrank live frames.
let lastPollFingerprint = "";
let pollArrivalMs = 0;

function emit(): void {
  for (const listener of listeners) listener();
}

/** Strictly monotonic receipt stamp: wall clock, but never equal to or below
 * the previous stamp even when frames land within the same millisecond. */
function receiptMs(): number {
  const now = Date.now();
  lastReceiptMs = now > lastReceiptMs ? now : lastReceiptMs + 1;
  return lastReceiptMs;
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

/** Drop entries older than the TTL; emits only when something was dropped. */
function sweepExpired(nowMs: number): void {
  const next = new Map<string, SessionOverride>();
  for (const [id, entry] of overrides) {
    if (nowMs - entry.receivedAt <= OVERRIDE_TTL_MS) next.set(id, entry);
  }
  if (next.size === overrides.size) return;
  overrides = next;
  emit();
}

/** Feed a WS extensionEvent frame into the badge store. Accepts only
 * omo.task.updated and omo.dag.updated; any other frame name is ignored. */
export function ingestExtensionEvent(sessionId: string, frameName: string, data: unknown): void {
  const task = frameName === TASK_FRAME ? (data ?? null) : null;
  const dag = frameName === DAG_FRAME ? (data ?? null) : null;
  if (task === null && dag === null) return;
  const previous = overrides.get(sessionId);
  const next = new Map(overrides);
  next.set(sessionId, {
    task: task ?? previous?.task ?? null,
    dag: dag ?? previous?.dag ?? null,
    receivedAt: receiptMs(),
  });
  overrides = next;
  emit();
}

/** WS-pushed per-session override summaries built from the raw payloads. */
export function useLiveBadgeOverrides(): ReadonlyMap<string, LiveBadgeOverride> {
  const snapshot = useSyncExternalStore(subscribeOverrides, getOverridesSnapshot);
  return useMemo(() => {
    const summaries = new Map<string, LiveBadgeOverride>();
    for (const [id, entry] of snapshot) {
      summaries.set(id, {
        summary: summarizeLiveSession({ id, title: "", task: entry.task, dag: entry.dag }),
        receivedAt: entry.receivedAt,
      });
    }
    return summaries;
  }, [snapshot]);
}

/** Poll summaries with fresher WS-pushed overrides spliced in. */
export function useMergedLiveSummaries(pollSummaries: readonly LiveSessionSummary[]): readonly LiveSessionSummary[] {
  const fingerprint = JSON.stringify(pollSummaries);
  if (fingerprint !== lastPollFingerprint) {
    lastPollFingerprint = fingerprint;
    pollArrivalMs = Date.now();
  }
  const overrides = useLiveBadgeOverrides();
  const [clockMs, setClockMs] = useState(() => Date.now());

  useEffect(() => {
    const tick = (): void => {
      sweepExpired(Date.now());
      setClockMs(Date.now());
    };
    tick();
    const timer = window.setInterval(tick, FRESHNESS_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  return useMemo(
    () =>
      pollSummaries.map((poll) => {
        const override = overrides.get(poll.id);
        // Last writer wins by arrival: the override replaces the poll
        // snapshot unless it was received strictly before that snapshot, and
        // only while fresh. A same-millisecond frame counts as fresher: the
        // poll payload was generated server-side before its response
        // arrived, so a frame landing in the same ms is newer data.
        if (override === undefined) return poll;
        if (override.receivedAt < pollArrivalMs) return poll;
        if (clockMs - override.receivedAt > OVERRIDE_TTL_MS) return poll;
        // WS payloads carry neither the session title nor the HTTP oversized
        // flags, so keep those from the replaced poll summary.
        return {
          ...override.summary,
          title: poll.title,
          taskOversized: poll.taskOversized,
          dagOversized: poll.dagOversized,
        };
      }),
    [pollSummaries, overrides, clockMs],
  );
}
