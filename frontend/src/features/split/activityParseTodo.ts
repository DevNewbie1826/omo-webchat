import { isRecord, mapRecords, optString, reqString } from "../../lib/chatWsParseFields";
import type { TodoPhase, TodoTask } from "./activityTypes";

export interface ParsedTodoDetails {
  readonly op?: string;
  readonly storage?: string;
  readonly completedTasks?: readonly { readonly phase: string; readonly content: string }[];
  readonly phases: readonly TodoPhase[];
}

const TODO_STATUSES = new Set(["pending", "in_progress", "completed", "abandoned"]);

function isTodoStatus(value: string): value is TodoTask["status"] {
  return TODO_STATUSES.has(value);
}

export function parseTodoDetails(data: unknown): ParsedTodoDetails | null {
  if (!isRecord(data)) return null;
  const phases = mapRecords(data["phases"], (phase) => {
    const name = reqString(phase, "name");
    if (name === null) return null;
    const tasks = mapRecords(phase["tasks"], (task) => {
      const content = reqString(task, "content");
      const status = reqString(task, "status");
      return content === null || status === null || !isTodoStatus(status) ? null : { content, status };
    });
    return tasks === null ? null : { name, tasks };
  });
  if (phases === null) return null;
  const op = optString(data, "op");
  const storage = optString(data, "storage");
  // Transition metadata is optional; only phases determine snapshot validity.
  const completedTasks = mapRecords(data["completedTasks"], (task) => {
    const phase = reqString(task, "phase");
    const content = reqString(task, "content");
    return phase === null || content === null ? null : { phase, content };
  });
  return {
    phases,
    ...(op != null ? { op } : {}),
    ...(storage != null ? { storage } : {}),
    ...(completedTasks !== null ? { completedTasks } : {}),
  };
}
