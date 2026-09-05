import { useEffect, useState } from "react";
import { useT } from "../../i18n";
import type { Workspace, WorkspaceSession } from "../workspace/workspace";
import type { WorkspaceSessionPaging } from "../workspace/useWorkspaces";
import { sessionOpenAttemptKey, useSessionOpenAttempts } from "../workspace/useSessionOpenAttempts";

export interface SessionPickerProps {
  readonly workspaces: readonly Workspace[];
  readonly sessionLists: ReadonlyMap<string, readonly WorkspaceSession[]>;
  readonly sessionPages: ReadonlyMap<string, WorkspaceSessionPaging>;
  readonly onEnsureSessions: (wsId: string) => void;
  readonly onLoadMoreSessions: (wsId: string) => Promise<void>;
  readonly onOpenSession: (ws: Workspace, session: WorkspaceSession, force?: boolean) => Promise<"opened" | "session-active">;
  readonly onNewChat: (wsId: string) => void;
}

/** The sidebar's inventory and open pipeline, also used by narrow empty views. */
export function SessionPicker({ workspaces, sessionLists, sessionPages, onEnsureSessions, onLoadMoreSessions, onOpenSession, onNewChat }: SessionPickerProps) {
  const { t } = useT();
  const [selectedWorkspace, setSelectedWorkspace] = useState("");
  const workspace = workspaces.find(ws => ws.id === selectedWorkspace) ?? workspaces[0];
  const workspaceID = workspace?.id ?? "";
  const paging = sessionPages.get(workspaceID);
  const rows = sessionLists.get(workspaceID) ?? [];
  const { attempts, open } = useSessionOpenAttempts(onOpenSession);
  useEffect(() => {
    if (workspaceID) onEnsureSessions(workspaceID);
  }, [workspaceID, onEnsureSessions]);

  return (
    <div className="th-picker-pane">
      <div className="th-picker-pane-title">{t("split.pickTitle")}</div>
      <select aria-label={t("split.pickWorkspace")} value={workspaceID} disabled={!workspace}
        onChange={event => setSelectedWorkspace(event.target.value)}>
        {workspaces.map(ws => <option key={ws.id} value={ws.id}>{ws.name}</option>)}
      </select>
      {paging?.loading && !paging.ready ? (
        <div className="th-picker-pane-empty" role="status">{t("split.pickLoading")}</div>
      ) : rows.length > 0 && workspace ? (
        <div className="th-picker-pane-list">
          {rows.map(entry => {
            const status = attempts.get(sessionOpenAttemptKey(workspaceID, entry.id));
            const label = `${workspace.name} / ${entry.name}`;
            return (
              <div key={entry.id}>
                <button type="button" className="th-picker-pane-item" title={label} aria-label={label}
                  disabled={entry.dangling || status === "opening" || status === "session-active"}
                  aria-busy={status === "opening" || undefined}
                  onClick={() => void open(workspace, entry)}>
                  <span className="th-picker-pane-name">{entry.name}</span>
                  {status === "opening" && <span>{t("sidebar.tm.opening")}</span>}
                  {entry.dangling && <span>{t("sidebar.tm.missingOriginal")}</span>}
                </button>
                {(status === "failed" || status === "session-active") && (
                  <div role="status">
                    {t(status === "failed" ? "sidebar.tm.openFailed" : "sidebar.tm.sessionActive")}
                    <button type="button" className={`th-btn th-btn--ghost ${status === "failed" ? "th-picker-retry-open" : "th-picker-force-open"}`}
                      onClick={() => void open(workspace, entry, status === "session-active")}>
                      {t(status === "failed" ? "common.retry" : "sidebar.tm.forceOpen")}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : <div className="th-picker-pane-empty">{t(workspace ? "split.pickEmptyFiltered" : "split.pickEmpty")}</div>}
      {paging?.error && (
        <div role="alert">
          {t("split.pickError")}
          <button type="button" className="th-btn th-btn--ghost th-picker-page-retry"
            onClick={() => paging.ready ? void onLoadMoreSessions(workspaceID) : onEnsureSessions(workspaceID)}>{t("common.retry")}</button>
        </div>
      )}
      {paging?.hasMore && !paging.error && (
        <button type="button" className="th-btn th-btn--ghost th-picker-load-more" disabled={paging.loading}
          onClick={() => void onLoadMoreSessions(workspaceID)}>
          {t(paging.loading ? "sidebar.ws.moreLoading" : "sidebar.ws.more")}
        </button>
      )}
      <div className="th-picker-pane-create">
        <button type="button" className="th-btn th-btn--primary" disabled={!workspaceID}
          onClick={() => onNewChat(workspaceID)}>{t("split.pickNew")}</button>
      </div>
    </div>
  );
}
