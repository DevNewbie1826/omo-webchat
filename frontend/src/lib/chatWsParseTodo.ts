import type { ChatTodoFrame, TodoPhase, TodoTask } from "./contract/types_gen";
import { isRecord, mapRecords, reqNumber, reqString } from "./chatWsParseFields";

function parsePhase(record: Record<string, unknown>): TodoPhase | null {
  const name = reqString(record, "name");
  const tasks = mapRecords(record["tasks"], (task): TodoTask | null => {
    const content = reqString(task, "content");
    const status = task["status"];
    if (content === null || (status !== "pending" && status !== "in_progress" && status !== "completed" && status !== "abandoned")) return null;
    return { content, status };
  });
  return name === null || tasks === null ? null : { name, tasks };
}

// Called only after generated structural and field-combination validation.
// Rebuild the UI-owned payload so unknown wire properties do not leak inward.
export function parseTodoFrame(msg: Record<string, unknown>): ChatTodoFrame | null {
  const sessionId = reqString(msg, "sessionId");
  const durableSessionId = reqString(msg, "durableSessionId");
  const bindingId = reqString(msg, "bindingId");
  const requestGeneration = reqNumber(msg, "requestGeneration");
  if (sessionId === null || durableSessionId === null || bindingId === null || requestGeneration === null) return null;
  const base = { type: "chat.todo", sessionId, durableSessionId, bindingId, requestGeneration } as const;
  if (msg["status"] === "unavailable") {
    const error = msg["error"];
    if (error !== "history-unavailable" && error !== "invalid-state" && error !== "oversized") return null;
    return { ...base, status: "unavailable", error };
  }
  const source = msg["source"];
  if (!isRecord(source)) return null;
  const leafId = source["leafId"];
  const entryId = source["entryId"];
  const entryIndex = source["entryIndex"];
  const kind = source["kind"];
  if ((leafId !== null && typeof leafId !== "string") || (entryId !== null && typeof entryId !== "string")
    || (entryIndex !== null && typeof entryIndex !== "number") || (kind !== "absent" && kind !== "custom" && kind !== "legacy-tool")) return null;
  const phases = msg["phases"] === null ? null : mapRecords(msg["phases"], parsePhase);
  if (msg["phases"] !== null && phases === null) return null;
  return { ...base, status: "ready", source: { leafId, entryId, entryIndex, kind }, phases };
}
