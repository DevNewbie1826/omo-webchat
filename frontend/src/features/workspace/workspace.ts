import { apiJson, apiVoid, qs } from "../../lib/api";

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

interface LiveSessionsResponse {
  readonly sessions: readonly string[];
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

export async function listWorkspaces(): Promise<readonly Workspace[]> {
  return apiJson<readonly Workspace[]>("/api/workspaces");
}

export async function listLiveSessions(signal?: AbortSignal): Promise<readonly string[]> {
  const response = await apiJson<LiveSessionsResponse>("/api/sessions/live", signal ? { signal } : {});
  return response.sessions;
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
