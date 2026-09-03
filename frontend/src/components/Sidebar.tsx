import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../i18n";
import { SessionTree } from "./SessionTree";
import type { ToastKind } from "./SessionTree";
import { IconChevron, IconActivity, IconLogOut, IconPlus, IconX } from "./icons";
import { SettingsMenu } from "./SettingsMenu";
import { OverviewPanel } from "../features/workspace/OverviewPanel";
import { useMergedLiveSummaries } from "../features/workspace/liveBadgeStore";

/** Bounded retry cadence for union-membership crawls whose workspaces failed. */
export const MEMBERSHIP_MAX_RETRIES = 5;
export const MEMBERSHIP_RETRY_DELAY_MS = 2000;
import { useLiveSessionSummaries } from "../features/workspace/useLiveSessionSummaries";
import { resolveWorkspaceSessionMembership } from "../features/workspace/workspace";
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
  readonly onOpenSession: (ws: Workspace, session: WorkspaceSession, force?: boolean) => Promise<"opened" | "session-active" | void>;
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
  onOpenSession,
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
  const [overviewOpen, setOverviewOpen] = useState(false);
  // The overview poller is shared with App's live-session poll; the sidebar
  // derives running-agent counts for the tree badges and the overview panel.
  // WS frames from the attached chat pane override the poll snapshot when they
  // are fresher (see liveBadgeStore); background sessions stay poll-fed.
  const pollSummaries = useLiveSessionSummaries(true);
  const summaries = useMergedLiveSummaries(pollSummaries);
  const runningCounts = useMemo(
    () => new Map(
      summaries
        .filter((s) => s.runningCount > 0 || s.taskOversized || s.dagOversized)
        .map((s) => [s.id, {
          count: s.runningCount,
          partial: s.truncatedTasks && !s.taskOversized && !s.dagOversized,
          unknown: s.taskOversized || s.dagOversized,
        }]),
    ),
    [summaries],
  );
  const [resolvedRunningMembership, setResolvedRunningMembership] =
    useState<ReadonlyMap<string, ReadonlySet<string>>>(new Map());
  const [membershipGeneration, setMembershipGeneration] = useState(0);
  const membershipGenerationRef = useRef(0);
  const [membershipRetry, setMembershipRetry] = useState(0);
  const membershipRetryTimer = useRef<number | undefined>(undefined);
  const previousSessionLists = useRef(sessionLists);
  const activeMembershipCrawl = useRef<{
    readonly fingerprint: string;
    readonly controller: AbortController;
  }>();

  // Session-list replacement is the canonical mutation/refresh signal. Scope
  // positive crawl results to that generation so deleted cursor-only chats
  // cannot remain attributed from an older snapshot.
  useEffect(() => {
    if (previousSessionLists.current === sessionLists) return;
    previousSessionLists.current = sessionLists;
    setResolvedRunningMembership(new Map());
    setMembershipGeneration((generation) => {
      const next = generation + 1;
      membershipGenerationRef.current = next;
      return next;
    });
    setMembershipRetry(0);
    if (membershipRetryTimer.current !== undefined) {
      window.clearTimeout(membershipRetryTimer.current);
      membershipRetryTimer.current = undefined;
    }
  }, [sessionLists]);

  const unresolvedRunningIds = useMemo(() => {
    const ids = new Set(runningCounts.keys());
    for (const workspace of workspaces) {
      for (const chat of workspace.chats) ids.delete(chat.id);
      for (const session of sessionLists.get(workspace.id) ?? []) ids.delete(session.id);
      for (const id of resolvedRunningMembership.get(workspace.id) ?? []) ids.delete(id);
    }
    return ids;
  }, [resolvedRunningMembership, runningCounts, sessionLists, workspaces]);
  const membershipFingerprint = JSON.stringify([
    membershipGeneration,
    membershipRetry,
    [...workspaces].map((workspace) => workspace.id).sort(),
    [...unresolvedRunningIds].sort(),
  ]);  const aggregateSessionIds = useMemo(
    () => new Map([...resolvedRunningMembership].map(([wsId, ids]) => [
      wsId,
      new Set([...ids].filter((id) => runningCounts.has(id))),
    ])),
    [resolvedRunningMembership, runningCounts],
  );

  useEffect(() => {
    if (unresolvedRunningIds.size === 0) {
      activeMembershipCrawl.current?.controller.abort();
      activeMembershipCrawl.current = undefined;
      return;
    }
    if (activeMembershipCrawl.current?.fingerprint === membershipFingerprint) return;
    activeMembershipCrawl.current?.controller.abort();
    const controller = new AbortController();
    const crawl = { fingerprint: membershipFingerprint, controller };
    activeMembershipCrawl.current = crawl;
    void resolveWorkspaceSessionMembership(workspaces, unresolvedRunningIds, controller.signal)
      .then(({ memberships: resolved, hadFailures }) => {
        if (activeMembershipCrawl.current !== crawl || controller.signal.aborted) return;
        setResolvedRunningMembership((previous) => {
          const next = new Map(previous);
          for (const [wsId, ids] of resolved) {
            next.set(wsId, new Set([...(next.get(wsId) ?? []), ...ids]));
          }
          return next;
        });
        // A failed workspace leaves its IDs unresolved without changing the
        // fingerprint, so nothing would retrigger the crawl. Schedule a
        // bounded retry tick; the tick participates in the fingerprint via
        // the retry state below.
        if (hadFailures && membershipRetry < MEMBERSHIP_MAX_RETRIES) {
          // Exactly one pending retry timer: a newer crawl supersedes the
          // older timer, and the callback is inert once its generation is
          // no longer current.
          if (membershipRetryTimer.current !== undefined) window.clearTimeout(membershipRetryTimer.current);
          const scheduledGeneration = membershipGenerationRef.current;
          membershipRetryTimer.current = window.setTimeout(() => {
            membershipRetryTimer.current = undefined;
            if (membershipGenerationRef.current !== scheduledGeneration) return;
            setMembershipRetry((retry) => retry + 1);
          }, MEMBERSHIP_RETRY_DELAY_MS);
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
      })
      .finally(() => {
        if (activeMembershipCrawl.current === crawl) activeMembershipCrawl.current = undefined;
      });
  }, [membershipFingerprint]);

  useEffect(() => () => {
    activeMembershipCrawl.current?.controller.abort();
    activeMembershipCrawl.current = undefined;
    if (membershipRetryTimer.current !== undefined) window.clearTimeout(membershipRetryTimer.current);
  }, []);

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
              <img className="th-sidebar-logo-icon" src="./icon-192.png" alt="" />
              {t("sidebar.nav.brand")}
            </span>
            <div className="th-sidebar-nav-actions">
              <button
                type="button"
                className="th-btn-icon"
                title={t("sidebar.overview")}
                aria-label={t("sidebar.overview")}
                onClick={() => setOverviewOpen(true)}
              >
                <IconActivity size={15} />
              </button>
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
                runningCounts={runningCounts}
                aggregateSessionIds={aggregateSessionIds}
                expanded={expanded}
                sessionLists={sessionLists}
                sessionPages={sessionPages}
                onToggle={onToggleExpanded}
                onLoadMoreSessions={onLoadMoreSessions}
                onSelect={onSelectTerminal}
                onOpen={onOpenSession}
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
      <OverviewPanel
        open={overviewOpen}
        onClose={() => setOverviewOpen(false)}
        summaries={summaries}
        workspaces={workspaces}
        sessionLists={sessionLists}
        onSelect={onSelectTerminal}
        onOpen={onOpenSession}
      />
    </>
  );
}
