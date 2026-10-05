import { ApiError, apiJson, qs } from "../../lib/api";
import { isRecord } from "../../lib/chatWsParseFields";
import type { Translate } from "../../i18n";
import type { Terminal } from "./workspace";

/** Watcher-observed state of a daemon session. The status vocabulary mirrors
 * omosense semantics: blocked (pending questions), working (streaming or
 * compacting), or idle; done rows may appear for one observation. */
export type RpcLiveStatus = "blocked" | "working" | "idle" | "done";

export interface RpcLiveState {
  readonly status: RpcLiveStatus;
  readonly questions: readonly string[];
}

/** One unbound watcher row of a workspace's always-complete live section. */
export interface RpcLiveSession extends RpcLiveState {
  readonly sessionId: string;
  readonly durableSessionId: string;
  readonly sessionPath: string;
  readonly cwd: string;
  readonly name: string;
  readonly updatedAt: number;
  readonly messageCount: number;
}

/** A stored chat's known binding to a session source identity, mirroring the
 * in-place fold's durable id -> { chat id, source path } map. */
export interface RpcLiveBinding {
  readonly chatId: string;
  readonly path: string;
}

const RPC_LIVE_STATUSES: ReadonlySet<string> = new Set(["blocked", "working", "idle", "done"]);

export function parseRpcLiveState(value: unknown): RpcLiveState | undefined {
  if (!isRecord(value)) return undefined;
  const status = value["status"];
  const questions = value["questions"];
  if (typeof status !== "string" || !RPC_LIVE_STATUSES.has(status) || !Array.isArray(questions)) return undefined;
  return {
    status: status as RpcLiveStatus,
    questions: questions.filter((q): q is string => typeof q === "string"),
  };
}

/** Validate one watcher row, dropping malformed items at the transport edge. */
export function parseRpcLiveSession(value: unknown): RpcLiveSession | null {
  if (!isRecord(value)) return null;
  const sessionId = value["sessionId"];
  if (typeof sessionId !== "string" || sessionId === "") return null;
  // Normalize once at the boundary so every identity comparison and newly
  // recorded binding uses the server's realpath, not a browser lexical alias.
  const sessionPath = typeof value["comparisonPath"] === "string"
    ? value["comparisonPath"]
    : value["sessionPath"];
  if (typeof sessionPath !== "string" || sessionPath === "") return null;
  const status = value["status"];
  if (typeof status !== "string" || !RPC_LIVE_STATUSES.has(status)) return null;
  const questions = value["questions"];
  if (!Array.isArray(questions)) return null;
  const updatedAt = value["updatedAt"];
  if (typeof updatedAt !== "number" || !Number.isSafeInteger(updatedAt) || updatedAt < 0) return null;
  const durableSessionId = value["durableSessionId"];
  const cwd = value["cwd"];
  const name = value["name"];
  const messageCount = value["messageCount"];
  return {
    sessionId,
    sessionPath,
    status: status as RpcLiveStatus,
    questions: questions.filter((q): q is string => typeof q === "string"),
    updatedAt,
    durableSessionId: typeof durableSessionId === "string" ? durableSessionId : "",
    cwd: typeof cwd === "string" ? cwd : "",
    name: typeof name === "string" ? name : "",
    messageCount: typeof messageCount === "number" && Number.isSafeInteger(messageCount) && messageCount >= 0
      ? messageCount
      : 0,
  };
}

/** The workspace sessions response carries the live section unpaged; older
 * backends omit it entirely, which maps to no watcher rows. */
export function parseRpcLiveSection(value: unknown): readonly RpcLiveSession[] {
  if (!Array.isArray(value)) return [];
  const rows: RpcLiveSession[] = [];
  for (const entry of value) {
    const parsed = parseRpcLiveSession(entry);
    if (parsed !== null) rows.push(parsed);
  }
  return rows;
}

export interface RpcBoundSession {
  readonly id: string;
  readonly source: string;
  readonly live?: RpcLiveState | undefined;
}

/** Refresh every history page as well as the complete unbound section. */
export async function listWorkspaceRpcLiveSessions(wsId: string, signal?: AbortSignal): Promise<{
  readonly live: readonly RpcLiveSession[];
  readonly items: readonly RpcBoundSession[];
}> {
  const items: RpcBoundSession[] = [];
  let live: readonly RpcLiveSession[] = [];
  let cursor = "";
  do {
    const body = await apiJson<unknown>(
      `/api/workspaces/${encodeURIComponent(wsId)}/sessions${qs({ limit: "5", cursor: cursor || undefined })}`,
      signal ? { signal } : {},
    );
    if (!isRecord(body)) break;
    if (cursor === "") live = parseRpcLiveSection(body["live"]);
    const pageItems = body["items"];
    if (Array.isArray(pageItems)) {
      items.push(...pageItems.flatMap((item): RpcBoundSession[] =>
        isRecord(item) && typeof item["id"] === "string" && item["source"] === "stored"
          ? [{ id: item["id"], source: "stored", live: parseRpcLiveState(item["live"]) }]
          : []));
    }
    cursor = typeof body["nextCursor"] === "string" ? body["nextCursor"] : "";
  } while (cursor !== "");
  return { live, items };
}

/** Activate a watcher row: register the in-place chat when unbound, or
 * re-authorize/select the compatible path-bound chat. 200 and 201 both
 * return the chat to select. */
export async function openRpcLiveSession(wsId: string, sessionId: string): Promise<Terminal> {
  const body = await apiJson<unknown>(
    `/api/workspaces/${encodeURIComponent(wsId)}/rpc-sessions/open`,
    { method: "POST", body: { sessionId } },
  );
  if (!isRecord(body)) throw new ApiError(200, "Invalid rpc session open response", body);
  const id = body["id"];
  if (typeof id !== "string" || id === "") throw new ApiError(200, "Invalid rpc session open response", body);
  const name = body["name"];
  return { id, name: typeof name === "string" ? name : "", provider: "omo" };
}

/** Durable ids are compatible when equal or when either side never recorded
 * one; two known different ids mark a replacement session. */
export function rpcLiveCompatibleDurable(a: string, b: string): boolean {
  a = a.trim();
  b = b.trim();
  return a === "" || b === "" || a === b;
}

/** Browser fallback to lexical Clean: filesystem symlinks cannot be resolved
 * here. Callers must supply resolved paths to match arbitrary symlink aliases. */
export function cleanRpcSessionPath(path: string): string {
  path = path.trim();
  if (path === "") return "";
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(path);
  if (windows) path = path.replaceAll("\\", "/");
  const root = path.match(/^(?:[a-z]:)?\//i)?.[0] ?? "";
  const parts: string[] = [];
  for (const part of path.slice(root.length).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." && parts.length > 0 && parts.at(-1) !== "..") parts.pop();
    else if (part !== ".." || root === "") parts.push(part);
  }
  return root + parts.join("/") || ".";
}

export function rpcSessionIdentityMatches(aPath: string, aId: string, bPath: string, bId: string): boolean {
  const path = cleanRpcSessionPath(aPath);
  return path !== "" && path === cleanRpcSessionPath(bPath) && rpcLiveCompatibleDurable(aId, bId);
}

/** The chat a watcher row aliases into, if any. Canonical session-path
 * equality is mandatory and the durable ids must be compatible — a durable
 * id alone never merges (an adopted copy keeps its durable id at a different
 * path), and a conflicting durable id renders beside the chat row. */
export function rpcLiveAliasChatId(
  live: RpcLiveSession,
  bindings: ReadonlyMap<string, RpcLiveBinding>,
): string | undefined {
  for (const [durableId, binding] of bindings) {
    if (!rpcSessionIdentityMatches(binding.path, durableId, live.sessionPath, live.durableSessionId)) continue;
    return binding.chatId;
  }
  return undefined;
}

export interface RpcLivePartition {
  /** Unbound rows, pinned above the paged history, most recently observed first. */
  readonly visible: readonly RpcLiveSession[];
  /** Rows aliased into a bound chat, keyed by chat id; the chat row carries
   * their status when the manager does not own the route. */
  readonly byChatId: ReadonlyMap<string, RpcLiveSession>;
}

export function partitionRpcLiveSessions(
  rows: readonly RpcLiveSession[],
  bindings: ReadonlyMap<string, RpcLiveBinding> | undefined,
): RpcLivePartition {
  const visible: RpcLiveSession[] = [];
  const byChatId = new Map<string, RpcLiveSession>();
  for (const row of rows) {
    const chatId = bindings === undefined ? undefined : rpcLiveAliasChatId(row, bindings);
    if (chatId === undefined) visible.push(row);
    else byChatId.set(chatId, row);
  }
  visible.sort((a, b) => b.updatedAt - a.updatedAt || (a.sessionId < b.sessionId ? -1 : 1));
  return { visible, byChatId };
}

/** Relative recency for a pinned live row, from the watcher's observation
 * time. Buckets stay coarse so the label never promises precision. */
export function formatRpcLiveRecency(updatedAtMs: number, nowMs: number, t: Translate): string {
  const elapsed = Math.max(0, nowMs - updatedAtMs);
  if (elapsed < 60_000) return t("sidebar.live.recencyNow");
  if (elapsed < 3_600_000) return t("sidebar.live.recencyMinutes", { n: Math.floor(elapsed / 60_000) });
  if (elapsed < 86_400_000) return t("sidebar.live.recencyHours", { n: Math.floor(elapsed / 3_600_000) });
  return t("sidebar.live.recencyDays", { n: Math.floor(elapsed / 86_400_000) });
}
