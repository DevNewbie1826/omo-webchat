import { useMemo } from "react";
import { parseDagUpdated, parseTaskUpdated } from "../split/activityParse";
import type { ActivityTask } from "../split/activityTypes";
import { useLiveSessionInfos } from "./useLiveSessions";
import type { LiveSessionInfo } from "./workspace";

/** Per-session rollup shown by the sessions overview and the tree badge.
 * Counts tolerate null or malformed payloads: unparseable input counts as
 * "no activity", never as an error. */
export interface LiveSessionSummary {
  readonly id: string;
  readonly title: string;
  readonly runningCount: number;
  readonly doneCount: number;
  readonly dagDone: number;
  readonly dagTotal: number;
  /** Most recent live_progress last_assistant_line or activity across tasks;
   * null when no task reports one. */
  readonly lastLine: string | null;
}

// Status vocabulary mirrors the activity shelf: "running" is alive work and
// "completed" is finished work; every other status counts as neither.
function countStatuses(tasks: readonly ActivityTask[]): { running: number; done: number } {
  let running = 0;
  let done = 0;
  for (const task of tasks) {
    if (task.status === "running") running += 1;
    else if (task.status === "completed") done += 1;
  }
  return { running, done };
}

function lastLineOf(tasks: readonly ActivityTask[]): string | null {
  let bestAt: string | null = null;
  let bestLine: string | null = null;
  for (const task of tasks) {
    const line = task.liveProgress?.lastAssistantLine ?? task.liveProgress?.activity;
    if (line === undefined) continue;
    const at = task.updatedAt ?? task.createdAt ?? "";
    // `>=` breaks ties toward the later-listed task, matching payload order.
    if (bestAt === null || at >= bestAt) {
      bestAt = at;
      bestLine = line;
    }
  }
  return bestLine;
}

export function summarizeLiveSession(info: LiveSessionInfo): LiveSessionSummary {
  const tasks = (info.task == null ? null : parseTaskUpdated(info.task))?.tasks ?? [];
  const runs = (info.dag == null ? null : parseDagUpdated(info.dag))?.runs ?? [];
  const counts = countStatuses(tasks);
  let dagDone = 0;
  let dagTotal = 0;
  for (const run of runs) {
    dagDone += run.counts.completed;
    dagTotal += run.counts.total;
  }
  return {
    id: info.id,
    title: info.title,
    runningCount: counts.running,
    doneCount: counts.done,
    dagDone,
    dagTotal,
    lastLine: lastLineOf(tasks),
  };
}

/** Per-session activity rollups for live sessions, from the shared poller. */
export function useLiveSessionSummaries(enabled: boolean): readonly LiveSessionSummary[] {
  const infos = useLiveSessionInfos(enabled);
  return useMemo(() => infos.map(summarizeLiveSession), [infos]);
}
