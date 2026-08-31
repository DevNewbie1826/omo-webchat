import { IconMenu } from "./icons";
import { useT } from "../i18n";
import type { Workspace } from "../features/workspace/workspace";

export interface ChatEmptyStateProps {
  readonly mobile: boolean;
  readonly workspaces: readonly Workspace[];
  readonly onOpenSidebar: () => void;
  readonly onNewWorkspace: () => void;
  readonly onNewChat: () => void;
}

export function ChatEmptyState({
  mobile,
  workspaces,
  onOpenSidebar,
  onNewWorkspace,
  onNewChat,
}: ChatEmptyStateProps) {
  const { t } = useT();
  const hasWorkspaces = workspaces.length > 0;

  return (
    <div className="th-empty">
      {mobile && (
        <button
          type="button"
          className="th-btn-icon th-empty-menu"
          title={t("empty.menu")}
          aria-label={t("empty.menu")}
          onClick={onOpenSidebar}
        >
          <IconMenu size={18} />
        </button>
      )}
      <div className="th-empty-glyph">{t("app.title")}</div>
      <h2 className="th-empty-title">{t("empty.title")}</h2>
      <p className="th-empty-hint">{t("empty.hint")}</p>
      <button
        type="button"
        className="th-btn th-btn--primary"
        onClick={hasWorkspaces ? onNewChat : onNewWorkspace}
      >
        {t(hasWorkspaces ? "empty.newChat" : "empty.newWorkspace")}
      </button>
    </div>
  );
}
