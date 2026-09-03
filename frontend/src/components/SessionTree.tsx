import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import {
  IconChevron,
  IconEdit,
  IconFolder,
  IconPlus,
  IconTerminal,
  IconTrash,
} from "./icons";
import type { Terminal, Workspace, WorkspaceSession } from "../features/workspace/workspace";
import type { WorkspaceSessionPaging } from "../features/workspace/useWorkspaces";
import { sessionOpenAttemptKey, type SessionOpenAttemptResult, type SessionOpenAttemptStatus } from "../features/workspace/useSessionOpenAttempts";

export type ToastKind = "info" | "success" | "error";

export interface SessionTreeProps {
  readonly workspaces: readonly Workspace[];
  readonly touchActions?: boolean;
  readonly activeTerminalId: string | null;
  readonly placedSessions: ReadonlySet<string>;
  readonly liveSessions: ReadonlySet<string>;
  /** Live session id -> running agent count; rows show a badge while > 0. */
  readonly runningCounts?: ReadonlyMap<string, { readonly count: number; readonly partial: boolean; readonly unknown?: boolean }> | undefined;
  readonly aggregateSessionIds?: ReadonlyMap<string, ReadonlySet<string>> | undefined;
  readonly expanded: ReadonlySet<string>;
  readonly sessionLists: ReadonlyMap<string, readonly WorkspaceSession[]>;
  readonly sessionPages: ReadonlyMap<string, WorkspaceSessionPaging>;
  readonly onToggle: (wsId: string) => void;
  readonly onLoadMoreSessions: (wsId: string) => void;
  readonly onSelect: (ws: Workspace, tm: Terminal) => void;
  readonly onOpen: (ws: Workspace, session: WorkspaceSession, force?: boolean) => Promise<SessionOpenAttemptResult>;
  readonly openAttempts?: ReadonlyMap<string, SessionOpenAttemptStatus>;
  readonly onViewLive?: (sessionId: string) => void;
  readonly onAddTerminal: (ws: Workspace) => void;
  readonly onDeleteWorkspace: (ws: Workspace) => void;
  readonly onDeleteTerminal: (ws: Workspace, tm: Terminal) => void;
  readonly onRenameWorkspace: (ws: Workspace, name: string) => Promise<void>;
  readonly onRenameTerminal: (ws: Workspace, tm: Terminal, name: string) => Promise<void>;
  readonly notify: (msg: string, kind?: ToastKind) => void;
}

interface RenameTarget {
  readonly kind: "workspace" | "terminal";
  readonly wsId: string;
  readonly tmId: string;
}

export function SessionTree({
  workspaces,
  touchActions = false,
  activeTerminalId,
  placedSessions,
  liveSessions,
  runningCounts,
  aggregateSessionIds,
  expanded,
  sessionLists,
  sessionPages,
  onToggle,
  onLoadMoreSessions,
  onSelect,
  onOpen,
  openAttempts = new Map(),
  onViewLive,
  onAddTerminal,
  onDeleteWorkspace,
  onDeleteTerminal,
  onRenameWorkspace,
  onRenameTerminal,
  notify,
}: SessionTreeProps) {
  const { t } = useT();
  const [rename, setRename] = useState<RenameTarget | null>(null);
  const openingRef = useRef(new Set<string>());
  const openDiscovered = (ws: Workspace, session: WorkspaceSession, force = false): void => {
    const key = sessionOpenAttemptKey(ws.id, session.id);
    if (openingRef.current.has(key)) return;
    openingRef.current.add(key);
    void onOpen(ws, session, force).finally(() => openingRef.current.delete(key));
  };

  const commitRename = (target: RenameTarget, value: string): void => {
    setRename(null);
    const name = value.trim();
    if (name.length === 0) return;
    const ws = workspaces.find((w) => w.id === target.wsId);
    if (!ws) return;
    if (target.kind === "workspace") {
      if (name === ws.name) return;
      onRenameWorkspace(ws, name).catch(() => notify(t("toast.error"), "error"));
    } else {
      const item = (sessionLists.get(ws.id) ?? []).find(
        (session) => session.id === target.tmId && session.source === "stored" && session.dangling !== true,
      );
      const tm = ws.chats.find((x) => x.id === target.tmId) ?? (item
        ? { id: item.id, name: item.name, provider: "omo" as const }
        : undefined);
      if (!tm || name === tm.name) return;
      onRenameTerminal(ws, tm, name).catch(() => notify(t("toast.error"), "error"));
    }
  };

  return (
    <div
      className={`th-tree${touchActions ? " th-tree--touch" : ""}`}
      role="navigation"
      aria-label={t("sidebar.title")}
    >
      {workspaces.map((ws) => {
        const isOpen = expanded.has(ws.id);
        const paging = sessionPages.get(ws.id);
        const mergedSessionIds = new Set(ws.chats.map((chat) => chat.id));
        for (const session of sessionLists.get(ws.id) ?? []) mergedSessionIds.add(session.id);
        for (const id of aggregateSessionIds?.get(ws.id) ?? []) mergedSessionIds.add(id);
        const renamingWs =
          rename && rename.kind === "workspace" && rename.wsId === ws.id ? rename : null;
        return (
          <div key={ws.id} className="th-tree-workspace">
            <div className="th-tree-node">
              <button
                type="button"
                className={`th-tree-chevron${isOpen ? " th-tree-chevron--open" : ""}`}
                aria-label={isOpen ? t("sidebar.collapse") : t("sidebar.expand")}
                aria-expanded={isOpen}
                onClick={() => onToggle(ws.id)}
              >
                <IconChevron size={13} />
              </button>
              <span className="th-tree-icon">
                <IconFolder size={14} />
              </span>
              {renamingWs ? (
                <RenameInput initial={ws.name} onCommit={(v) => commitRename(renamingWs, v)} />
              ) : (
                <button
                  type="button"
                  className="th-tree-label th-tree-activation"
                  style={{ textAlign: "start" }}
                  title={ws.path}
                  aria-label={ws.name}
                  onClick={() => onToggle(ws.id)}
                >
                  {ws.name}
                </button>
              )}
              <span className="th-tree-count">{mergedSessionIds.size}</span>
              {(() => {
                const workspaceRunning = Array.from(mergedSessionIds).reduce((total, id) => total + (runningCounts?.get(id)?.count ?? 0), 0);
                const workspacePartial = Array.from(mergedSessionIds).some((id) => runningCounts?.get(id)?.partial === true);
                const workspaceUnknown = Array.from(mergedSessionIds).some((id) => runningCounts?.get(id)?.unknown === true);
                return workspaceRunning > 0 || workspaceUnknown ? (
                  <span
                    className="th-tree-running th-tree-running--workspace"
                    role="img"
                    aria-label={workspaceUnknown
                      ? t("sidebar.ws.runningAgentsUnknown")
                      : t(workspacePartial ? "sidebar.ws.runningAgentsPartial" : "sidebar.ws.runningAgents", { n: workspaceRunning })}
                    title={workspaceUnknown ? t("sidebar.ws.runningAgentsUnknown") : undefined}
                  >
                    <span className="th-tree-running-dot" aria-hidden="true" />
                    {workspaceUnknown ? "?" : `${workspaceRunning}${workspacePartial ? "+" : ""}`}
                  </span>
                ) : null;
              })()}
              <span className="th-tree-actions">
                <button
                  type="button"
                  className="th-btn-icon"
                  title={t("sidebar.ws.rename")}
                  onClick={() => setRename({ kind: "workspace", wsId: ws.id, tmId: "" })}
                >
                  <IconEdit size={12} />
                </button>
                <button
                  type="button"
                  className="th-btn-icon"
                  title={t("sidebar.ws.addTerminal")}
                  onClick={() => onAddTerminal(ws)}
                >
                  <IconPlus size={13} />
                </button>
                <button
                  type="button"
                  className="th-btn-icon th-btn-icon--danger"
                  title={t("sidebar.ws.delete")}
                  onClick={() => onDeleteWorkspace(ws)}
                >
                  <IconTrash size={12} />
                </button>
              </span>
            </div>

            <fieldset className={`th-tree-children${isOpen ? "" : " th-tree-children--closed"}`}>
              {(sessionLists.get(ws.id) ?? []).map((item) => {
                const stored = item.source === "stored";
                const listed = stored ? ws.chats.find((chat) => chat.id === item.id) : undefined;
                // v2 union: the sessions REST also lists cursorstore-only chats
                // the legacy workspace chat list does not carry. They are real
                // chats — activate them through the same select flow instead of
                // rendering a dead row. Dangling identities stay inert.
                const tm = listed ?? (stored && item.dangling !== true
                  ? { id: item.id, name: item.name, provider: "omo" as const }
                  : undefined);
                const discovered = item.source === "discovered";
                const openKey = sessionOpenAttemptKey(ws.id, item.id);
                const openAttempt = discovered ? openAttempts.get(openKey) : undefined;
                const openInFlight = openAttempt === "opening";
                const activeElsewhere = openAttempt === "session-active";
                const openFailed = openAttempt === "failed";
                const interactive = tm !== undefined || discovered;
                const rowDisabled = !interactive || openInFlight || activeElsewhere;
                const active = tm !== undefined && item.id === activeTerminalId;
                const live = tm !== undefined && liveSessions.has(item.id);
                const renamingTm = tm !== undefined && rename?.kind === "terminal" && rename.tmId === item.id
                  ? rename
                  : null;
                const runningInfo = runningCounts?.get(item.id);
                const running = runningInfo?.count ?? 0;
                const runningUnknown = runningInfo?.unknown === true;
                const displayName = item.name.trim() !== "" ? item.name : t("sidebar.tm.untitled", { id: item.id.slice(0, 8) });
                const discoveredLabel = discovered
                  ? t("sidebar.tm.discoveredHint", { name: displayName })
                  : undefined;
                const dangling = item.source === "stored" && item.dangling === true;
                const danglingHint = dangling
                  ? t("sidebar.tm.missingOriginalHint", { name: displayName })
                  : undefined;
                const title = danglingHint
                  ?? (openInFlight ? t("sidebar.tm.opening") : openFailed ? t("sidebar.tm.openFailed") : discoveredLabel)
                  ?? (live ? t("sidebar.tm.liveProcess") : undefined);
                const activate = (): void => {
                  if (tm !== undefined) onSelect(ws, tm);
                  else if (discovered) openDiscovered(ws, item);
                };
                return (
                  <div
                    key={`${item.source}:${item.id}`}
                    className={`th-tree-node${active ? " th-tree-node--active" : ""}${rowDisabled ? " th-tree-node--disabled" : ""}`}
                  >
                    {live && <span className="th-tree-live" aria-hidden="true" />}
                    <span
                      className={`th-tree-placed${tm !== undefined && placedSessions.has(item.id) ? " th-tree-placed--on" : ""}`}
                      aria-hidden="true"
                    />
                    <span className="th-tree-icon">
                      <IconTerminal size={13} />
                    </span>
                    {renamingTm && tm ? (
                      <RenameInput initial={tm.name} onCommit={(v) => commitRename(renamingTm, v)} />
                    ) : (
                      <button
                        type="button"
                        className="th-tree-activation"
                        title={title}
                        aria-label={discoveredLabel}
                        aria-current={active ? "true" : undefined}
                        aria-busy={openInFlight || undefined}
                        disabled={rowDisabled}
                        onClick={activate}
                      >
                        <span className="th-tree-label">{displayName}</span>
                        {openInFlight ? (
                          <span className="th-tree-source" aria-hidden="true">{t("sidebar.tm.opening")}</span>
                        ) : dangling ? (
                          <span className="th-tree-source" aria-hidden="true">{t("sidebar.tm.missingOriginal")}</span>
                        ) : null}
                      </button>
                    )}
                    {(activeElsewhere || openFailed) && (
                      <span className="th-tree-session-active" role="status">
                        {t(activeElsewhere ? "sidebar.tm.sessionActive" : "sidebar.tm.openFailed")}
                        {activeElsewhere && onViewLive && (
                          <button
                            type="button"
                            className="th-btn th-btn--ghost th-tree-view-live"
                            onClick={() => onViewLive(item.id)}
                          >
                            {t("sidebar.tm.viewLive")}
                          </button>
                        )}
                        <button
                          type="button"
                          className={`th-btn th-btn--ghost ${activeElsewhere ? "th-tree-force-open" : "th-tree-retry-open"}`}
                          onClick={() => openDiscovered(ws, item, activeElsewhere)}
                        >
                          {t(activeElsewhere ? "sidebar.tm.forceOpen" : "sidebar.tm.retryOpen")}
                        </button>
                      </span>
                    )}
                    {(running > 0 || runningUnknown) && (
                      <span
                        className="th-tree-running"
                        role="img"
                        aria-label={runningUnknown
                          ? t("sidebar.tm.runningAgentsUnknown")
                          : t(runningInfo?.partial ? "sidebar.tm.runningAgentsPartial" : "sidebar.tm.runningAgents", { n: running })}
                        title={runningUnknown ? t("sidebar.tm.runningAgentsUnknown") : undefined}
                      >
                        <span className="th-tree-running-dot" aria-hidden="true" />
                        {runningUnknown ? "?" : `${running}${runningInfo?.partial ? "+" : ""}`}
                      </span>
                    )}
                    {tm ? (
                      <span className="th-tree-actions">
                        <button
                          type="button"
                          className="th-btn-icon"
                          title={t("sidebar.tm.rename")}
                          onClick={() => setRename({ kind: "terminal", wsId: ws.id, tmId: tm.id })}
                        >
                          <IconEdit size={12} />
                        </button>
                        <button
                          type="button"
                          className="th-btn-icon th-btn-icon--danger"
                          title={t("sidebar.tm.delete")}
                          onClick={() => onDeleteTerminal(ws, tm)}
                        >
                          <IconTrash size={12} />
                        </button>
                      </span>
                    ) : null}
                  </div>
                );
              })}
              {paging?.hasMore ? (
                <button
                  type="button"
                  className="th-tree-more"
                  disabled={paging.loading}
                  aria-busy={paging.loading || undefined}
                  onClick={() => onLoadMoreSessions(ws.id)}
                >
                  {paging.loading ? t("sidebar.ws.moreLoading") : t("sidebar.ws.more")}
                </button>
              ) : null}
            </fieldset>
          </div>
        );
      })}
    </div>
  );
}

interface RenameInputProps {
  readonly initial: string;
  readonly onCommit: (value: string) => void;
}

function RenameInput({ initial, onCommit }: RenameInputProps) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => inputRef.current?.focus(), []);

  const commit = (v: string): void => {
    if (done.current) return;
    done.current = true;
    onCommit(v);
  };

  return (
    <input
      ref={inputRef}
      className="th-tree-rename"
      value={value}
      onClick={(ev) => ev.stopPropagation()}
      onChange={(ev) => setValue(ev.target.value)}
      onKeyDown={(ev) => {
        ev.stopPropagation();
        if (ev.key === "Enter") commit(value);
        else if (ev.key === "Escape") commit("");
      }}
      onBlur={() => commit(value)}
    />
  );
}
