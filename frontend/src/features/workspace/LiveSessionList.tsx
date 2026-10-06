import { useT } from "../../i18n";
import type { Terminal, Workspace, WorkspaceSession } from "./workspace";
import type { LiveSessionSummary } from "./useLiveSessionSummaries";
import { resolveLiveSummaryTarget, type LiveSummaryTarget } from "./liveSummaryTarget";
import { sessionOpenAttemptKey, type SessionOpenAttemptResult, type SessionOpenAttemptStatus } from "./useSessionOpenAttempts";
import "../../styles/overview.css";

export interface LiveSessionListProps {
  readonly summaries: readonly LiveSessionSummary[];
  readonly workspaces: readonly Workspace[];
  readonly sessionLists: ReadonlyMap<string, readonly WorkspaceSession[]>;
  readonly onSelect: (ws: Workspace, tm: Terminal) => void;
  readonly onOpen: (ws: Workspace, session: WorkspaceSession) => Promise<SessionOpenAttemptResult>;
  readonly openAttempts?: ReadonlyMap<string, SessionOpenAttemptStatus>;
  readonly showLastLine?: boolean;
  readonly listClassName?: string;
}

/** The sidebar's pinned running-sessions section and the home empty state
 * render one live card per listed session. Activation shares the sidebar's
 * open-attempt state, so in-flight opens and failures remain visible here
 * until the user retries. */
export function LiveSessionList({
  summaries,
  workspaces,
  sessionLists,
  onSelect,
  onOpen,
  openAttempts = new Map(),
  showLastLine = true,
  listClassName,
}: LiveSessionListProps) {
  const { t } = useT();

  const openSession = async (target: LiveSummaryTarget): Promise<void> => {
    if (target.kind === "chat") {
      onSelect(target.workspace, target.terminal);
      return;
    }
    await onOpen(target.workspace, target.session);
  };

  // A card renders only when the summary resolves to an open target, so an
  // enabled card always opens something. The resolved target from rendering
  // drives the click: one resolution path for the whole list.
  const listed = summaries.flatMap((summary): readonly { readonly summary: LiveSessionSummary; readonly target: LiveSummaryTarget }[] => {
    const target = resolveLiveSummaryTarget(summary, workspaces, sessionLists);
    return target === null ? [] : [{ summary, target }];
  });

  return (
    <div className={`th-overview-list${listClassName !== undefined ? ` ${listClassName}` : ""}`}>
      {listed.map(({ summary, target }) => {
        const title = summary.title.length > 0 ? summary.title : summary.id;
        const attempt = target.kind === "session"
          ? openAttempts.get(sessionOpenAttemptKey(target.workspace.id, target.session.id))
          : undefined;
        const opening = attempt === "opening";
        const failed = attempt === "failed";
        return (
          <div key={summary.id} className="th-overview-card">
            <button
              type="button"
              className="th-overview-card-open"
              disabled={opening}
              aria-busy={opening || undefined}
              onClick={() => void openSession(target)}
            >
              <span className="th-overview-card-head">
                <span className="th-overview-card-name">{title}</span>
                {(summary.runningCount > 0 || summary.active === true) && (
                  <span
                    className="th-overview-card-running"
                    role="img"
                    aria-label={summary.runningCount > 0 ? t("overview.runningAria", { n: summary.runningCount }) : t("sidebar.tm.mainRunning")}
                    title={summary.active === true ? t("sidebar.tm.mainRunning") : undefined}
                  >
                    <span className="th-overview-card-running-dot" aria-hidden="true" />
                    {summary.runningCount > 0 ? summary.runningCount : null}
                  </span>
                )}
              </span>
              {showLastLine && summary.lastLine !== null && <span className="th-overview-card-line">{summary.lastLine}</span>}
            </button>
            {(opening || failed) && (
              <div className="th-overview-card-state" role="status">
                <span>{t(opening ? "sidebar.tm.opening" : "sidebar.tm.openFailed")}</span>
                {failed && (
                  <button
                    type="button"
                    className="th-btn th-btn--ghost th-overview-retry-open"
                    onClick={() => void openSession(target)}
                  >
                    {t("sidebar.tm.retryOpen")}
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
