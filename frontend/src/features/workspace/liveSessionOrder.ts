/** Minimal shape the live-session ordering needs; LiveSessionSummary and the
 * sidebar's row view both satisfy it structurally. */
export interface LiveSessionOrderable {
  readonly id: string;
  readonly title: string;
  /** Main-session work, independent of child counts. */
  readonly active?: boolean;
  readonly runningCount: number;
}

function isWorking(session: LiveSessionOrderable): boolean {
  return session.active === true || session.runningCount > 0;
}

/** Membership in the live-session list. The poll still returns legacy rows
 * for sessions whose work has all finished (no `active` flag, no running
 * agents); those are history, not live sessions. An explicit `active`
 * boolean - true or false - means the session is attached, so idle rows the
 * server flags with `active: false` stay listed. */
export function isLiveSessionListed(session: LiveSessionOrderable): boolean {
  return session.active !== undefined || session.runningCount > 0;
}

/** Total, stable order for the live-session list: working sessions first,
 * then most recent activity; ties fall back to title then id. The caller
 * supplies last-activity timestamps (ms) keyed by session id; sessions with
 * no known timestamp sort last within their group. */
export function compareLiveSessions(
  a: LiveSessionOrderable,
  b: LiveSessionOrderable,
  lastActivityMs: ReadonlyMap<string, number>,
): number {
  const workingDelta = Number(isWorking(b)) - Number(isWorking(a));
  if (workingDelta !== 0) return workingDelta;
  const aMs = lastActivityMs.get(a.id) ?? Number.NEGATIVE_INFINITY;
  const bMs = lastActivityMs.get(b.id) ?? Number.NEGATIVE_INFINITY;
  if (aMs !== bMs) return bMs - aMs;
  if (a.title !== b.title) return a.title < b.title ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
