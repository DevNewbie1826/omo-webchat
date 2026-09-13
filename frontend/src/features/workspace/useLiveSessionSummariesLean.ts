import type { LiveSessionSummary } from "./useLiveSessionSummaries";
import type { LiveSessionInfo } from "./useLiveSessionsLean";

/** Scalars already include server-side deduplication; never sum agents with
 * task/DAG counts, or reconstruct a supplied scalar from retained rows. */
export function applyLeanSummary(info: LiveSessionInfo, fallback?: LiveSessionSummary): LiveSessionSummary {
  const lean = info.lean;
  return {
    ...fallback,
    id: info.id, title: info.title,
    ...(info.active === undefined ? {} : { active: info.active }),
    ...(lean === undefined ? {} : { lean }),
    runningCount: lean?.running?.agents ?? fallback?.runningCount ?? 0,
    doneCount: lean?.done ?? fallback?.doneCount ?? 0,
    dagDone: lean?.dag_done ?? fallback?.dagDone ?? 0,
    dagTotal: lean?.dag_total ?? fallback?.dagTotal ?? 0,
    dagRunning: lean?.running?.dag ?? fallback?.dagRunning ?? 0,
    lastLine: lean?.last_line ?? fallback?.lastLine ?? null,
    taskSideOversized: lean?.truncated?.task ?? fallback?.taskSideOversized ?? false,
    dagSideOversized: lean?.truncated?.dag ?? fallback?.dagSideOversized ?? false,
  };
}

export function hasLeanSummary(info: LiveSessionInfo): boolean {
  return info.lean !== undefined;
}
