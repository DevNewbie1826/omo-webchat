import { useT } from "../../i18n";
import { ModalDialog } from "../../components/ModalDialog";
import type { Terminal, Workspace, WorkspaceSession } from "./workspace";
import type { LiveSessionSummary } from "./useLiveSessionSummaries";
import { sessionOpenAttemptKey, type SessionOpenAttemptResult, type SessionOpenAttemptStatus } from "./useSessionOpenAttempts";
import "../../styles/overview.css";

export interface OverviewPanelProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly focusedSessionId?: string | null;
  readonly summaries: readonly LiveSessionSummary[];
  readonly workspaces: readonly Workspace[];
  readonly sessionLists: ReadonlyMap<string, readonly WorkspaceSession[]>;
  readonly onSelect: (ws: Workspace, tm: Terminal) => void;
  readonly onOpen: (ws: Workspace, session: WorkspaceSession, force?: boolean) => Promise<SessionOpenAttemptResult>;
  readonly openAttempts?: ReadonlyMap<string, SessionOpenAttemptStatus>;
}

interface DiscoveredTarget {
  readonly workspace: Workspace;
  readonly session: WorkspaceSession;
}

/** Sessions overview: one read-only live card per live session. Activation
 * shares the sidebar's open-attempt state, so takeover conflicts and failures
 * remain visible here until the user retries or explicitly forces takeover. */
export function OverviewPanel({
  open,
  onClose,
  focusedSessionId = null,
  summaries,
  workspaces,
  sessionLists,
  onSelect,
  onOpen,
  openAttempts = new Map(),
}: OverviewPanelProps) {
  const { t } = useT();

  const discoveredTarget = (sessionId: string): DiscoveredTarget | null => {
    for (const workspace of workspaces) {
      const session = (sessionLists.get(workspace.id) ?? []).find(
        (item) => item.id === sessionId && item.source === "discovered",
      );
      if (session !== undefined) return { workspace, session };
    }
    return null;
  };

  const openSession = async (summary: LiveSessionSummary, force = false): Promise<void> => {
    const ws = workspaces.find((workspace) => workspace.chats.some((chat) => chat.id === summary.id));
    const tm = ws?.chats.find((chat) => chat.id === summary.id);
    if (ws !== undefined && tm !== undefined) {
      onSelect(ws, tm);
      onClose();
      return;
    }
    const target = discoveredTarget(summary.id);
    if (target === null) return;
    const result = await onOpen(target.workspace, target.session, force);
    if (result === "opened") onClose();
  };

  const orderedSummaries = focusedSessionId === null
    ? summaries
    : [...summaries].sort((a, b) => Number(b.id === focusedSessionId) - Number(a.id === focusedSessionId));

  return (
    <ModalDialog open={open} onClose={onClose} labelledBy="th-overview-title" closeLabel={t("common.close")}>
      <div className="th-overview">
        <h2 className="th-overview-title" id="th-overview-title">{t("overview.title")}</h2>
        {orderedSummaries.length === 0 ? (
          <div className="th-overview-empty">{t("overview.empty")}</div>
        ) : (
          <div className="th-overview-list">
            {orderedSummaries.map((summary) => {
              const title = summary.title.length > 0 ? summary.title : summary.id;
              const runningUnknown = summary.taskOversized || summary.dagOversized;
              const runningPartial = summary.truncatedTasks && !runningUnknown;
              const target = discoveredTarget(summary.id);
              const attempt = target === null
                ? undefined
                : openAttempts.get(sessionOpenAttemptKey(target.workspace.id, target.session.id));
              const opening = attempt === "opening";
              const activeElsewhere = attempt === "session-active";
              const failed = attempt === "failed";
              return (
                <div
                  key={summary.id}
                  className={`th-overview-card${summary.id === focusedSessionId ? " th-overview-card--focused" : ""}`}
                >
                  <button
                    type="button"
                    className="th-overview-card-open"
                    disabled={opening || activeElsewhere}
                    aria-busy={opening || undefined}
                    onClick={() => void openSession(summary)}
                  >
                    <span className="th-overview-card-head">
                      <span className="th-overview-card-name">{title}</span>
                      {(summary.runningCount > 0 || runningUnknown) && (
                        <span
                          className="th-overview-card-running"
                          role="img"
                          aria-label={runningUnknown
                            ? t("overview.runningAriaUnknown")
                            : t(runningPartial ? "overview.runningAriaPartial" : "overview.runningAria", { n: summary.runningCount })}
                          title={runningUnknown ? t("overview.runningAriaUnknown") : undefined}
                        >
                          <span className="th-overview-card-running-dot" aria-hidden="true" />
                          {runningUnknown ? "?" : `${summary.runningCount}${runningPartial ? "+" : ""}`}
                        </span>
                      )}
                    </span>
                    <span className="th-overview-card-meta">
                      <span className="th-overview-card-stat">{t("overview.done")} {summary.doneCount}</span>
                      {summary.dagTotal > 0 && (
                        <span className="th-overview-card-stat">{t("overview.dag")} {summary.dagDone}/{summary.dagTotal}</span>
                      )}
                    </span>
                    {summary.lastLine !== null && <span className="th-overview-card-line">{summary.lastLine}</span>}
                  </button>
                  {(opening || activeElsewhere || failed) && (
                    <div className="th-overview-card-state" role="status">
                      <span>{t(opening ? "sidebar.tm.opening" : activeElsewhere ? "overview.readOnlyLive" : "sidebar.tm.openFailed")}</span>
                      {(activeElsewhere || failed) && (
                        <button
                          type="button"
                          className={`th-btn th-btn--ghost ${activeElsewhere ? "th-overview-force-open" : "th-overview-retry-open"}`}
                          onClick={() => void openSession(summary, activeElsewhere)}
                        >
                          {t(activeElsewhere ? "sidebar.tm.forceOpen" : "sidebar.tm.retryOpen")}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </ModalDialog>
  );
}
