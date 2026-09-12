import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../i18n";
import { SessionTree } from "./SessionTree";
import type { ToastKind } from "./SessionTree";
import { IconChevron, IconLogOut, IconPlus, IconX } from "./icons";
import { SettingsMenu } from "./SettingsMenu";
import { LiveSessionList } from "../features/workspace/LiveSessionList";
import { useMergedLiveSummaries } from "../features/workspace/liveBadgeStore";
import { useSessionOpenAttempts } from "../features/workspace/useSessionOpenAttempts";
import "../styles/sidebar-live.css";

/** Bounded retry cadence for union-membership crawls whose workspaces failed. */
export const MEMBERSHIP_MAX_RETRIES = 5;
export const MEMBERSHIP_RETRY_DELAY_MS = 2000;
/** Recency refresh cadence while the pinned section lists live sessions. */
export const LIVE_RECENCY_REFRESH_INTERVAL_MS = 15_000;
import { useLiveSessionSummaries } from "../features/workspace/useLiveSessionSummaries";
import { compareLiveSessions, isLiveSessionListed } from "../features/workspace/liveSessionOrder";
import { resolveWorkspaceSessionMembership } from "../features/workspace/workspace";
import type { Terminal, Workspace, WorkspaceSession } from "../features/workspace/workspace";
import type { WorkspaceSessionPaging } from "../features/workspace/useWorkspaces";
import { useMediaQuery } from "../lib/useMediaQuery";
import { SystemStatsModal } from "../features/system/SystemStatsModal";
import { EngineRestartDialog } from "../features/system/EngineRestartDialog";

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
  /** Re-fetches a workspace's first session page through the scheduled path,
   * keeping catalog recency fresh while live sessions are pinned. */
  readonly onRefreshSessions?: (wsId: string) => void;
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
  onRefreshSessions,
}: SidebarProps) {
  const { t } = useT();
  const isMobile = useMediaQuery(MOBILE_QUERY);
  const showTreeActions = useMediaQuery("(hover: none)");
  const [statsOpen, setStatsOpen] = useState(false);
  const [highlightedSessionId, setHighlightedSessionId] = useState<string | null>(null);
  const [engineRestartOpen, setEngineRestartOpen] = useState(false);
  const sessionOpen = useSessionOpenAttempts(onOpenSession);
  // The overview poller is shared with App's live-session poll; the sidebar
  // derives running-agent counts for the tree badges and the pinned
  // running-sessions section.
  // WS frames from the attached chat pane override the poll snapshot when they
  // are fresher (see liveBadgeStore); background sessions stay poll-fed.
  const pollSummaries = useLiveSessionSummaries(true);
  const summaries = useMergedLiveSummaries(pollSummaries);
  // Main work is independent of the exact child-agent counts.
  const activeSessions = useMemo(
    () => new Set(summaries.filter((summary) => summary.active === true).map((summary) => summary.id)),
    [summaries],
  );
  // Server scalars make every child running count exact.
  const runningCounts = useMemo(
    () => new Map(
      summaries
        .filter((s) => s.runningCount > 0)
        .map((s) => [s.id, s.runningCount]),
    ),
    [summaries],
  );
  // Pin main-only work too, without adding parents to child-agent totals.
  const runningSummaries = useMemo(
    () => summaries.filter((summary) => summary.active === true || summary.runningCount > 0),
    [summaries],
  );
  // The count next to the label means "how many are working": the exact
  // running-agent total across the working sessions, idle rows excluded.
  const totalRunningCount = useMemo(
    () => runningSummaries.reduce((total, summary) => total + summary.runningCount, 0),
    [runningSummaries],
  );
  // Last-activity ms per session id: catalog rows from the loaded session
  // pages, raised by whatever the membership crawl observed.
  const [crawlRecency, setCrawlRecency] = useState<ReadonlyMap<string, number>>(new Map());
  const lastActivityMs = useMemo(() => {
    const map = new Map<string, number>();
    for (const rows of sessionLists.values()) {
      for (const row of rows) map.set(row.id, Math.max(map.get(row.id) ?? 0, row.recencyMs));
    }
    for (const [id, recencyMs] of crawlRecency) {
      map.set(id, Math.max(map.get(id) ?? 0, recencyMs));
    }
    return map;
  }, [sessionLists, crawlRecency]);
  // The pinned section lists every live session, idle included: working
  // sessions first, then most recent activity.
  const liveSummaries = useMemo(
    () => summaries.filter(isLiveSessionListed).sort((a, b) => compareLiveSessions(a, b, lastActivityMs)),
    [summaries, lastActivityMs],
  );
  // View live only names the row to focus and sort first. The tree offers it
  // strictly for running sessions, so a highlight never fabricates a row; an
  // idle pinned row stays listed (every live session is listed) but loses its
  // running badge and highlight when both main and child work settle.
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
    const ids = new Set([...runningCounts.keys(), ...activeSessions]);
    for (const workspace of workspaces) {
      for (const chat of workspace.chats) ids.delete(chat.id);
      for (const session of sessionLists.get(workspace.id) ?? []) ids.delete(session.id);
      for (const id of resolvedRunningMembership.get(workspace.id) ?? []) ids.delete(id);
    }
    return ids;
  }, [resolvedRunningMembership, runningCounts, activeSessions, sessionLists, workspaces]);
  const membershipFingerprint = JSON.stringify([
    membershipGeneration,
    membershipRetry,
    [...workspaces].map((workspace) => workspace.id).sort(),
    [...unresolvedRunningIds].sort(),
  ]);  const aggregateSessionIds = useMemo(
    () => new Map([...resolvedRunningMembership].map(([wsId, ids]) => [
      wsId,
      new Set([...ids].filter((id) => runningCounts.has(id) || activeSessions.has(id))),
    ])),
    [resolvedRunningMembership, runningCounts, activeSessions],
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
      .then(({ memberships: resolved, recency, hadFailures }) => {
        if (activeMembershipCrawl.current !== crawl || controller.signal.aborted) return;
        setCrawlRecency((previous) => {
          const next = new Map(previous);
          for (const [id, recencyMs] of recency) {
            next.set(id, Math.max(next.get(id) ?? 0, recencyMs));
          }
          return next;
        });
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

  // Workspaces that own at least one currently live session.
  const liveOwnerWsIds = useMemo(() => {
    const owners = new Set<string>();
    if (summaries.length === 0) return owners;
    const liveIds = new Set(summaries.map((summary) => summary.id));
    for (const workspace of workspaces) {
      const owns = workspace.chats.some((chat) => liveIds.has(chat.id))
        || (sessionLists.get(workspace.id) ?? []).some((row) => liveIds.has(row.id))
        || [...(resolvedRunningMembership.get(workspace.id) ?? [])].some((id) => liveIds.has(id));
      if (owns) owners.add(workspace.id);
    }
    return owners;
  }, [summaries, workspaces, sessionLists, resolvedRunningMembership]);
  const liveOwnerWsIdsRef = useRef(liveOwnerWsIds);
  useEffect(() => {
    liveOwnerWsIdsRef.current = liveOwnerWsIds;
  }, [liveOwnerWsIds]);
  // Keep catalog recency fresh while any live session is pinned. The interval
  // keys off the boolean only so the 4s live poll cannot starve it; the ref
  // always holds the current owner set. Cleared on unmount.
  const hasLiveSessions = summaries.length > 0;
  useEffect(() => {
    if (onRefreshSessions === undefined || !hasLiveSessions) return;
    const timer = window.setInterval(() => {
      for (const wsId of liveOwnerWsIdsRef.current) onRefreshSessions(wsId);
    }, LIVE_RECENCY_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [onRefreshSessions, hasLiveSessions]);

  // The highlight names a running row; when that session's work settles the
  // row stays listed (idle rows are listed too) but the highlight clears.
  useEffect(() => {
    if (highlightedSessionId === null) return;
    const stillWorking = summaries.some((summary) => summary.id === highlightedSessionId
      && (summary.active === true || summary.runningCount > 0));
    if (!stillWorking) setHighlightedSessionId(null);
  }, [highlightedSessionId, summaries]);

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
                title={t("sidebar.addWorkspace")}
                onClick={onAddWorkspace}
              >
                <IconPlus size={15} />
              </button>
              {isMobile ? (
                <button
                  type="button"
                  className="th-btn-icon"
                  title={t("sidebar.collapse")}
                  onClick={onToggleCollapse}
                >
                  <IconX size={15} />
                </button>
              ) : (
                <button
                  type="button"
                  className="th-btn-icon th-sidebar-toggle"
                  title={t("sidebar.collapse")}
                  aria-label={t("sidebar.collapse")}
                  onClick={onToggleCollapse}
                >
                  <IconChevron size={15} />
                </button>
              )}
            </div>
          </div>

          {liveSummaries.length > 0 && (
            <div className="th-sidebar-live">
              <div className="th-sidebar-live-label">
                {t("sidebar.sessions")}
                <span className="th-sidebar-live-count" aria-label={t("overview.runningAria", { n: totalRunningCount })}>{totalRunningCount}</span>
              </div>
              <LiveSessionList
                summaries={liveSummaries}
                workspaces={workspaces}
                sessionLists={sessionLists}
                onSelect={onSelectTerminal}
                onOpen={sessionOpen.open}
                openAttempts={sessionOpen.attempts}
                focusedSessionId={highlightedSessionId}
                showLastLine={false}
                listClassName="th-sidebar-live-list"
                onActivated={() => setHighlightedSessionId(null)}
              />
            </div>
          )}

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
                activeSessions={activeSessions}
                aggregateSessionIds={aggregateSessionIds}
                expanded={expanded}
                sessionLists={sessionLists}
                sessionPages={sessionPages}
                onToggle={onToggleExpanded}
                onLoadMoreSessions={onLoadMoreSessions}
                onSelect={onSelectTerminal}
                onOpen={sessionOpen.open}
                openAttempts={sessionOpen.attempts}
                onViewLive={(sessionId) => setHighlightedSessionId(sessionId)}
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
            <SettingsMenu onOpenStats={() => setStatsOpen(true)} onOpenEngineRestart={() => setEngineRestartOpen(true)} />
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

        {collapsed && (
          <div className="th-sidebar-rail">
            <button
              type="button"
              className="th-sidebar-toggle"
              title={t("sidebar.expand")}
              aria-label={t("sidebar.expand")}
              onClick={onToggleCollapse}
            >
              <IconChevron size={13} />
            </button>
          </div>
        )}
      </aside>
      <SystemStatsModal open={statsOpen} onClose={() => setStatsOpen(false)} />
      <EngineRestartDialog
        open={engineRestartOpen}
        onClose={() => setEngineRestartOpen(false)}
        runningChats={runningCounts.size}
      />
    </>
  );
}
