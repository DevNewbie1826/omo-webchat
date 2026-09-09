import { isRecord, optBoolean, optNumber, optString, reqString } from "../../lib/chatWsParseFields";
import { taskRawStatus } from "./taskAuthority";
import { mapDrop } from "./activityParseShared";
import type { ActivityLiveProgress, ActivityTask } from "./activityTypes";

export interface ParsedTaskUpdated {
  readonly parentSessionId?: string;
  readonly truncatedTasks?: boolean;
  /** Server pre-truncation scalars, authoritative over the retained rows. */
  readonly taskRunningCount?: number;
  readonly taskTotalCount?: number;
  readonly tasks: readonly ActivityTask[];
}

function optCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function optStringOrNumber(record: Record<string, unknown>, key: string): string | number | null | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function parseLiveProgress(value: unknown): ActivityLiveProgress | null | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const activity = optString(value, "activity");
  const startedAt = optStringOrNumber(value, "started_at");
  const currentTool = optString(value, "current_tool");
  const lastAssistantLine = optString(value, "last_assistant_line");
  const turns = optNumber(value, "turns");
  const toolCalls = optNumber(value, "tool_calls");
  const totalTokens = optNumber(value, "total_tokens");
  const tokensPerSecond = optNumber(value, "tokens_per_second");
  if (
    activity === null ||
    startedAt === null ||
    currentTool === null ||
    lastAssistantLine === null ||
    turns === null ||
    toolCalls === null ||
    totalTokens === null ||
    tokensPerSecond === null
  ) {
    return null;
  }
  return {
    ...(activity !== undefined ? { activity } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(currentTool !== undefined ? { currentTool } : {}),
    ...(lastAssistantLine !== undefined ? { lastAssistantLine } : {}),
    ...(turns !== undefined ? { turns } : {}),
    ...(toolCalls !== undefined ? { toolCalls } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(tokensPerSecond !== undefined ? { tokensPerSecond } : {}),
  };
}

function parseTask(record: Record<string, unknown>, parentSessionId: string | undefined, partial: boolean): ActivityTask | null {
  const taskId = reqString(record, "task_id");
  const name = reqString(record, "name");
  const status = reqString(record, "status");
  if (taskId === null || status === null) return null;
  const rawStatus = taskRawStatus(status, record["raw_status"]);
  // Webchat may publish a digest-only DAG correction beside a rich prefix.
  // Only this exact partial/provenance shape can omit name; malformed raw rows
  // still fail, and compact authority remains eligible for rich enrichment.
  const compact = partial && record["name"] === undefined && taskId !== "" && rawStatus !== undefined
    && optString(record, "updated_at") !== null
    && Object.keys(record).every(key => ["task_id", "status", "raw_status", "updated_at"].includes(key));
  if (name === null && !compact) return null;
  const taskSummary = optString(record, "task_summary");
  const agentType = optString(record, "agent_type");
  const category = optString(record, "category");
  const model = optString(record, "model");
  const createdAt = optString(record, "created_at");
  const updatedAt = optString(record, "updated_at") ?? undefined;
  const finalResponse = optString(record, "final_response");
  const errorMessage = optString(record, "error_message");
  const liveProgress = parseLiveProgress(record["live_progress"]);
  if (
    taskSummary === null ||
    agentType === null ||
    category === null ||
    model === null ||
    createdAt === null ||
    finalResponse === null ||
    errorMessage === null
  ) {
    return null;
  }
  return {
    taskId,
    name: name ?? taskId,
    status,
    ...(compact ? { compact: true } : {}),
    ...(rawStatus === undefined ? {} : { rawStatus }),
    ...(parentSessionId !== undefined ? { parentSessionId } : {}),
    ...(taskSummary !== undefined ? { taskSummary } : {}),
    ...(agentType !== undefined ? { agentType } : {}),
    ...(category !== undefined ? { category } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(finalResponse !== undefined ? { finalResponse } : {}),
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    ...(liveProgress != null ? { liveProgress } : {}),
  };
}

export function parseTaskUpdated(data: unknown): ParsedTaskUpdated | null {
  if (!isRecord(data)) return null;
  const parentSessionId = optString(data, "parent_session_id");
  const truncatedTasks = optBoolean(data, "truncated_tasks");
  if (parentSessionId === null || truncatedTasks === null) return null;
  const tasks = mapDrop(data["tasks"], (item) => parseTask(item, parentSessionId, truncatedTasks === true));
  if (tasks === null) return null;
  const taskRunningCount = optCount(data["running_count"]);
  const taskTotalCount = optCount(data["total_count"]);
  return {
    tasks,
    ...(parentSessionId !== undefined ? { parentSessionId } : {}),
    ...(taskRunningCount !== undefined ? { taskRunningCount } : {}),
    ...(taskTotalCount !== undefined ? { taskTotalCount } : {}),
    ...(truncatedTasks !== undefined || tasks.length !== (data["tasks"] as unknown[]).length
      ? { truncatedTasks: truncatedTasks === true || tasks.length !== (data["tasks"] as unknown[]).length } : {}),
  };
}
