import { useT } from "../../i18n";
import { ModalDialog } from "../../components/ModalDialog";
import type { Terminal, Workspace, WorkspaceSession } from "./workspace";
import type { LiveSessionSummary } from "./useLiveSessionSummaries";
import "../../styles/overview.css";

export interface OverviewPanelProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly summaries: readonly LiveSessionSummary[];
  readonly workspaces: readonly Workspace[];
  readonly sessionLists: ReadonlyMap<string, readonly WorkspaceSession[]>;
  readonly onSelect: (ws: Workspace, tm: Terminal) => void;
  readonly onOpen: (ws: Workspace, session: WorkspaceSession, force?: boolean) => Promise<"opened" | "session-active" | void>;
}

/** Sessions overview: one alive card per live session. Card clicks reuse the
 * SessionTree row activation flow: stored chats select directly and discovered
 * sessions bind their original file through the same open handler as the tree. */
export function OverviewPanel({
  open,
  onClose,
  summaries,
  workspaces,
  sessionLists,
  onSelect,
  onOpen,
}: OverviewPanelProps) {
  const { t } = useT();

  const openSession = (summary: LiveSessionSummary): void => {
    const ws = workspaces.find((workspace) =>
      workspace.chats.some((chat) => chat.id === summary.id),
    );
    const tm = ws?.chats.find((chat) => chat.id === summary.id);
    if (ws !== undefined && tm !== undefined) {
      onSelect(ws, tm);
      onClose();
      return;
    }
    for (const workspace of workspaces) {
      const discovered = (sessionLists.get(workspace.id) ?? []).find(
        (session) => session.id === summary.id && session.source === "discovered",
      );
      if (discovered !== undefined) {
        void onOpen(workspace, discovered).catch(() => undefined);
        onClose();
        return;
      }
    }
  };

  return (
    <ModalDialog open={open} onClose={onClose} labelledBy="th-overview-title" closeLabel={t("common.close")}>
      <div className="th-overview">
        <h2 className="th-overview-title" id="th-overview-title">
          {t("overview.title")}
        </h2>
        {summaries.length === 0 ? (
          <div className="th-overview-empty">{t("overview.empty")}</div>
        ) : (
          <div className="th-overview-list">
            {summaries.map((summary) => {
              const title = summary.title.length > 0 ? summary.title : summary.id;
              const runningUnknown = summary.taskOversized || summary.dagOversized;
              const runningPartial = summary.truncatedTasks && !runningUnknown;
              return (
                <button
                  key={summary.id}
                  type="button"
                  className="th-overview-card"
                  onClick={() => openSession(summary)}
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
                    <span className="th-overview-card-stat">
                      {t("overview.done")} {summary.doneCount}
                    </span>
                    {summary.dagTotal > 0 && (
                      <span className="th-overview-card-stat">
                        {t("overview.dag")} {summary.dagDone}/{summary.dagTotal}
                      </span>
                    )}
                  </span>
                  {summary.lastLine !== null && (
                    <span className="th-overview-card-line">{summary.lastLine}</span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </ModalDialog>
  );
}
