import { useEffect, useMemo, useState } from "react";
import { parseDagUpdated, parseTaskUpdated } from "../split/activityParse";
import { lastActivityMs, taskStatusCounts, TERMINAL_DAG_STATUSES } from "../split/activityShelfModel";
import type { ActivityDagRun, ActivityTask } from "../split/activityTypes";
import { useLiveSessionInfos } from "./useLiveSessions";
import type { LiveSessionInfo } from "./workspace";

/** Per-session rollup shown by the sessions overview and the tree badge.
 * Counts tolerate null or malformed payloads: unparseable input counts as
 * "no activity", never as an error. */
/** Mirrors SEVERED_ACTIVITY_MS: quiet running tasks no longer count as active. */
export const STALE_RUNNING_WINDOW_MS = 90_000;
const FRESHNESS_TICK_MS = 15_000;

export interface LiveSessionSummary {
  readonly id: string;
  readonly title: string;
  /** Raw sides retained so WS updates can be merged independently with polls. */
  readonly task?: unknown;
  readonly dag?: unknown;
  readonly runningCount: number;
  readonly doneCount: number;
  readonly dagDone: number;
  readonly dagTotal: number;
  /** Most recent live_progress last_assistant_line or activity across tasks;
   * null when no task reports one. */
  readonly lastLine: string | null;
  /** DAG-side running children not already present in the task list. */
  readonly dagRunning: number;
  readonly truncatedTasks: boolean;
  readonly taskOversized: boolean;
  readonly dagOversized: boolean;
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

/** Running DAG children not already represented by a task row (any status).
 * Prefer node-level rows when a run has them; otherwise use counts.running. */
function dagRunningOf(runs: readonly ActivityDagRun[], taskIds: ReadonlySet<string>): number {
  let running = 0;
  for (const run of runs) {
    if (run.nodes.length === 0) {
      running += run.counts.running;
      continue;
    }
    for (const node of run.nodes) {
      if (node.state !== "running") continue;
      if (node.taskId !== undefined && taskIds.has(node.taskId)) continue;
      running += 1;
    }
  }
  return running;
}

export function summarizeLiveSession(info: LiveSessionInfo, nowMs = Date.now()): LiveSessionSummary {
  const parsedTask = info.task == null ? null : parseTaskUpdated(info.task);
  const tasks = parsedTask?.tasks ?? [];
  const runs = (info.dag == null ? null : parseDagUpdated(info.dag))?.runs ?? [];
  const counts = taskStatusCounts(tasks);
  // An oversized side retains the server's previous cached payload. Parse it
  // for descriptive fields such as lastLine, but never treat stale rows as a
  // trustworthy running-count lower bound.
  const runningDagTaskIds = new Set<string>();
  for (const run of runs) {
    if (TERMINAL_DAG_STATUSES.has(run.status)) continue;
    for (const node of run.nodes) {
      if (node.state !== "running" || node.taskId === undefined) continue;
      runningDagTaskIds.add(node.taskId);
    }
  }
  const taskIds = new Set(info.taskOversized === true ? [] : tasks.map((task) => task.taskId));
  const taskRunning = info.taskOversized === true ? 0 : tasks.filter((task) => {
    if (task.status !== "running") return false;
    const lastMs = lastActivityMs(task);
    return lastMs === null || nowMs - lastMs <= STALE_RUNNING_WINDOW_MS || runningDagTaskIds.has(task.taskId);
  }).length;
  const dagRunning = info.dagOversized === true ? 0 : dagRunningOf(runs, taskIds);
  let dagDone = 0;
  let dagTotal = 0;
  for (const run of runs) {
    dagDone += run.counts.completed;
    dagTotal += run.counts.total;
  }
  return {
    id: info.id,
    title: info.title,
    task: info.task,
    dag: info.dag,
    runningCount: taskRunning + dagRunning,
    doneCount: counts.done,
    dagDone,
    dagTotal,
    lastLine: lastLineOf(tasks),
    dagRunning,
    truncatedTasks: parsedTask?.truncatedTasks === true,
    taskOversized: info.taskOversized === true,
    dagOversized: info.dagOversized === true,
  };
}

/** Per-session activity rollups for live sessions, from the shared poller. */
export function useLiveSessionSummaries(enabled: boolean): readonly LiveSessionSummary[] {
  const infos = useLiveSessionInfos(enabled);
  const [clockMs, setClockMs] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return;
    setClockMs(Date.now());
    const timer = window.setInterval(() => setClockMs(Date.now()), FRESHNESS_TICK_MS);
    return () => window.clearInterval(timer);
  }, [enabled]);

  return useMemo(() => infos.map((info) => summarizeLiveSession(info, clockMs)), [infos, clockMs]);
}
