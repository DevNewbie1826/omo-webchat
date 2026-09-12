import { isRecord, optBoolean, optNumber, optString, optStringArray, reqString } from "../../lib/chatWsParseFields";
import { mapDrop, optSchemaVersion } from "./activityParseShared";
import type { CountAuthority } from "./taskAuthority";
import type { ActivityDagCounts, ActivityDagEdge, ActivityDagNode, ActivityDagRun, ActivityDagWave } from "./activityTypes";

export interface ParsedDagUpdated {
  readonly parentSessionId?: string;
  readonly truncatedRuns?: boolean;
  /** Exact deduplicated agent-work aggregate, identical to the task side's;
   * the sole count authority for sidebar, overview, and Subagents slots. */
  readonly agentRunningCount?: number;
  readonly agentTotalCount?: number;
  /** Exact run-membership scalars over the full pre-truncation membership;
   *  the sole count authority for the collapsed DAG tab. */
  readonly dagRunRunningCount?: number;
  readonly dagRunTotalCount?: number;
  readonly dagRunCountsUnavailable?: boolean;
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
  const taskIdTruncated = optBoolean(record, "task_id_truncated");
  const startedAt = optString(record, "started_at");
  const completedAt = optString(record, "completed_at");
  if (label === null || attempt === null || taskId === null || startedAt === null || completedAt === null) return null;
  if (taskIdTruncated === null || (taskIdTruncated === true && !taskId)) return null;
  return {
    id,
    prompt,
    dependsOn,
    state,
    ...(label !== undefined ? { label } : {}),
    ...(attempt !== undefined ? { attempt } : {}),
    ...(taskId !== undefined ? (taskIdTruncated === true ? { taskIdPrefix: taskId } : { taskId }) : {}),
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

// Ambiguous raw identities cannot contribute confirmed node state, even when
// one of the duplicate records would otherwise be dropped as malformed.
function duplicateIds(value: unknown, key: string): ReadonlySet<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  if (!Array.isArray(value)) return duplicates;
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = reqString(item, key);
    if (id === null) continue;
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return duplicates;
}

function parseDagRun(record: Record<string, unknown>, parentSessionId: string | undefined): ActivityDagRun | null {
  const runId = reqString(record, "run_id");
  const runKey = reqString(record, "run_key");
  const name = reqString(record, "name");
  const status = reqString(record, "status");
  if (runId === null || runKey === null || name === null || status === null) return null;
  const createdAt = optString(record, "created_at");
  // Invalid revision types are unknown freshness, not missing snapshot membership.
  const updatedAt = optString(record, "updated_at") ?? undefined;
  const counts = parseCounts(record["counts"]);
  const truncatedNodes = optBoolean(record, "truncated_nodes");
  const duplicateNodes = duplicateIds(record["nodes"], "id");
  const nodes = record["nodes"] === undefined ? [] : mapDrop(record["nodes"], parseDagNode)
    ?.filter(node => !duplicateNodes.has(node.id)) ?? null;
  const edges = record["edges"] === undefined ? [] : mapDrop(record["edges"], parseDagEdge);
  const waves = record["waves"] === undefined ? [] : mapDrop(record["waves"], parseDagWave);
  if (createdAt === null || counts === null || truncatedNodes === null || nodes === null || edges === null || waves === null) {
    return null;
  }
  // Keep loss on its own run so rejected stale rows cannot taint accepted
  // completeness. Counts may be original totals or recomputed prefixes.
  const truncated = truncatedNodes === true || record["nodes"] === undefined
    || counts.total > nodes.length || counts.running > nodes.filter(node => node.state === "running").length
    || ([["nodes", nodes], ["edges", edges], ["waves", waves]] as const).some(([key, retained]) => {
      const raw = record[key];
      return Array.isArray(raw) && retained.length < raw.length;
    });
  return {
    runId,
    runKey,
    name,
    status,
    counts,
    nodes,
    edges,
    waves,
    ...(truncated ? { truncated: true } : {}),
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
  const duplicateRuns = duplicateIds(data["runs"], "run_id");
  const runs = mapDrop(data["runs"], (item) => parseDagRun(item, parentSessionId))
    ?.map(run => duplicateRuns.has(run.runId)
      ? { ...run, nodes: [], edges: [], waves: [], truncated: true } : run) ?? null;
  if (runs === null) return null;
  // A discarded run is missing membership, not an authoritative empty list.
  const rawRuns = data["runs"];
  const lostRuns = duplicateRuns.size > 0 || (Array.isArray(rawRuns) && runs.length < rawRuns.length);
  const agentRunningCount = optCount(data["agent_running_count"]);
  const agentTotalCount = optCount(data["agent_total_count"]);
  const dagRunRunningCount = optCount(data["run_running_count"]);
  const dagRunTotalCount = optCount(data["run_total_count"]);
  return {
    runs,
    ...(parentSessionId !== undefined ? { parentSessionId } : {}),
    ...(agentRunningCount !== undefined ? { agentRunningCount } : {}),
    ...(agentTotalCount !== undefined ? { agentTotalCount } : {}),
    ...(dagRunRunningCount !== undefined ? { dagRunRunningCount } : {}),
    ...(dagRunTotalCount !== undefined ? { dagRunTotalCount } : {}),
    ...(typeof data["run_counts_unavailable"] === "boolean" ? { dagRunCountsUnavailable: data["run_counts_unavailable"] } : {}),
    ...(lostRuns ? { truncatedRuns: true } : truncatedRuns !== undefined ? { truncatedRuns } : {}),
  };
}

function optCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Count-only read of an omo.dag.updated payload. The node running sum stays
 * out: only the shared agent aggregate maps onto the authority fields. */
export function parseDagCounts(data: unknown): CountAuthority | null {
  if (!isRecord(data)) return null;
  const taskAgentRunningCount = optCount(data["agent_running_count"]);
  const taskAgentTotalCount = optCount(data["agent_total_count"]);
  const dagRunRunningCount = optCount(data["run_running_count"]);
  const dagRunTotalCount = optCount(data["run_total_count"]);
  return {
    ...(taskAgentRunningCount === undefined ? {} : { taskAgentRunningCount }),
    ...(taskAgentTotalCount === undefined ? {} : { taskAgentTotalCount }),
    ...(dagRunRunningCount === undefined ? {} : { dagRunRunningCount }),
    ...(dagRunTotalCount === undefined ? {} : { dagRunTotalCount }),
    ...(typeof data["run_counts_unavailable"] === "boolean" ? { dagRunCountsUnavailable: data["run_counts_unavailable"] } : {}),
  };
}

const RFC3339_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

function parseRfc3339DateTime(value: string): string | null {
  const match = RFC3339_DATE_TIME.exec(value);
  if (match === null) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = month === 2 ? (leapYear ? 29 : 28) : ([4, 6, 9, 11].includes(month) ? 30 : 31);
  if (
    month < 1 || month > 12 ||
    day < 1 || day > daysInMonth ||
    hour > 23 || minute > 59 || second > 59 ||
    (offsetHourText !== undefined && Number(offsetHourText) > 23) ||
    (offsetMinuteText !== undefined && Number(offsetMinuteText) > 59)
  ) {
    return null;
  }
  const epochMs = Date.parse(value);
  return Number.isNaN(epochMs) ? null : new Date(epochMs).toISOString();
}

/** Snapshot revisions use the same timezone-bearing millisecond contract as activity. */
export function parseDagUpdatedAt(value: string | undefined): number | undefined {
  const normalized = value === undefined ? null : parseRfc3339DateTime(value);
  return normalized === null ? undefined : Date.parse(normalized);
}

export function parseDagActivity(data: unknown): ParsedDagActivity | null {
  if (!isRecord(data)) return null;
  const runId = reqString(data, "runId");
  const nodeId = reqString(data, "nodeId");
  const rawAt = reqString(data, "at");
  if (runId === null || nodeId === null || rawAt === null) return null;
  const at = parseRfc3339DateTime(rawAt);
  if (at === null) return null;
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
