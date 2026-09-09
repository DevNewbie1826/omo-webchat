import { useEffect, useMemo, useState } from "react";
import { parseDagUpdated, parseTaskUpdated } from "../split/activityParse";
import type { ParsedDagUpdated } from "../split/activityParse";
import { isRecord } from "../../lib/chatWsParseFields";
import { lastActivityMs, taskStatusCounts, TERMINAL_DAG_STATUSES } from "../split/activityShelfModel";
import type { ActivityDagRun, ActivityTask } from "../split/activityTypes";
import type { DagDigest, TaskDigest, DagDigestRun, TaskDigestEntry } from "./activityDigest";
import { reconcileTaskSources } from "../split/taskAuthority";
import { useLiveSessionInfos } from "./useLiveSessions";
import type { LiveSessionInfo } from "./workspace";

/** Per-session rollup shown by the sessions overview and the tree badge.
 * Malformed DAG input contributes no invented running work and qualifies
 * the retained count as partial, never as authoritative inactivity. */
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
  /** DAG-side running children not already present in the task list. */
  readonly dagRunning: number;
  /** Running-count lower bound: task/digest truncation or incomplete rich DAG data. */
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

/** The shared tolerant parser drops malformed members and defaults missing
 * topology/counts. At this raw summary boundary, those losses must not certify
 * a complete count. Keep this independent of heartbeat/liveness information. */
function dagCountPartial(data: unknown, parsed: ParsedDagUpdated | null): boolean {
  if (data == null) return false;
  if (!isRecord(data) || parsed === null || !Array.isArray(data["runs"])) return true;
  if (data["partial"] === true || parsed.truncatedRuns === true || data["runs"].length !== parsed.runs.length) return true;
  const rawRuns = data["runs"];
  const runIds = new Set<string>();
  return parsed.runs.some((run, index) => {
    const raw = rawRuns[index];
    if (!isRecord(raw) || raw["partial"] === true || run.runId === "" || runIds.has(run.runId)) return true;
    runIds.add(run.runId);
    if (!Array.isArray(raw["nodes"]) || run.nodes.length === 0 || raw["nodes"].length !== run.nodes.length) return true;
    for (const key of ["edges", "waves"] as const) {
      const members = raw[key];
      if (members !== undefined && (!Array.isArray(members) || members.length !== run[key].length)) return true;
    }
    const nodeIds = new Set(run.nodes.map((node) => node.id));
    if (nodeIds.has("") || nodeIds.size !== run.nodes.length || run.counts.total !== run.nodes.length) return true;
    const states = new Map<string, number>();
    for (const node of run.nodes) {
      if (!Object.hasOwn(run.counts, node.state) || node.state === "total" || node.dependsOn.some((id) => !nodeIds.has(id))) return true;
      states.set(node.state, (states.get(node.state) ?? 0) + 1);
    }
    for (const [state, count] of Object.entries(run.counts)) {
      if (!Number.isSafeInteger(count) || count < 0 || (state !== "total" && count !== (states.get(state) ?? 0))) return true;
    }
    return run.edges.some((edge) => !nodeIds.has(edge.from) || !nodeIds.has(edge.to))
      || run.waves.some((wave) => wave.nodeIds.some((id) => !nodeIds.has(id)));
  });
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
  const taskRunning = info.taskOversized !== true
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
  const dagRunning = info.dagOversized !== true
    ? dagRunningOf(runs, taskIds)
    : dagDigest === undefined
      ? 0
      : countDigestDagRunning(dagDigest.runs, taskIds);
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
    runningCount: taskRunning + dagRunning,
    doneCount: info.taskOversized === true && taskDigest === undefined ? 0 : counts.done,
    dagDone,
    dagTotal,
    lastLine: lastLineOf(tasks),
    dagRunning,
    truncatedTasks: parsedTask?.truncatedTasks === true
      || taskDigest?.truncated === true
      || dagDigest?.truncated === true
      || (info.dagOversized !== true && dagCountPartial(info.dag, parsedDag)),
    taskOversized: info.taskOversized === true && taskDigest === undefined,
    dagOversized: info.dagOversized === true && dagDigest === undefined,
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

  return useMemo(
    () => infos.map((info) => summarizeLiveSession(info, clockMs, { sessionLive: true })),
    [infos, clockMs],
  );
}
