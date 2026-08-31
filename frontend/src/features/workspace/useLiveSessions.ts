import { useMemo, useSyncExternalStore } from "react";
import { listLiveSessions } from "./workspace";
import type { LiveSessionInfo } from "./workspace";

const POLL_MS = 4000;
const STALL_MS = 30000;

const EMPTY_SESSIONS: readonly LiveSessionInfo[] = [];

// One module-level poller feeds every consumer hook, so the app makes a single
// GET /api/sessions/live round trip per cycle no matter how many components
// read live-session state (id set, summaries, or both). Polling runs only
// while at least one enabled hook is subscribed; the last data is dropped when
// the last subscription goes away, so a re-enabled poller starts clean.
//
// Chained scheduling serializes polls: the next request starts only after the
// current one settles, so requests never overlap (no stale overwrite, no
// pile-up) and every successful response applies (no starvation under a slow
// backend). A transient failure leaves the last known-good data in place, and
// a response identical to the previous one is reused to avoid a rerender. The
// stall guard aborts a request that never settles before rescheduling, so a
// hung backend cannot accumulate overlapping requests.
const listeners = new Set<() => void>();
let sessions: readonly LiveSessionInfo[] = EMPTY_SESSIONS;
let polling = false;
let timer: number | undefined;
let stallGuard: number | undefined;
let activeCtrl: AbortController | undefined;

function emit(): void {
  for (const listener of listeners) listener();
}

function apply(next: readonly LiveSessionInfo[]): void {
  // Payloads are fresh objects per response; compare the serialized form so an
  // unchanged snapshot keeps its array identity and subscribers don't rerender.
  if (JSON.stringify(next) === JSON.stringify(sessions)) return;
  sessions = next;
  emit();
}

function tick(): void {
  if (!polling) return;
  let settled = false;
  let superseded = false;
  const ctrl = new AbortController();
  activeCtrl = ctrl;
  const reschedule = (): void => {
    if (settled) return;
    settled = true;
    if (stallGuard !== undefined) window.clearTimeout(stallGuard);
    if (activeCtrl === ctrl) activeCtrl = undefined;
    if (polling) timer = window.setTimeout(tick, POLL_MS);
  };
  void listLiveSessions(ctrl.signal).then(
    (infos) => {
      if (polling && !superseded) apply(infos);
      reschedule();
    },
    reschedule,
  );
  stallGuard = window.setTimeout(() => {
    superseded = true;
    ctrl.abort();
    reschedule();
  }, STALL_MS);
}

function startPolling(): void {
  if (polling) return;
  polling = true;
  tick();
}

function stopPolling(): void {
  polling = false;
  if (timer !== undefined) {
    window.clearTimeout(timer);
    timer = undefined;
  }
  if (stallGuard !== undefined) {
    window.clearTimeout(stallGuard);
    stallGuard = undefined;
  }
  activeCtrl?.abort();
  activeCtrl = undefined;
  sessions = EMPTY_SESSIONS;
}

function subscribeLiveSessions(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  if (listeners.size === 1) startPolling();
  return () => {
    listeners.delete(onStoreChange);
    if (listeners.size === 0) stopPolling();
  };
}

function getSessions(): readonly LiveSessionInfo[] {
  return sessions;
}

const noopSubscribe = (): (() => void) => () => undefined;
const getEmptySessions = (): readonly LiveSessionInfo[] => EMPTY_SESSIONS;

/** Live session records polled from GET /api/sessions/live via the shared poller. */
export function useLiveSessionInfos(enabled: boolean): readonly LiveSessionInfo[] {
  return useSyncExternalStore(
    enabled ? subscribeLiveSessions : noopSubscribe,
    enabled ? getSessions : getEmptySessions,
  );
}

/** Ids of the sessions with a live provider process (established contract). */
export function useLiveSessions(enabled: boolean): ReadonlySet<string> {
  const infos = useLiveSessionInfos(enabled);
  return useMemo(() => new Set(infos.map((info) => info.id)), [infos]);
}
