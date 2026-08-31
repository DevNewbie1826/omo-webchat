import { isRecord, optNumber, optString, reqString } from "../../lib/chatWsParseFields";
import { mapDrop } from "./activityParseShared";
import type { TodoPhase, TodoTask } from "./activityTypes";

export interface ParsedTodoDetails {
  readonly op?: string;
  readonly storage?: string;
  readonly completedTasks?: number;
  readonly phases: readonly TodoPhase[];
}

const TODO_STATUSES = new Set(["pending", "in_progress", "completed", "abandoned"]);

function isTodoStatus(value: string): value is TodoTask["status"] {
  return TODO_STATUSES.has(value);
}

export function parseTodoDetails(data: unknown): ParsedTodoDetails | null {
  if (!isRecord(data)) return null;
  const phases = mapDrop(data["phases"], (phase) => {
    const name = reqString(phase, "name");
    if (name === null) return null;
    const tasks = mapDrop(phase["tasks"], (task) => {
      const content = reqString(task, "content");
      const status = reqString(task, "status");
      return content === null || status === null || !isTodoStatus(status) ? null : { content, status };
    });
    return tasks === null ? null : { name, tasks };
  });
  if (phases === null) return null;
  const op = optString(data, "op");
  const storage = optString(data, "storage");
  const completedTasks = optNumber(data, "completedTasks");
  if (op === null || storage === null || completedTasks === null) return null;
  return {
    phases,
    ...(op !== undefined ? { op } : {}),
    ...(storage !== undefined ? { storage } : {}),
    ...(completedTasks !== undefined ? { completedTasks } : {}),
  };
}
