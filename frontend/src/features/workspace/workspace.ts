import { apiJson, apiVoid, qs } from "../../lib/api";
import { parseDagDigest, parseTaskDigest, type DagDigest, type TaskDigest } from "./activityDigest";

export type ChatProvider = "omo";

export interface ProviderStatus {
  readonly id: ChatProvider;
  readonly label: string;
  readonly binary: string;
  readonly available: boolean;
}

export type ProviderDiscoveryState =
  | { readonly status: "loading" }
  | { readonly status: "error" }
  | { readonly status: "loaded"; readonly providers: readonly ProviderStatus[] };

export interface Terminal {
  readonly id: string;
  readonly name: string;
  readonly provider: ChatProvider;
}

export interface ChatSessionRef {
  readonly id: string;
  readonly name: string;
  readonly wsId: string;
  readonly cwd: string;
  readonly provider: ChatProvider;
}

export interface Workspace {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly chats: readonly Terminal[];
}

/** One entry of GET /api/sessions/live: a live session plus its latest raw
 * activity payloads (`omo.task.updated` / `omo.dag.updated`, or null when the
 * session carries none). Payloads stay raw here; activityParse turns them into
 * UI state. */
export interface LiveSessionInfo {
  readonly id: string;
  readonly title: string;
  readonly task: unknown;
  readonly dag: unknown;
  readonly taskOversized?: boolean;
  readonly dagOversized?: boolean;
  readonly taskDigest?: TaskDigest;
  readonly dagDigest?: DagDigest;
}

interface LiveSessionsResponse {
  readonly sessions: readonly unknown[];
}

// Tolerant of both the enriched contract and the pre-enrichment id-only
// response, so an older backend keeps the live indicator working.
function parseLiveSession(value: unknown): LiveSessionInfo | null {
  if (typeof value === "string") {
    return value.length > 0 ? { id: value, title: "", task: null, dag: null } : null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const id = record["id"];
  if (typeof id !== "string" || id.length === 0) return null;
  const title = record["title"];
  const taskDigest = parseTaskDigest(record["task_digest"]);
  const dagDigest = parseDagDigest(record["dag_digest"]);
  return {
    id,
    title: typeof title === "string" ? title : "",
    task: record["task"] ?? null,
    dag: record["dag"] ?? null,
    ...(record["task_oversized"] === true ? { taskOversized: true } : {}),
    ...(record["dag_oversized"] === true ? { dagOversized: true } : {}),
    ...(taskDigest !== null ? { taskDigest } : {}),
    ...(dagDigest !== null ? { dagDigest } : {}),
  };
}

/** Where a session-history entry came from: a stored chat row or an omo
 * session file discovered on disk. */
export type WorkspaceSessionSource = "stored" | "discovered";

/** One entry of GET /api/workspaces/{wsId}/sessions (newest first). */
export interface WorkspaceSession {
  readonly id: string;
  readonly name: string;
  readonly source: WorkspaceSessionSource;
  readonly recencyMs: number;
  readonly resumeIdentity?: string;
  /** Stored rows only: the session's stored identity file no longer exists. */
  readonly dangling?: boolean;
}

export interface WorkspaceSessionPage {
  readonly items: readonly WorkspaceSession[];
  readonly nextCursor: string;
}

const WORKSPACE_SESSION_PAGE_SIZE = 5;

/**
 * Fetch one recency-sorted page of a workspace's session history (stored
 * chats merged with discovered omo sessions). Pass the previous page's
 * nextCursor to continue; an empty nextCursor means no further pages.
 */
export async function listWorkspaceSessions(
  wsId: string,
  cursor = "",
  signal?: AbortSignal,
): Promise<WorkspaceSessionPage> {
  const query = qs({ limit: String(WORKSPACE_SESSION_PAGE_SIZE), cursor: cursor || undefined });
  return apiJson<WorkspaceSessionPage>(
    `/api/workspaces/${encodeURIComponent(wsId)}/sessions${query}`,
    signal ? { signal } : {},
  );
}

/** Resolve otherwise-unknown live IDs through the complete union independently
 * of the sidebar's expansion state and visible pagination. */
export interface WorkspaceSessionMembership {
  memberships: ReadonlyMap<string, ReadonlySet<string>>;
  hadFailures: boolean;
}

export async function resolveWorkspaceSessionMembership(
  workspaces: readonly Workspace[],
  sessionIds: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<WorkspaceSessionMembership> {
  const results = await Promise.allSettled(workspaces.map(async (workspace) => {
    const matches = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor = "";
    do {
      const page = await listWorkspaceSessions(workspace.id, cursor, signal);
      for (const item of page.items) {
        if (item.source === "stored" && sessionIds.has(item.id)) matches.add(item.id);
      }
      if (page.nextCursor === "" || seenCursors.has(page.nextCursor)) break;
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    } while (matches.size < sessionIds.size);
    return [workspace.id, matches] as const;
  }));
  if (signal?.aborted) throw new DOMException("Membership resolution aborted", "AbortError");
  const memberships = new Map(results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []));
  const hadFailures = results.some((result) => result.status === "rejected");
  return { memberships, hadFailures };
}

export async function listWorkspaces(): Promise<readonly Workspace[]> {
  return apiJson<readonly Workspace[]>("/api/workspaces");
}

export async function listLiveSessions(signal?: AbortSignal): Promise<readonly LiveSessionInfo[]> {
  const response = await apiJson<LiveSessionsResponse>("/api/sessions/live", signal ? { signal } : {});
  const sessions: LiveSessionInfo[] = [];
  for (const entry of response.sessions) {
    const parsed = parseLiveSession(entry);
    if (parsed !== null) sessions.push(parsed);
  }
  return sessions;
}

export async function createWorkspace(name: string, path: string): Promise<Workspace> {
  return apiJson<Workspace>("/api/workspaces", { method: "POST", body: { name, path } });
}

export async function deleteWorkspace(id: string): Promise<void> {
  await apiVoid(`/api/workspaces/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function renameWorkspace(id: string, name: string): Promise<Workspace> {
  return apiJson<Workspace>(`/api/workspaces/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: { name },
  });
}
