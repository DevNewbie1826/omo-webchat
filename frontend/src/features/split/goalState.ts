import { apiJson } from "../../lib/api";

/**
 * The projected live goal for one chat, exactly the REST /goal and chat.goal
 * wire shape: bounded objective text, live status (active, complete, blocked),
 * blocked reason when present, unix-second timestamps.
 */
export interface ChatGoal {
  readonly objective: string;
  readonly status: string;
  readonly blockedReason?: string;
  readonly objectiveTruncated?: boolean;
  readonly createdAt?: number;
  readonly updatedAt?: number;
  readonly completedAt?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseGoalState(value: unknown): ChatGoal | null {
  if (!isRecord(value)) return null;
  const objective = value["objective"];
  const status = value["status"];
  if (typeof objective !== "string" || typeof status !== "string") return null;
  const blockedReason = value["blockedReason"];
  const objectiveTruncated = value["objectiveTruncated"];
  const timestamps: Partial<Record<"createdAt" | "updatedAt" | "completedAt", number>> = {};
  for (const key of ["createdAt", "updatedAt", "completedAt"] as const) {
    const raw = value[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
    timestamps[key] = raw;
  }
  return {
    objective,
    status,
    ...(typeof blockedReason === "string" ? { blockedReason } : {}),
    ...(objectiveTruncated === true ? { objectiveTruncated: true } : {}),
    ...timestamps,
  };
}

/** Parse a /goal response body: { goal: ChatGoal | null }. */
export function parseChatGoalResponse(value: unknown): ChatGoal | null {
  if (!isRecord(value)) return null;
  return parseGoalState(value["goal"]);
}

/** Fetch the live goal state for a chat; null when no readable goal exists. */
export async function getChatGoal(
  wsId: string,
  chatId: string,
  signal?: AbortSignal,
): Promise<ChatGoal | null> {
  const value = await apiJson<unknown>(
    `/api/workspaces/${encodeURIComponent(wsId)}/chats/${encodeURIComponent(chatId)}/goal`,
    signal ? { signal } : {},
  );
  return parseChatGoalResponse(value);
}
