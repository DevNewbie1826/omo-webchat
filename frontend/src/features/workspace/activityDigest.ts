import { isRecord, optString, reqBoolean, reqString } from "../../lib/chatWsParseFields";

import { taskRawStatus } from "../split/taskAuthority";

/** A nonnegative safe integer, or undefined when absent or malformed. */
function optCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Compact in-memory task summary from GET /api/sessions/live `task_digest`.
 * `running_count`/`total_count` are the server's pre-truncation scalars and
 * are authoritative over the retained `tasks` rows; the agent pair is the
 * exact deduplicated aggregate and the sole count authority for the UI. */
export type TaskDigestEntry = {
  readonly taskId: string;
  readonly status: string;
  readonly updatedAt?: string;
  readonly rawStatus?: string;
};

export type TaskDigest = {
  readonly tasks: readonly TaskDigestEntry[];
  readonly truncated: boolean;
  readonly receivedAt?: string;
  readonly taskRunningCount?: number;
  readonly taskTotalCount?: number;
  readonly taskAgentRunningCount?: number;
  readonly taskAgentTotalCount?: number;
};

/** Compact in-memory DAG summary from GET /api/sessions/live `dag_digest`.
 * `running_count` is the server's node-based pre-truncation running sum over
 * all runs, before any task-roster overlap removal; the agent pair carries the
 * same exact deduplicated aggregate as the task digest. */
export type DagDigestRun = {
  readonly runId: string;
  readonly status: string;
  readonly runningTaskIds: readonly string[];
};

export type DagDigest = {
  readonly runs: readonly DagDigestRun[];
  readonly truncated: boolean;
  readonly receivedAt?: string;
  readonly dagRunningCount?: number;
  readonly agentRunningCount?: number;
  readonly agentTotalCount?: number;
  /** Exact DAG-run membership scalars over the full pre-truncation
   *  membership; the sole count authority for the collapsed DAG tab. */
  readonly dagRunRunningCount?: number;
  readonly dagRunTotalCount?: number;
};

function parseTaskDigestEntry(record: Record<string, unknown>): TaskDigestEntry | null {
  const taskId = reqString(record, "task_id");
  const status = reqString(record, "status");
  if (taskId === null || status === null || taskId.length === 0 || status.length === 0) return null;
  const updatedAt = optString(record, "updated_at") ?? undefined;
  const rawStatus = taskRawStatus(status, record["raw_status"]);
  return {
    taskId,
    status,
    ...(rawStatus === undefined ? {} : { rawStatus }),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  };
}

function parseRunningTaskIds(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) return null;
    ids.push(item);
  }
  return ids;
}

function parseDagDigestRun(record: Record<string, unknown>): DagDigestRun | null {
  const runId = reqString(record, "run_id");
  const status = reqString(record, "status");
  if (runId === null || status === null || runId.length === 0 || status.length === 0) return null;
  const runningTaskIds = parseRunningTaskIds(record["running_task_ids"]);
  if (runningTaskIds === null) return null;
  return { runId, status, runningTaskIds };
}

function mapStrict<T>(value: unknown, mapItem: (item: Record<string, unknown>) => T | null): readonly T[] | null {
  if (!Array.isArray(value)) return null;
  const out: T[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const mapped = mapItem(item);
    if (mapped === null) return null;
    out.push(mapped);
  }
  return out;
}

/** Parse `task_digest`; malformed shape yields null and never throws. */
export function parseTaskDigest(value: unknown): TaskDigest | null {
  if (!isRecord(value)) return null;
  const truncated = reqBoolean(value, "truncated");
  if (truncated === null) return null;
  const tasks = mapStrict(value["tasks"], parseTaskDigestEntry);
  if (tasks === null) return null;
  const receivedAt = optString(value, "received_at");
  const taskRunningCount = optCount(value["running_count"]);
  const taskTotalCount = optCount(value["total_count"]);
  const taskAgentRunningCount = optCount(value["agent_running_count"]);
  const taskAgentTotalCount = optCount(value["agent_total_count"]);
  return {
    tasks,
    truncated,
    ...(typeof receivedAt === "string" ? { receivedAt } : {}),
    ...(taskRunningCount === undefined ? {} : { taskRunningCount }),
    ...(taskTotalCount === undefined ? {} : { taskTotalCount }),
    ...(taskAgentRunningCount === undefined ? {} : { taskAgentRunningCount }),
    ...(taskAgentTotalCount === undefined ? {} : { taskAgentTotalCount }),
  };
}

/** Parse `dag_digest`; malformed shape yields null and never throws. */
export function parseDagDigest(value: unknown): DagDigest | null {
  if (!isRecord(value)) return null;
  const truncated = reqBoolean(value, "truncated");
  if (truncated === null) return null;
  const runs = mapStrict(value["runs"], parseDagDigestRun);
  if (runs === null) return null;
  const receivedAt = optString(value, "received_at");
  const dagRunningCount = optCount(value["running_count"]);
  const agentRunningCount = optCount(value["agent_running_count"]);
  const agentTotalCount = optCount(value["agent_total_count"]);
  const dagRunRunningCount = optCount(value["run_running_count"]);
  const dagRunTotalCount = optCount(value["run_total_count"]);
  return {
    runs,
    truncated,
    ...(typeof receivedAt === "string" ? { receivedAt } : {}),
    ...(dagRunningCount === undefined ? {} : { dagRunningCount }),
    ...(agentRunningCount === undefined ? {} : { agentRunningCount }),
    ...(agentTotalCount === undefined ? {} : { agentTotalCount }),
    ...(dagRunRunningCount === undefined ? {} : { dagRunRunningCount }),
    ...(dagRunTotalCount === undefined ? {} : { dagRunTotalCount }),
  };
}
