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
  readonly onOpen: (ws: Workspace, session: WorkspaceSession, force?: boolean) => Promise<SessionOpenAttemptResult>;
  readonly openAttempts?: ReadonlyMap<string, SessionOpenAttemptStatus>;
  readonly focusedSessionId?: string | null;
  readonly showLastLine?: boolean;
  readonly listClassName?: string;
  readonly onActivated?: () => void;
}

/** The sidebar's pinned running-sessions section renders one read-only live card per running session.
 * Activation shares the sidebar's open-attempt state, so takeover conflicts and failures remain visible here
 * until the user retries or explicitly forces takeover. */
export function LiveSessionList({
  summaries,
  workspaces,
  sessionLists,
  onSelect,
  onOpen,
  openAttempts = new Map(),
  focusedSessionId = null,
  showLastLine = true,
  listClassName,
  onActivated,
}: LiveSessionListProps) {
  const { t } = useT();

  const openSession = async (target: LiveSummaryTarget, force = false): Promise<void> => {
    if (target.kind === "chat") {
      onSelect(target.workspace, target.terminal);
      onActivated?.();
      return;
    }
    const result = await onOpen(target.workspace, target.session, force);
    if (result === "opened") onActivated?.();
  };

  // A card renders only when the summary resolves to an open target, so an
  // enabled card always opens something. The resolved target from rendering
  // drives the click: one resolution path for the whole list.
  const listed = summaries.flatMap((summary): readonly { readonly summary: LiveSessionSummary; readonly target: LiveSummaryTarget }[] => {
    const target = resolveLiveSummaryTarget(summary, workspaces, sessionLists);
    return target === null ? [] : [{ summary, target }];
  });
  const ordered = focusedSessionId === null
    ? listed
    : [...listed].sort((a, b) => Number(b.summary.id === focusedSessionId) - Number(a.summary.id === focusedSessionId));

  return (
    <div className={`th-overview-list${listClassName !== undefined ? ` ${listClassName}` : ""}`}>
      {ordered.map(({ summary, target }) => {
        const title = summary.title.length > 0 ? summary.title : summary.id;
        const attempt = target.kind === "session"
          ? openAttempts.get(sessionOpenAttemptKey(target.workspace.id, target.session.id))
          : undefined;
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
            {(opening || activeElsewhere || failed) && (
              <div className="th-overview-card-state" role="status">
                <span>{t(opening ? "sidebar.tm.opening" : activeElsewhere ? "overview.readOnlyLive" : "sidebar.tm.openFailed")}</span>
                {(activeElsewhere || failed) && (
                  <button
                    type="button"
                    className={`th-btn th-btn--ghost ${activeElsewhere ? "th-overview-force-open" : "th-overview-retry-open"}`}
                    onClick={() => void openSession(target, activeElsewhere)}
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
  );
}
