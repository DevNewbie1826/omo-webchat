import type { ReactNode } from "react";
import { IconMenu, IconPlus } from "./icons";
import { PresenceHero } from "./PresenceHero";
import { useT } from "../i18n";
import type { Workspace } from "../features/workspace/workspace";

export interface ChatEmptyStateProps {
  readonly mobile: boolean;
  readonly sessionPicker?: ReactNode;
  readonly runningSessions?: ReactNode;
  readonly workspaces: readonly Workspace[];
  readonly onOpenSidebar: () => void;
  readonly onNewWorkspace: () => void;
  readonly onNewChat: () => void;
}

export interface ChatEmptyHeroProps {
  readonly hasWorkspaces: boolean;
  readonly onNewWorkspace: () => void;
  readonly onNewChat: () => void;
}

/** The action slot carries the mobile hero's CTA; the desktop picker omits
 * it and keeps its own create action at the foot of the list. */
export function ChatEmptyHero({ hasWorkspaces, onNewWorkspace, onNewChat }: ChatEmptyHeroProps) {
  const { t } = useT();
  return (
    <PresenceHero
      greeting={t("empty.greeting")}
      hint={t(hasWorkspaces ? "empty.hintResume" : "empty.hintStart")}
      action={(
        <button
          type="button"
          className="th-btn th-btn--primary th-empty-cta"
          onClick={hasWorkspaces ? onNewChat : onNewWorkspace}
        >
          <IconPlus size={16} />
          {t(hasWorkspaces ? "empty.newChat" : "empty.newWorkspace")}
        </button>
      )}
    />
  );
}

export function ChatEmptyState({
  mobile,
  sessionPicker,
  runningSessions,
  workspaces,
  onOpenSidebar,
  onNewWorkspace,
  onNewChat,
}: ChatEmptyStateProps) {
  const { t } = useT();

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
      <ChatEmptyHero hasWorkspaces={workspaces.length > 0} onNewWorkspace={onNewWorkspace} onNewChat={onNewChat} />
      {runningSessions}
      {sessionPicker}
    </div>
  );
}
