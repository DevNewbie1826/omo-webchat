import { isRecord, optString, reqBoolean, reqString } from "../../lib/chatWsParseFields";
import { mapDrop } from "../split/activityParseShared";

/** Compact in-memory task summary from GET /api/sessions/live `task_digest`. */
export type TaskDigestEntry = {
  readonly taskId: string;
  readonly status: string;
  readonly updatedAt?: string;
};

export type TaskDigest = {
  readonly tasks: readonly TaskDigestEntry[];
  readonly truncated: boolean;
};

/** Compact in-memory DAG summary from GET /api/sessions/live `dag_digest`. */
export type DagDigestRun = {
  readonly runId: string;
  readonly status: string;
  readonly runningTaskIds: readonly string[];
};

export type DagDigest = {
  readonly runs: readonly DagDigestRun[];
  readonly truncated: boolean;
};

function parseTaskDigestEntry(record: Record<string, unknown>): TaskDigestEntry | null {
  const taskId = reqString(record, "task_id");
  const status = reqString(record, "status");
  if (taskId === null || status === null || taskId.length === 0 || status.length === 0) return null;
  const updatedAt = optString(record, "updated_at");
  if (updatedAt === null) return null;
  return {
    taskId,
    status,
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  };
}

function parseRunningTaskIds(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
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

/** Parse `task_digest`; malformed shape yields null and never throws. */
export function parseTaskDigest(value: unknown): TaskDigest | null {
  if (!isRecord(value)) return null;
  const truncated = reqBoolean(value, "truncated");
  if (truncated === null) return null;
  const tasks = mapDrop(value["tasks"], parseTaskDigestEntry);
  if (tasks === null) return null;
  return { tasks, truncated };
}

/** Parse `dag_digest`; malformed shape yields null and never throws. */
export function parseDagDigest(value: unknown): DagDigest | null {
  if (!isRecord(value)) return null;
  const truncated = reqBoolean(value, "truncated");
  if (truncated === null) return null;
  const runs = mapDrop(value["runs"], parseDagDigestRun);
  if (runs === null) return null;
  return { runs, truncated };
}
