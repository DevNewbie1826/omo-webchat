import { isRecord, optBoolean, optNumber, optString, optStringArray, reqString } from "../../lib/chatWsParseFields";
import { mapDrop, optSchemaVersion } from "./activityParseShared";
import type { ActivityDagCounts, ActivityDagEdge, ActivityDagNode, ActivityDagRun, ActivityDagWave } from "./activityTypes";

export interface ParsedDagUpdated {
  readonly parentSessionId?: string;
  readonly truncatedRuns?: boolean;
  readonly runs: readonly ActivityDagRun[];
}

export interface ParsedDagActivity {
  readonly schemaVersion?: number | string;
  readonly runId: string;
  readonly nodeId: string;
  readonly taskId?: string;
  readonly at: string;
  readonly activity?: string;
  readonly currentTool?: string;
  readonly lastAssistantLine?: string;
  readonly turns?: number;
  readonly toolCalls?: number;
}

export interface ParsedHeartbeatRun {
  readonly runId: string;
  readonly headSeq: number;
}

export interface ParsedDagHeartbeat {
  readonly schemaVersion?: number | string;
  readonly at: string;
  readonly runs: readonly ParsedHeartbeatRun[];
}

const COUNT_KEYS = [
  "total",
  "pending",
  "blocked",
  "scheduled",
  "running",
  "completed",
  "failed",
  "cancelled",
  "skipped",
] as const;

function parseCounts(value: unknown): ActivityDagCounts | null {
  if (value === undefined) {
    return { total: 0, pending: 0, blocked: 0, scheduled: 0, running: 0, completed: 0, failed: 0, cancelled: 0, skipped: 0 };
  }
  if (!isRecord(value)) return null;
  const counts = { total: 0, pending: 0, blocked: 0, scheduled: 0, running: 0, completed: 0, failed: 0, cancelled: 0, skipped: 0 };
  for (const key of COUNT_KEYS) {
    const field = value[key];
    if (field === undefined) continue;
    if (typeof field !== "number") return null;
    counts[key] = field;
  }
  return counts;
}

function parseDagNode(record: Record<string, unknown>): ActivityDagNode | null {
  const id = reqString(record, "id");
  const prompt = reqString(record, "prompt");
  const state = reqString(record, "state");
  const dependsOn = optStringArray(record, "depends_on");
  if (id === null || prompt === null || state === null || dependsOn === undefined || dependsOn === null) return null;
  const label = optString(record, "label");
  const attempt = optNumber(record, "attempt");
  const taskId = optString(record, "task_id");
  const startedAt = optString(record, "started_at");
  const completedAt = optString(record, "completed_at");
  if (label === null || attempt === null || taskId === null || startedAt === null || completedAt === null) return null;
  return {
    id,
    prompt,
    dependsOn,
    state,
    ...(label !== undefined ? { label } : {}),
    ...(attempt !== undefined ? { attempt } : {}),
    ...(taskId !== undefined ? { taskId } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(completedAt !== undefined ? { completedAt } : {}),
  };
}

function parseDagEdge(record: Record<string, unknown>): ActivityDagEdge | null {
  const from = reqString(record, "from");
  const to = reqString(record, "to");
  return from === null || to === null ? null : { from, to };
}

function parseDagWave(record: Record<string, unknown>): ActivityDagWave | null {
  const index = optNumber(record, "index");
  const nodeIds = optStringArray(record, "node_ids");
  if (index === undefined || index === null || nodeIds === undefined || nodeIds === null) return null;
  return { index, nodeIds };
}

function parseDagRun(record: Record<string, unknown>, parentSessionId: string | undefined): ActivityDagRun | null {
  const runId = reqString(record, "run_id");
  const runKey = reqString(record, "run_key");
  const name = reqString(record, "name");
  const status = reqString(record, "status");
  if (runId === null || runKey === null || name === null || status === null) return null;
  const createdAt = optString(record, "created_at");
  const updatedAt = optString(record, "updated_at");
  const counts = parseCounts(record["counts"]);
  const nodes = record["nodes"] === undefined ? [] : mapDrop(record["nodes"], parseDagNode);
  const edges = record["edges"] === undefined ? [] : mapDrop(record["edges"], parseDagEdge);
  const waves = record["waves"] === undefined ? [] : mapDrop(record["waves"], parseDagWave);
  if (createdAt === null || updatedAt === null || counts === null || nodes === null || edges === null || waves === null) {
    return null;
  }
  return {
    runId,
    runKey,
    name,
    status,
    counts,
    nodes,
    edges,
    waves,
    ...(parentSessionId !== undefined ? { parentSessionId } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  };
}

export function parseDagUpdated(data: unknown): ParsedDagUpdated | null {
  if (!isRecord(data)) return null;
  const parentSessionId = optString(data, "parent_session_id");
  const truncatedRuns = optBoolean(data, "truncated_runs");
  if (parentSessionId === null || truncatedRuns === null) return null;
  const runs = mapDrop(data["runs"], (item) => parseDagRun(item, parentSessionId));
  if (runs === null) return null;
  return {
    runs,
    ...(parentSessionId !== undefined ? { parentSessionId } : {}),
    ...(truncatedRuns !== undefined ? { truncatedRuns } : {}),
  };
}

export function parseDagActivity(data: unknown): ParsedDagActivity | null {
  if (!isRecord(data)) return null;
  const runId = reqString(data, "runId");
  const nodeId = reqString(data, "nodeId");
  const at = reqString(data, "at");
  if (runId === null || nodeId === null || at === null) return null;
  const schemaVersion = optSchemaVersion(data);
  const taskId = optString(data, "taskId");
  const activity = optString(data, "activity");
  const currentTool = optString(data, "currentTool");
  const lastAssistantLine = optString(data, "lastAssistantLine");
  const turns = optNumber(data, "turns");
  const toolCalls = optNumber(data, "toolCalls");
  if (
    schemaVersion === null ||
    taskId === null ||
    activity === null ||
    currentTool === null ||
    lastAssistantLine === null ||
    turns === null ||
    toolCalls === null
  ) {
    return null;
  }
  return {
    runId,
    nodeId,
    at,
    ...(schemaVersion !== undefined ? { schemaVersion } : {}),
    ...(taskId !== undefined ? { taskId } : {}),
    ...(activity !== undefined ? { activity } : {}),
    ...(currentTool !== undefined ? { currentTool } : {}),
    ...(lastAssistantLine !== undefined ? { lastAssistantLine } : {}),
    ...(turns !== undefined ? { turns } : {}),
    ...(toolCalls !== undefined ? { toolCalls } : {}),
  };
}

export function parseDagHeartbeat(data: unknown): ParsedDagHeartbeat | null {
  if (!isRecord(data)) return null;
  const at = reqString(data, "at");
  if (at === null) return null;
  const schemaVersion = optSchemaVersion(data);
  if (schemaVersion === null) return null;
  const runs = mapDrop(data["runs"], (record) => {
    const runId = reqString(record, "runId");
    const headSeq = optNumber(record, "headSeq");
    return runId === null || headSeq === undefined || headSeq === null ? null : { runId, headSeq };
  });
  if (runs === null) return null;
  return { at, runs, ...(schemaVersion !== undefined ? { schemaVersion } : {}) };
}
