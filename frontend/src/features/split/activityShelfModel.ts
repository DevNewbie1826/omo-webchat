import type { Translate } from "../../i18n";
import type { ActivityDagRun, ActivityTask, TodoPhase } from "./activityTypes";

export type DagView = "list" | "graph";
export type StatusKind = "running" | "ok" | "error" | "muted";

export const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
  "lost",
  "interrupted",
  "error",
  "skipped",
]);
export const TERMINAL_DAG_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
]);
const KNOWN_STATUSES: ReadonlySet<string> = new Set([
  "running",
  "completed",
  "failed",
  "cancelled",
  "pending",
  "blocked",
  "scheduled",
  "skipped",
]);

export function statusKind(status: string): StatusKind {
  if (status === "running") return "running";
  if (status === "completed") return "ok";
  if (status === "failed" || status === "error") return "error";
  return "muted";
}

export function statusLabel(t: Translate, status: string): string {
  return KNOWN_STATUSES.has(status) ? t(`activity.status.${status}`) : status;
}

export function lastActivityMs(task: ActivityTask): number | null {
  for (const stamp of [task.updatedAt, task.createdAt]) {
    if (stamp === undefined) continue;
    const ms = Date.parse(stamp);
    if (!Number.isNaN(ms)) return ms;
  }
  return null;
}

export function agentTimeMs(task: ActivityTask): number | null {
  const stamp = task.createdAt ?? task.updatedAt;
  if (stamp === undefined) return null;
  const ms = Date.parse(stamp);
  return Number.isNaN(ms) ? null : ms;
}

export function dagTimeMs(run: ActivityDagRun): number | null {
  const stamp = run.createdAt ?? run.updatedAt;
  if (stamp === undefined) return null;
  const ms = Date.parse(stamp);
  return Number.isNaN(ms) ? null : ms;
}

export function orderActivities<T>(
  items: readonly T[],
  isTerminal: (item: T) => boolean,
  startMs: (item: T) => number | null,
): readonly T[] {
  return items.slice().sort((a, b) => {
    const terminalOrder = Number(isTerminal(a)) - Number(isTerminal(b));
    if (terminalOrder !== 0) return terminalOrder;
    const aStart = startMs(a);
    const bStart = startMs(b);
    if (aStart === null && bStart === null) return 0;
    if (aStart === null) return 1;
    if (bStart === null) return -1;
    return bStart - aStart;
  });
}

export function agoText(deltaMs: number): string {
  const seconds = Math.floor(Math.max(0, deltaMs) / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

export function todoCounts(
  phases: readonly TodoPhase[],
): { readonly done: number; readonly total: number } {
  let done = 0;
  let total = 0;
  for (const phase of phases) {
    for (const task of phase.tasks) {
      total += 1;
      if (task.status === "completed") done += 1;
    }
  }
  return { done, total };
}
