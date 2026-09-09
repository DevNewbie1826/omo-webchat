import { isRecord, mapRecords, optNumber, optString, optStringArray, reqString } from "../../lib/chatWsParseFields";
import type { ActivityDagCounts, ActivityDagEdge, ActivityDagNode, ActivityDagRun, ActivityDagWave } from "./activityTypes";

export const DAG_STATES = ["pending", "blocked", "scheduled", "running", "completed", "failed", "cancelled", "skipped"] as const;
export interface CompleteDag {
  readonly contentToken: string;
  readonly run: ActivityDagRun;
}
export interface DagCatalogEntry {
  readonly runId: string;
  readonly name: string;
  readonly contentToken: string;
}
export interface DagCatalogPage {
  readonly runs: readonly DagCatalogEntry[];
  readonly nextCursor: string | null;
}
export class CompleteDagError extends Error {
  constructor(readonly kind: "invalid" | "stale") {
    super(`DAG ${kind}`);
    this.name = "CompleteDagError";
  }
}

function nodeOf(record: Record<string, unknown>): ActivityDagNode | null {
  const id = reqString(record, "id");
  const prompt = reqString(record, "prompt");
  const state = reqString(record, "state");
  const dependsOn = optStringArray(record, "depends_on");
  const label = optString(record, "label");
  const taskId = optString(record, "task_id");
  const attempt = optNumber(record, "attempt");
  const startedAt = optString(record, "started_at");
  const completedAt = optString(record, "completed_at");
  if (id === null || id.length === 0 || prompt === null || state === null || !DAG_STATES.some(key => key === state)
    || dependsOn == null || label === null || taskId === null
    || attempt === null || (attempt !== undefined && (!Number.isSafeInteger(attempt) || attempt < 0))
    || startedAt === null || completedAt === null) return null;
  return { id, prompt, state, dependsOn,
    ...(label === undefined ? {} : { label }), ...(taskId === undefined ? {} : { taskId }),
    ...(attempt === undefined ? {} : { attempt }), ...(startedAt === undefined ? {} : { startedAt }),
    ...(completedAt === undefined ? {} : { completedAt }),
  };
}
function edgeOf(record: Record<string, unknown>): ActivityDagEdge | null {
  const from = reqString(record, "from"), to = reqString(record, "to");
  return from === null || to === null ? null : { from, to };
}
function waveOf(record: Record<string, unknown>): ActivityDagWave | null {
  const index = optNumber(record, "index"), nodeIds = optStringArray(record, "node_ids");
  return index == null || !Number.isSafeInteger(index) || index < 0 || nodeIds == null ? null : { index, nodeIds };
}
function countsOf(value: unknown, nodes: readonly ActivityDagNode[]): ActivityDagCounts | null {
  if (!isRecord(value)) return null;
  const counts = { total: nodes.length, pending: 0, blocked: 0, scheduled: 0, running: 0, completed: 0, failed: 0, cancelled: 0, skipped: 0 };
  for (const key of DAG_STATES) counts[key] = nodes.filter(node => node.state === key).length;
  for (const key of ["total", ...DAG_STATES] as const) if (value[key] !== counts[key]) return null;
  return counts;
}

export function parseCompleteDag(value: unknown): CompleteDag | null {
  if (!isRecord(value) || value["complete"] !== true || typeof value["content_token"] !== "string" || !value["content_token"]
    || !isRecord(value["run"])) return null;
  const record = value["run"];
  const runId = reqString(record, "run_id"), runKey = reqString(record, "run_key");
  const name = reqString(record, "name"), status = reqString(record, "status");
  const createdAt = optString(record, "created_at"), updatedAt = optString(record, "updated_at");
  // Strict mapRecords rejects every malformed member; legacy mapDrop cannot establish completeness.
  const nodes = mapRecords(record["nodes"], nodeOf), edges = mapRecords(record["edges"], edgeOf), waves = mapRecords(record["waves"], waveOf);
  if (runId === null || !runId || runKey === null || name === null || status === null || createdAt === null || updatedAt === null
    || nodes === null || edges === null || waves === null) return null;
  const counts = countsOf(record["counts"], nodes);
  const ids = new Set(nodes.map(node => node.id));
  if (counts === null || ids.size !== nodes.length || nodes.some(node => node.dependsOn.some(id => !ids.has(id)))) return null;
  const dependencies = nodes.flatMap(node => node.dependsOn.map(id => JSON.stringify([id, node.id]))).sort();
  const edgeKeys = edges.map(edge => JSON.stringify([edge.from, edge.to])).sort();
  if (dependencies.length !== edgeKeys.length || dependencies.some((key, index) => key !== edgeKeys[index])) return null;
  // Waves are layout hints, not topology authority; an empty/partial hint is valid.
  if (waves.some(wave => wave.nodeIds.some(id => !ids.has(id)))) return null;
  return { contentToken: value["content_token"], run: {
    runId, runKey, name, status, counts, nodes, edges, waves,
    ...(createdAt === undefined ? {} : { createdAt }), ...(updatedAt === undefined ? {} : { updatedAt }),
  } };
}

export function parseDagCatalog(value: unknown): DagCatalogPage | null {
  if (!isRecord(value)) return null;
  const nextCursor = value["next_cursor"];
  if (nextCursor !== null && (typeof nextCursor !== "string" || nextCursor.length === 0)) return null;
  const runs = mapRecords(value["runs"], record => {
    const runId = reqString(record, "run_id"), name = reqString(record, "name"), contentToken = reqString(record, "content_token");
    const runKey = reqString(record, "run_key"), status = reqString(record, "status"), total = optNumber(record, "total");
    if (!runId || name === null || !contentToken || runKey === null || status === null || total == null || !Number.isSafeInteger(total) || total < 0) return null;
    return { runId, name, contentToken };
  });
  if (runs === null || new Set(runs.map(run => run.runId)).size !== runs.length) return null;
  return { runs, nextCursor };
}
