import { isRecord } from "../../lib/chatWsParseFields";
import { parseTodoDetails } from "./activityParse";
import type { TodoPhase } from "./activityTypes";

const TODO_STATE_CUSTOM_TYPE = "senpi.todo-state";

function todoDetailsOf(entry: unknown): unknown {
  if (!isRecord(entry)) return undefined;
  if (entry["type"] === "custom" && entry["customType"] === TODO_STATE_CUSTOM_TYPE) return entry["data"];
  if (entry["toolName"] === "todo") {
    const result = entry["result"];
    if (isRecord(result) && "details" in result) return result["details"];
    if ("details" in entry) return entry["details"];
  }
  const message = entry["message"];
  if (isRecord(message) && message["toolName"] === "todo") return message["details"];
  return undefined;
}

/**
 * Extract the last todo phases recorded in persisted history. Two entry
 * shapes carry them: `senpi.todo-state` custom entries (data holds the todo
 * details payload) and todo toolResult entries (details at the message or
 * bare-tool level). The last valid payload in document order wins. These
 * entries are activity-domain only; parseEntries never renders them as
 * transcript rows.
 */
export function extractTodoPhases(entries: unknown): readonly TodoPhase[] | null {
  if (!Array.isArray(entries)) return null;
  let phases: readonly TodoPhase[] | null = null;
  for (const entry of entries) {
    const parsed = parseTodoDetails(todoDetailsOf(entry));
    if (parsed !== null) phases = parsed.phases;
  }
  return phases;
}
