import { ApiError, apiJson } from "../../lib/api";
import { isRecord } from "../../lib/chatWsParseFields";
import type { Terminal } from "./workspace";

export type RpcSessionStatus = "blocked" | "working" | "done" | "idle" | "closed";

export interface RpcSessionInfo {
  readonly sessionId: string;
  readonly durableSessionId: string;
  readonly sessionPath: string;
  readonly cwd: string;
  readonly name: string;
  readonly status: RpcSessionStatus;
  readonly questions: readonly string[];
  readonly messageCount: number;
  readonly updatedAt: number;
  readonly closedAt?: number;
  readonly workspaceId: string;
  readonly chatId?: string;
}

const RPC_STATUSES: ReadonlySet<string> = new Set(["blocked", "working", "done", "idle", "closed"]);

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function parseRpcSession(value: unknown): RpcSessionInfo | null {
  if (!isRecord(value)) return null;
  const { sessionId, durableSessionId, sessionPath, cwd, status, workspaceId } = value;
  if (!nonEmptyString(sessionId) || !nonEmptyString(sessionPath)
    || !nonEmptyString(cwd) || !nonEmptyString(workspaceId)) return null;
  if (typeof durableSessionId !== "string") return null;
  if (typeof status !== "string" || !RPC_STATUSES.has(status)) return null;
  const name = value["name"];
  const rawQuestions = value["questions"];
  const closedAt = nonNegativeInt(value["closedAt"]);
  const chatId = value["chatId"];
  return {
    sessionId,
    durableSessionId,
    sessionPath,
    cwd,
    name: typeof name === "string" ? name : "",
    status: status as RpcSessionStatus,
    questions: Array.isArray(rawQuestions)
      ? rawQuestions.filter((question): question is string => typeof question === "string")
      : [],
    messageCount: nonNegativeInt(value["messageCount"]) ?? 0,
    updatedAt: nonNegativeInt(value["updatedAt"]) ?? 0,
    ...(closedAt === undefined ? {} : { closedAt }),
    workspaceId,
    ...(nonEmptyString(chatId) ? { chatId } : {}),
  };
}

export async function listRpcSessions(signal?: AbortSignal): Promise<readonly RpcSessionInfo[]> {
  const response = await apiJson<unknown>("/api/rpc-sessions", signal ? { signal } : {});
  if (!isRecord(response) || !Array.isArray(response["sessions"])) {
    throw new TypeError("Invalid RPC sessions response");
  }
  const sessions: RpcSessionInfo[] = [];
  for (const entry of response["sessions"]) {
    const parsed = parseRpcSession(entry);
    if (parsed !== null) sessions.push(parsed);
  }
  return sessions;
}

export async function openRpcSession(wsId: string, sessionId: string): Promise<Terminal> {
  const response = await apiJson<unknown>(
    `/api/workspaces/${encodeURIComponent(wsId)}/rpc-sessions/open`,
    { method: "POST", body: { sessionId } },
  );
  if (!isRecord(response) || !nonEmptyString(response["id"])
    || typeof response["name"] !== "string" || typeof response["provider"] !== "string") {
    throw new ApiError(200, "Invalid RPC session open response", response);
  }
  return { id: response["id"], name: response["name"], provider: response["provider"] as Terminal["provider"] };
}
