import type { ChatServerFrame } from "./chatWs";
import type { QueueEngine, QueueEngineOrderedItem, QueueItem } from "./contract/types_gen";
import {
  isRecord,
  mapRecords,
  optBoolean,
  optNumber,
  optString,
  optStringArray,
  parseCommandEntry,
  parseContextUsage,
  parseModelEntry,
  reqBoolean,
  reqNumber,
  reqString,
  sanitizeJson,
} from "./chatWsParseFields";

type SessionFrameType = "state" | "stats" | "extensionEvent" | "sessions.activity" | "approval" | "commands" | "models" | "entries" | "chat.goal" | "queue";

function parseQueueItem(record: Record<string, unknown>): QueueItem | null {
  const id = reqString(record, "id");
  const text = reqString(record, "text");
  const hasImage = reqBoolean(record, "hasImage");
  const createdAt = reqNumber(record, "createdAt");
  const requestId = optString(record, "requestId");
  if (id === null || text === null || hasImage === null || createdAt === null || requestId === null) return null;
  return {
    id,
    text,
    hasImage,
    createdAt,
    ...(requestId !== undefined ? { requestId } : {}),
  };
}

function parseQueueEngine(value: unknown): QueueEngine | null {
  if (!isRecord(value)) return null;
  const pendingMessageCount = reqNumber(value, "pendingMessageCount");
  const ordered = mapRecords(value["ordered"], (record): QueueEngineOrderedItem | null => {
    const text = reqString(record, "text");
    const mode = record["mode"];
    if (text === null) return null;
    return mode === "followUp" || mode === "steer" ? { text, mode } : null;
  });
  if (pendingMessageCount === null || ordered === null) return null;
  return { pendingMessageCount, ordered };
}

function parseLeanCounts(
  value: unknown,
): { readonly agents?: number; readonly tasks?: number; readonly dag?: number } | null | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const agents = optLeanInteger(value, "agents");
  const tasks = optLeanInteger(value, "tasks");
  const dag = optLeanInteger(value, "dag");
  if (agents === null || tasks === null || dag === null) return null;
  return {
    ...(agents !== undefined ? { agents } : {}),
    ...(tasks !== undefined ? { tasks } : {}),
    ...(dag !== undefined ? { dag } : {}),
  };
}

function parseLeanTruncation(
  value: unknown,
): { readonly task?: boolean; readonly dag?: boolean } | null | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const task = optBoolean(value, "task");
  const dag = optBoolean(value, "dag");
  if (task === null || dag === null) return null;
  return {
    ...(task !== undefined ? { task } : {}),
    ...(dag !== undefined ? { dag } : {}),
  };
}

function optLeanInteger(msg: Record<string, unknown>, key: string): number | null | undefined {
  const value = optNumber(msg, key);
  if (value === null || value === undefined) return value;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Session-surface frames, built field-by-field into the generated contract
 * members. entries now enforces the v2 wire contract: `entries` must be an
 * array and `final` is REQUIRED on every page (invariant 18) — the seam keeps
 * `final` optional only because features deliver typed literals directly.
 */
export function parseSessionFrame(
  type: SessionFrameType,
  msg: Record<string, unknown>,
  sessionId: string | null,
): ChatServerFrame | null {
  switch (type) {
    case "state": {
      if (sessionId === null) return null;
      const isStreaming = reqBoolean(msg, "isStreaming");
      const isCompacting = reqBoolean(msg, "isCompacting");
      if (isStreaming === null || isCompacting === null) return null;
      const thinkingLevel = optString(msg, "thinkingLevel");
      const sessionName = optString(msg, "sessionName");
      if (thinkingLevel === null || sessionName === null) return null;
      const rawModel = msg["model"];
      let model: { readonly provider: string; readonly modelId: string } | null | undefined;
      if (rawModel === undefined) model = undefined;
      else if (rawModel === null) model = null;
      else if (isRecord(rawModel)) {
        const provider = reqString(rawModel, "provider");
        const modelId = reqString(rawModel, "modelId");
        if (provider === null || modelId === null) return null;
        model = { provider, modelId };
      } else return null;
      return {
        type: "state",
        sessionId,
        isStreaming,
        isCompacting,
        ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(sessionName !== undefined ? { sessionName } : {}),
      };
    }
    case "stats": {
      if (sessionId === null) return null;
      const cost = optNumber(msg, "cost");
      const contextUsage = parseContextUsage(msg["contextUsage"]);
      const tokens = msg["tokens"] as import("./contract/types_gen").TokenUsage | undefined;
      if (cost === null || contextUsage === null) return null;
      if (cost === undefined && contextUsage === undefined && tokens === undefined) return null;
      return {
        type: "stats",
        sessionId,
        ...(cost !== undefined ? { cost } : {}),
        ...(contextUsage !== undefined ? { contextUsage } : {}),
        ...(tokens !== undefined ? { tokens } : {}),
      };
    }
    case "extensionEvent": {
      if (sessionId === null) return null;
      const name = reqString(msg, "name");
      const data = msg["data"];
      if (name === null || name.length === 0) return null;
      return { type: "extensionEvent", sessionId, name, ...(data !== undefined ? { data: sanitizeJson(data) } : {}) };
    }
    case "sessions.activity": {
      if (sessionId === null) return null;
      const overflow = reqBoolean(msg, "overflow");
      if (overflow === null) return null;
      const durableSessionId = reqString(msg, "durableSessionId");
      const replacesSessionId = optString(msg, "replacesSessionId");
      if (durableSessionId === null || replacesSessionId === null) return null;
      const id = optString(msg, "id");
      const title = optString(msg, "title");
      const lastLine = optString(msg, "last_line");
      const lastActivityMs = optLeanInteger(msg, "last_activity_ms");
      const done = optLeanInteger(msg, "done");
      const dagDone = optLeanInteger(msg, "dag_done");
      const dagTotal = optLeanInteger(msg, "dag_total");
      const running = parseLeanCounts(msg["running"]);
      const truncated = parseLeanTruncation(msg["truncated"]);
      if (
        id === null ||
        title === null ||
        lastLine === null ||
        lastActivityMs === null ||
        done === null ||
        dagDone === null ||
        dagTotal === null ||
        running === null ||
        truncated === null
      ) {
        return null;
      }
      return {
        type: "sessions.activity",
        sessionId,
        durableSessionId,
        ...(replacesSessionId === undefined ? {} : { replacesSessionId }),
        ...(id === undefined ? {} : { id }),
        ...(title === undefined ? {} : { title }),
        ...(typeof msg["active"] === "boolean" ? { active: msg["active"] } : {}),
        overflow,
        ...(running === undefined ? {} : { running }),
        ...(truncated === undefined ? {} : { truncated }),
        ...(done === undefined ? {} : { done }),
        ...(dagDone === undefined ? {} : { dag_done: dagDone }),
        ...(dagTotal === undefined ? {} : { dag_total: dagTotal }),
        ...(lastActivityMs === undefined ? {} : { last_activity_ms: lastActivityMs }),
        ...(lastLine === undefined ? {} : { last_line: lastLine }),
      };
    }
    case "approval": {
      if (sessionId === null) return null;
      const id = reqString(msg, "id");
      const method = msg["method"];
      if (id === null) return null;
      if (method !== "select" && method !== "confirm" && method !== "input" && method !== "editor") return null;
      const title = optString(msg, "title");
      const message = optString(msg, "message");
      const options = optStringArray(msg, "options");
      const prefill = optString(msg, "prefill");
      const placeholder = optString(msg, "placeholder");
      if (title === null || message === null || options === null || prefill === null || placeholder === null) return null;
      return {
        type: "approval",
        sessionId,
        id,
        method,
        ...(title !== undefined ? { title } : {}),
        ...(message !== undefined ? { message } : {}),
        ...(options !== undefined ? { options } : {}),
        ...(prefill !== undefined ? { prefill } : {}),
        ...(placeholder !== undefined ? { placeholder } : {}),
      };
    }
    case "commands": {
      if (sessionId === null) return null;
      const commands = mapRecords(msg["commands"], parseCommandEntry);
      if (commands === null) return null;
      return { type: "commands", sessionId, commands };
    }
    case "models": {
      if (sessionId === null) return null;
      const models = mapRecords(msg["models"], parseModelEntry);
      if (models === null) return null;
      return { type: "models", sessionId, models };
    }
    case "chat.goal": {
      if (sessionId === null) return null;
      const rawGoal = msg["goal"];
      let goal: import("./contract/types_gen").ChatGoalState | null;
      if (rawGoal === null || rawGoal === undefined) {
        goal = null;
      } else if (isRecord(rawGoal)) {
        const objective = reqString(rawGoal, "objective");
        const status = reqString(rawGoal, "status");
        const blockedReason = optString(rawGoal, "blockedReason");
        const objectiveTruncated = optBoolean(rawGoal, "objectiveTruncated");
        const createdAt = optNumber(rawGoal, "createdAt");
        const updatedAt = optNumber(rawGoal, "updatedAt");
        const completedAt = optNumber(rawGoal, "completedAt");
        if (objective === null || status === null || blockedReason === null || objectiveTruncated === null
          || createdAt === null || updatedAt === null || completedAt === null) return null;
        goal = {
          objective,
          status,
          ...(blockedReason !== undefined ? { blockedReason } : {}),
          ...(objectiveTruncated !== undefined ? { objectiveTruncated } : {}),
          ...(createdAt !== undefined ? { createdAt } : {}),
          ...(updatedAt !== undefined ? { updatedAt } : {}),
          ...(completedAt !== undefined ? { completedAt } : {}),
        };
      } else return null;
      return { type: "chat.goal", sessionId, goal };
    }
    case "queue": {
      if (sessionId === null) return null;
      const revision = reqNumber(msg, "revision");
      const items = mapRecords(msg["items"], parseQueueItem);
      const engine = parseQueueEngine(msg["engine"]);
      if (revision === null || items === null || engine === null) return null;
      return { type: "queue", sessionId, revision, items, engine };
    }
    case "entries": {
      if (sessionId === null) return null;
      const rawEntries = msg["entries"];
      if (!Array.isArray(rawEntries)) return null;
      const entries = rawEntries.map((item) => sanitizeJson(item));
      const leafId = optString(msg, "leafId");
      if (leafId === null) return null;
      // final is REQUIRED on every entries page (invariant 18); a frame
      // without it is malformed wire data, not a terminal page.
      const final = reqBoolean(msg, "final");
      if (final === null) return null;
      return { type: "entries", sessionId, entries, ...(leafId !== undefined ? { leafId } : {}), final };
    }
  }
}
