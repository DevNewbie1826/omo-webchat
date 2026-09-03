import { apiJson } from "../../lib/api";

export interface ChatActivityHistory {
  readonly task: unknown;
  readonly dag: unknown;
  readonly taskOversized: boolean;
  readonly dagOversized: boolean;
}

export interface ChatActivityResponse {
  readonly history: ChatActivityHistory;
  readonly taskDigest?: unknown;
  readonly dagDigest?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseChatActivity(value: unknown): ChatActivityResponse {
  if (!isRecord(value)) throw new Error("Invalid activity history response.");
  const rawHistory = isRecord(value["history"]) ? value["history"] : value;
  return {
    history: {
      task: rawHistory["task"] ?? null,
      dag: rawHistory["dag"] ?? null,
      taskOversized: rawHistory["task_oversized"] === true,
      dagOversized: rawHistory["dag_oversized"] === true,
    },
    ...(value["task_digest"] === undefined ? {} : { taskDigest: value["task_digest"] }),
    ...(value["dag_digest"] === undefined ? {} : { dagDigest: value["dag_digest"] }),
  };
}

/** Fetch the one-shot historical activity projection for an attached chat. */
export async function getChatActivity(
  wsId: string,
  chatId: string,
  signal?: AbortSignal,
): Promise<ChatActivityResponse> {
  const value = await apiJson<unknown>(
    `/api/workspaces/${encodeURIComponent(wsId)}/chats/${encodeURIComponent(chatId)}/activity`,
    signal ? { signal } : {},
  );
  return parseChatActivity(value);
}
