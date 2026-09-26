import type { Terminal, Workspace, WorkspaceSession } from "./workspace";

/** Where a live summary can be opened: the stored chat it belongs to, or a
 * loaded session-catalog row that activates through the picker's open path. */
export type LiveSummaryTarget =
  | { readonly kind: "chat"; readonly workspace: Workspace; readonly terminal: Terminal }
  | { readonly kind: "session"; readonly workspace: Workspace; readonly session: WorkspaceSession };

/** Resolve a live summary to its open target, exactly as the live-session
 * lists activate cards: a stored chat (workspace.chats id match) wins; otherwise
 * any already-loaded union row - stored or discovered - in sessionLists matches
 * the session picker's activation path. Poll rows keyed by an engine UUID that
 * no stored chat or loaded row owns (other clients' sessions, deleted chats)
 * resolve to null: there is nothing they can open. */
export function resolveLiveSummaryTarget(
  summary: { readonly id: string },
  workspaces: readonly Workspace[],
  sessionLists: ReadonlyMap<string, readonly WorkspaceSession[]>,
): LiveSummaryTarget | null {
  const workspace = workspaces.find((candidate) => candidate.chats.some((chat) => chat.id === summary.id));
  const terminal = workspace?.chats.find((chat) => chat.id === summary.id);
  if (workspace !== undefined && terminal !== undefined) {
    return { kind: "chat", workspace, terminal };
  }
  for (const candidate of workspaces) {
    const session = (sessionLists.get(candidate.id) ?? []).find((item) => item.id === summary.id);
    if (session !== undefined) return { kind: "session", workspace: candidate, session };
  }
  return null;
}
