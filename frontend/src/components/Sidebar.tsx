import { useState } from "react";
import { useT } from "../i18n";
import { SessionTree } from "./SessionTree";
import type { ToastKind } from "./SessionTree";
import { IconChevron, IconLogOut, IconPlus, IconX } from "./icons";
import { SettingsMenu } from "./SettingsMenu";
import type { Terminal, Workspace, WorkspaceSession } from "../features/workspace/workspace";
import type { WorkspaceSessionPaging } from "../features/workspace/useWorkspaces";
import { useMediaQuery } from "../lib/useMediaQuery";
import { SystemStatsModal } from "../features/system/SystemStatsModal";

export interface SidebarProps {
  readonly collapsed: boolean;
  readonly onToggleCollapse: () => void;
  readonly workspaces: readonly Workspace[];
  readonly activeTerminalId: string | null;
  readonly placedSessions: ReadonlySet<string>;
  readonly liveSessions: ReadonlySet<string>;
  readonly expanded: ReadonlySet<string>;
  readonly sessionLists: ReadonlyMap<string, readonly WorkspaceSession[]>;
  readonly sessionPages: ReadonlyMap<string, WorkspaceSessionPaging>;
  readonly onToggleExpanded: (wsId: string) => void;
  readonly onLoadMoreSessions: (wsId: string) => void;
  readonly onSelectTerminal: (ws: Workspace, tm: Terminal) => void;
  readonly onImportSession: (ws: Workspace, session: WorkspaceSession) => Promise<void>;
  readonly onAddWorkspace: () => void;
  readonly onAddTerminal: (ws: Workspace) => void;
  readonly onDeleteWorkspace: (ws: Workspace) => void;
  readonly onDeleteTerminal: (ws: Workspace, tm: Terminal) => void;
  readonly onRenameWorkspace: (ws: Workspace, name: string) => Promise<void>;
  readonly onRenameTerminal: (ws: Workspace, tm: Terminal, name: string) => Promise<void>;
  readonly onLogout: () => void;
  readonly notify: (msg: string, kind?: ToastKind) => void;
}

/** Viewport width below which the sidebar becomes a drawer. Keep in sync with the CSS @media queries. */
export const MOBILE_QUERY = "(max-width: 768px)";

export function Sidebar({
  collapsed,
  onToggleCollapse,
  workspaces,
  activeTerminalId,
  placedSessions,
  liveSessions,
  expanded,
  sessionLists,
  sessionPages,
  onToggleExpanded,
  onLoadMoreSessions,
  onSelectTerminal,
  onImportSession,
  onAddWorkspace,
  onAddTerminal,
  onDeleteWorkspace,
  onDeleteTerminal,
  onRenameWorkspace,
  onRenameTerminal,
  onLogout,
  notify,
}: SidebarProps) {
  const { t } = useT();
  const isMobile = useMediaQuery(MOBILE_QUERY);
  const showTreeActions = useMediaQuery("(hover: none)");
  const [statsOpen, setStatsOpen] = useState(false);
  const hiddenMobileDrawer = isMobile && collapsed;
  return (
    <>
      {isMobile && !collapsed && (
        <button
          type="button"
          className="th-backdrop"
          aria-label={t("sidebar.collapse")}
          onClick={onToggleCollapse}
        />
      )}
      <aside
        className={`th-sidebar${collapsed ? " th-sidebar--collapsed" : ""}`}
        aria-hidden={hiddenMobileDrawer || undefined}
        {...(hiddenMobileDrawer ? { inert: "" } : {})}
      >
        <div className="th-sidebar-inner">
          <div className="th-sidebar-nav">
            <span className="th-sidebar-logo">
              <span className="th-sidebar-logo-dot" />
              {t("sidebar.nav.brand")}
            </span>
            <div className="th-sidebar-nav-actions">
              <button
                type="button"
                className="th-btn-icon"
                title={t("sidebar.addWorkspace")}
                onClick={onAddWorkspace}
              >
                <IconPlus size={15} />
              </button>
              {isMobile && (
                <button
                  type="button"
                  className="th-btn-icon"
                  title={t("sidebar.collapse")}
                  onClick={onToggleCollapse}
                >
                  <IconX size={15} />
                </button>
              )}
            </div>
          </div>

          <div className="th-sidebar-body">
            <div className="th-sidebar-section-label">{t("sidebar.title")}</div>
            <button type="button" className="th-btn-add" onClick={onAddWorkspace}>
              <IconPlus size={14} />
              {t("sidebar.addWorkspace")}
            </button>
            {workspaces.length === 0 ? (
              <div className="th-sidebar-empty">
                <span className="th-sidebar-empty-title">{t("sidebar.empty")}</span>
                <span className="th-sidebar-empty-hint">{t("sidebar.emptyHint")}</span>
              </div>
            ) : (
              <SessionTree
                workspaces={workspaces}
                touchActions={showTreeActions}
                activeTerminalId={activeTerminalId}
                placedSessions={placedSessions}
                liveSessions={liveSessions}
                expanded={expanded}
                sessionLists={sessionLists}
                sessionPages={sessionPages}
                onToggle={onToggleExpanded}
                onLoadMoreSessions={onLoadMoreSessions}
                onSelect={onSelectTerminal}
                onImport={onImportSession}
                onAddTerminal={onAddTerminal}
                onDeleteWorkspace={onDeleteWorkspace}
                onDeleteTerminal={onDeleteTerminal}
                onRenameWorkspace={onRenameWorkspace}
                onRenameTerminal={onRenameTerminal}
                notify={notify}
              />
            )}
          </div>

          <div className="th-sidebar-footer">
            <SettingsMenu onOpenStats={() => setStatsOpen(true)} />
            <div className="th-sidebar-footer-spacer" />
            <button
              type="button"
              className="th-btn-icon"
              title={t("sidebar.logout")}
              onClick={onLogout}
            >
              <IconLogOut size={15} />
            </button>
          </div>
        </div>

        <button
          type="button"
          className="th-sidebar-toggle"
          title={collapsed ? t("sidebar.expand") : t("sidebar.collapse")}
          aria-label={collapsed ? t("sidebar.expand") : t("sidebar.collapse")}
          onClick={onToggleCollapse}
        >
          <IconChevron size={13} />
        </button>
      </aside>
      <SystemStatsModal open={statsOpen} onClose={() => setStatsOpen(false)} />
    </>
  );
}
