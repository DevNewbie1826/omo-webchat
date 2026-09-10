import { useEffect, useMemo, useState } from "react";
import { parseDagUpdated, parseTaskUpdated } from "../split/activityParse";
import type { ParsedDagUpdated } from "../split/activityParseDag";
import type { ParsedTaskUpdated } from "../split/activityParseTask";
import { isRecord } from "../../lib/chatWsParseFields";
import { lastActivityMs, taskStatusCounts, TERMINAL_DAG_STATUSES } from "../split/activityShelfModel";
import type { ActivityDagRun, ActivityTask } from "../split/activityTypes";
import type { DagDigest, TaskDigest, DagDigestRun, TaskDigestEntry } from "./activityDigest";
import { reconcileTaskSources } from "../split/taskAuthority";
import { canonicalLiveSessionId, useLiveAgentAggregates } from "./liveBadgeStore";
import { useLiveSessionInfos } from "./useLiveSessions";
import type { LiveSessionInfo } from "./workspace";

/** Per-session rollup shown by the sessions overview and the tree badge.
 * Running counts come from the server's pre-truncation scalars whenever the
 * transports carry them; retained rows only back the legacy fallback. */
/** Quiet-running cutoff for summaries whose session liveness is not already
 * established by the shared poller (WS-only override summaries); mirrors
 * OVERRIDE_TTL_MS in liveBadgeStore. A session the poller lists keeps its
 * running tasks counted no matter how long they have been quiet - zombie
 * pruning happens when the session leaves the live list. */
export const STALE_RUNNING_WINDOW_MS = 90_000;
const FRESHNESS_TICK_MS = 15_000;

export interface LiveSessionSummary {
  readonly id: string;
  readonly title: string;
  /** Raw sides retained so WS updates can be merged independently with polls. */
  readonly task?: unknown;
  readonly dag?: unknown;
  /** Parsed poll digests retained when a WS frame replaces only the other side. */
  readonly taskDigest?: TaskDigest;
  readonly dagDigest?: DagDigest;
  /** Raw wire flags, distinct from the flattened unknown-state UI flags below. */
  readonly taskSideOversized: boolean;
  readonly dagSideOversized: boolean;
  readonly runningCount: number;
  readonly doneCount: number;
  readonly dagDone: number;
  readonly dagTotal: number;
  /** Most recent live_progress last_assistant_line or activity across tasks;
   * null when no task reports one. */
  readonly lastLine: string | null;
  /** DAG-side running contribution to runningCount after overlap removal. */
  readonly dagRunning: number;
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

/** Count only identified running nodes. Aggregate counts cannot be deduplicated
 * against authoritative task rows, and missing topology is qualified separately. */
function dagRunningOf(runs: readonly ActivityDagRun[], taskIds: ReadonlySet<string>): number {
  let running = 0;
  const seenTasks = new Set(taskIds);
  const seenRuns = new Set<string>();
  for (const run of runs) {
    if (run.runId === "" || TERMINAL_DAG_STATUSES.has(run.status) || seenRuns.has(run.runId)) continue;
    seenRuns.add(run.runId);
    const seenNodes = new Set<string>();
    for (const node of run.nodes) {
      if (node.id === "" || seenNodes.has(node.id)) continue;
      seenNodes.add(node.id);
      if (node.state !== "running") continue;
      // An empty optional task ID has only the run/node identity above.
      if (node.taskId !== undefined && node.taskId !== "") {
        if (seenTasks.has(node.taskId)) continue;
        seenTasks.add(node.taskId);
      }
      running += 1;
    }
  }
  return running;
}

function digestUpdatedMs(updatedAt: string | undefined): number | null {
  if (updatedAt === undefined) return null;
  const ms = Date.parse(updatedAt);
  return Number.isNaN(ms) ? null : ms;
}

function digestReceivedMs(receivedAt: string | undefined): number | null {
  return digestUpdatedMs(receivedAt);
}

/** Freshness inputs beyond the raw payloads. sessionLive records that the
 * shared live-session poller currently lists the session: that process-alive
 * signal is authoritative, so its running tasks keep counting while quiet.
 * heartbeatStamps maps task id to the latest omo.dag.activity activity stamp
 * (ISO), mirroring the activity shelf's rule that a task's staleness follows
 * the heartbeat rather than the last task snapshot. */
export interface SummaryFreshness {
  readonly sessionLive?: boolean;
  readonly heartbeatStamps?: ReadonlyMap<string, string>;
  /** The shared store's elected agent-work aggregate. Its acceptance ordering
   * across task and DAG deliveries has already been applied by the shared
   * count authority, so when present it is the sole running-count authority
   * and no payload row clock is consulted. */
  readonly agentAggregate?: AcceptedAgentAggregate;
}

/** The accepted agent-count aggregate for one session: the exact deduplicated
 * running/total pair the shared store elected by admission ordering. */
export interface AcceptedAgentAggregate {
  readonly running: number;
  readonly total: number | undefined;
}

/** Latest known activity of a task: its row stamp, raised by any fresher
 * heartbeat stamp for the same task id. */
function stampedActivityMs(
  taskId: string,
  rowMs: number | null,
  heartbeatStamps: ReadonlyMap<string, string> | undefined,
): number | null {
  const at = heartbeatStamps?.get(taskId);
  if (at === undefined) return rowMs;
  const beatMs = Date.parse(at);
  if (Number.isNaN(beatMs)) return rowMs;
  return rowMs === null || beatMs > rowMs ? beatMs : rowMs;
}

function countDigestTaskRunning(
  entries: readonly TaskDigestEntry[],
  nowMs: number,
  runningDagTaskIds: ReadonlySet<string>,
  receivedAtMs: number | null,
  freshness: SummaryFreshness | undefined,
): number {
  const digestFresh = receivedAtMs !== null && nowMs - receivedAtMs <= STALE_RUNNING_WINDOW_MS;
  let running = 0;
  for (const entry of entries) {
    if (entry.status !== "running") continue;
    if (freshness?.sessionLive === true) {
      running += 1;
      continue;
    }
    const lastMs = stampedActivityMs(
      entry.taskId,
      digestUpdatedMs(entry.updatedAt),
      freshness?.heartbeatStamps,
    );
    const rowFresh = lastMs === null || nowMs - lastMs <= STALE_RUNNING_WINDOW_MS;
    const dagAuthority = runningDagTaskIds.has(entry.taskId);
    if (digestFresh || dagAuthority || rowFresh) {
      running += 1;
    }
  }
  return running;
}

function countDigestDagRunning(runs: readonly DagDigestRun[], taskIds: ReadonlySet<string>): number {
  let running = 0;
  const seenTasks = new Set(taskIds);
  for (const run of runs) {
    if (TERMINAL_DAG_STATUSES.has(run.status)) continue;
    for (const taskId of run.runningTaskIds) {
      if (seenTasks.has(taskId)) continue;
      seenTasks.add(taskId);
      running += 1;
    }
  }
  return running;
}

export function summarizeLiveSession(
  info: LiveSessionInfo,
  nowMs = Date.now(),
  freshness?: SummaryFreshness,
): LiveSessionSummary {
  const parsedTask = info.task == null ? null : parseTaskUpdated(info.task);
  const taskProjection = reconcileTaskSources({ tasks: new Map<string, ActivityTask>() }, parsedTask, info.taskDigest);
  const tasks = [...taskProjection.tasks.values()];
  const parsedDag = info.dag == null ? null : parseDagUpdated(info.dag);
  const runs = parsedDag?.runs ?? [];
  const counts = taskStatusCounts(tasks);
  // An oversized side retains the server's previous cached payload. Parse it
  // for descriptive fields such as lastLine, but never treat stale rows as a
  // trustworthy running-count lower bound. Compact digests, when present, are
  // the running-count source instead of those cached rows.
  const taskDigest = info.taskDigest;
  const dagDigest = info.dagOversized === true ? info.dagDigest : undefined;
  const runningDagTaskIds = new Set<string>();
  if (info.dagOversized !== true) {
    for (const run of runs) {
      if (TERMINAL_DAG_STATUSES.has(run.status)) continue;
      for (const node of run.nodes) {
        if (node.state !== "running" || node.taskId === undefined) continue;
        runningDagTaskIds.add(node.taskId);
      }
    }
  } else if (dagDigest !== undefined) {
    for (const run of dagDigest.runs) {
      if (TERMINAL_DAG_STATUSES.has(run.status)) continue;
      for (const taskId of run.runningTaskIds) runningDagTaskIds.add(taskId);
    }
  }
  const taskIds = new Set(
    info.taskOversized !== true
      ? tasks.map((task) => task.taskId)
      : taskDigest === undefined
        ? []
        : taskDigest.tasks.map((entry) => entry.taskId),
  );
  const sessionLive = freshness?.sessionLive === true;
  const heartbeatStamps = freshness?.heartbeatStamps;
  // Server pre-truncation scalars are the sole count authority when present;
  // retained rows below only back the legacy fallback for older servers.
  const taskScalar = taskDigest?.taskRunningCount ?? parsedTask?.taskRunningCount;
  const dagScalar = info.dagDigest?.dagRunningCount;
  const dagEnvelopeComplete = isRecord(info.dag) && Array.isArray(info.dag["runs"])
    && info.dag["runs"].length === runs.length && info.dag["partial"] !== true;
  const taskRosterComplete = info.taskOversized !== true
    ? parsedTask?.truncatedTasks !== true
    : taskDigest !== undefined && taskDigest.truncated !== true;
  const dagIdsComplete = info.dagOversized !== true
    ? parsedDag !== null && parsedDag.truncatedRuns !== true && dagEnvelopeComplete
    : dagDigest !== undefined && dagDigest.truncated !== true;
  const taskRunning = taskScalar !== undefined
    ? taskScalar
    : info.taskOversized !== true
    ? tasks.filter((task) => {
      if (task.status !== "running") return false;
      // The poller listing the session is the process-alive signal: a quiet
      // running task keeps counting until the session leaves the live list.
      if (sessionLive) return true;
      const lastMs = stampedActivityMs(task.taskId, lastActivityMs(task), heartbeatStamps);
      return lastMs === null || nowMs - lastMs <= STALE_RUNNING_WINDOW_MS
        || runningDagTaskIds.has(task.taskId);
    }).length
    : taskDigest === undefined
      ? 0
      : countDigestTaskRunning(
        taskDigest.tasks,
        nowMs,
        runningDagTaskIds,
        digestReceivedMs(taskDigest.receivedAt),
        freshness,
      );
  // The dag scalar is a node-based sum over all runs, without task-roster
  // exclusion. Overlap is removed only when both identity sides are provably
  // complete; otherwise the summed scalars are the authoritative count.
  const overlap = dagScalar !== undefined && taskRosterComplete && dagIdsComplete
    ? [...runningDagTaskIds].filter((taskId) => taskIds.has(taskId)).length
    : null;
  const dagRunning = dagScalar === undefined
    ? info.dagOversized !== true
      ? dagRunningOf(runs, taskIds)
      : dagDigest === undefined
        ? 0
        : countDigestDagRunning(dagDigest.runs, taskIds)
    : overlap === null ? dagScalar : Math.max(0, dagScalar - overlap);
  const agentRunning = freshness?.agentAggregate !== undefined
    ? freshness.agentAggregate.running
    : orderedAgentAuthority(parsedTask, taskDigest, parsedDag, info.dagDigest)?.running;
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
    ...(info.taskDigest === undefined ? {} : { taskDigest: info.taskDigest }),
    ...(info.dagDigest === undefined ? {} : { dagDigest: info.dagDigest }),
    taskSideOversized: info.taskOversized === true,
    dagSideOversized: info.dagOversized === true,
    // The exact deduplicated agent-work aggregate is the sole running
    // authority when any transport carries it: raw task+DAG scalars are never
    // summed and retained rows never repair it.
    runningCount: agentRunning ?? (taskRunning + dagRunning),
    doneCount: info.taskOversized === true && taskDigest === undefined ? 0 : counts.done,
    dagDone,
    dagTotal,
    lastLine: lastLineOf(tasks),
    dagRunning,
  };
}


/** Within one summary envelope the aggregate is structural, never a clock
 * comparison: the current server-computed digests are the aggregate
 * authority while a snapshot payload's scalar can be a cached per-side
 * snapshot, so both digests outrank both payloads; the DAG side remains the
 * later completion source within each tier, and ordering across separate
 * deliveries is decided by the shared store's accepted-delivery admission
 * clock before this fallback ever runs. */
function orderedAgentAuthority(
  parsedTask: ParsedTaskUpdated | null,
  taskDigest: TaskDigest | undefined,
  parsedDag: ParsedDagUpdated | null,
  dagDigest: DagDigest | undefined,
): { readonly running: number; readonly total: number | undefined } | undefined {
  if (dagDigest?.agentRunningCount !== undefined) {
    return { running: dagDigest.agentRunningCount, total: dagDigest.agentTotalCount };
  }
  if (taskDigest?.taskAgentRunningCount !== undefined) {
    return { running: taskDigest.taskAgentRunningCount, total: taskDigest.taskAgentTotalCount };
  }
  if (parsedDag?.agentRunningCount !== undefined) {
    return { running: parsedDag.agentRunningCount, total: parsedDag.agentTotalCount };
  }
  if (parsedTask?.taskAgentRunningCount !== undefined) {
    return { running: parsedTask.taskAgentRunningCount, total: parsedTask.taskAgentTotalCount };
  }
  return undefined;
}

/** Per-session activity rollups for live sessions, from the shared poller. */
export function useLiveSessionSummaries(enabled: boolean): readonly LiveSessionSummary[] {
  const infos = useLiveSessionInfos(enabled);
  const aggregates = useLiveAgentAggregates();
  const [clockMs, setClockMs] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return;
    setClockMs(Date.now());
    const timer = window.setInterval(() => setClockMs(Date.now()), FRESHNESS_TICK_MS);
    return () => window.clearInterval(timer);
  }, [enabled]);

  return useMemo(
    () => infos.map((info) => {
      const agentAggregate = aggregates.get(canonicalLiveSessionId(info.id));
      return summarizeLiveSession(info, clockMs, {
        sessionLive: true,
        ...(agentAggregate === undefined ? {} : { agentAggregate }),
      });
    }),
    [infos, aggregates, clockMs],
  );
}
