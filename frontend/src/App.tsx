import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { I18nContext } from "./i18n";
import { useAppConfig } from "./app-config";
import { useMediaQuery } from "./lib/useMediaQuery";
import { checkAuth, logout } from "./features/auth/auth";
import { setUnauthorizedHandler } from "./lib/api";
import { LoginPage } from "./features/auth/LoginPage";
import { MOBILE_QUERY, Sidebar } from "./components/Sidebar";
import type { LiveRecencyShare } from "./components/Sidebar";
import type { ToastKind } from "./components/SessionTree";
import { WorkspaceWizard } from "./features/workspace/WorkspaceWizard";
import { ChatPane } from "./features/split/ChatPane";
import { connectChat } from "./lib/chatWs";
import { SplitView } from "./features/split/SplitView";
import type { SplitActions } from "./features/split/SplitView";
import { useLayout } from "./features/split/useLayout";
import { findLeaf } from "./features/split/paneTree";
import { createTerminal } from "./features/terminal/terminal";
import { openWorkspaceSession } from "./features/workspace/workspace";
import type {
  ProviderDiscoveryState,
  Terminal,
  Workspace,
  WorkspaceSession,
} from "./features/workspace/workspace";
import { useLiveSessions } from "./features/workspace/useLiveSessions";
import { useWorkspaces } from "./features/workspace/useWorkspaces";
import { sessionOpenAttemptKey, useSessionOpenAttempts } from "./features/workspace/useSessionOpenAttempts";
import { useProviderDiscovery } from "./features/workspace/useProviderDiscovery";
import { useConfirm } from "./components/ConfirmDialog";
import { NewChatDialog } from "./components/NewChatDialog";
import { SessionPicker } from "./features/split/SessionPicker";
import { ChatEmptyState } from "./components/ChatEmptyState";
import { SessionDraftProvider } from "./features/split/sessionDraft";
import { LiveSessionList } from "./features/workspace/LiveSessionList";
import { useLiveSessionSummaries } from "./features/workspace/useLiveSessionSummaries";
import { useMergedLiveSummaries } from "./features/workspace/liveBadgeStore";
import { compareLiveSessions, isLiveSessionListed } from "./features/workspace/liveSessionOrder";
import "./styles/home-live.css";

const SPLIT_QUERY = "(min-width: 1024px)";

const TOAST_DISMISS_MS = 2600;

function sameRecencyMap(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, ms] of a) if (b.get(id) !== ms) return false;
  return true;
}

function sameOwnerSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

interface Toast {
  readonly id: number;
  readonly msg: string;
  readonly kind: ToastKind;
}

interface NewChatTarget {
  readonly wsId: string;
  readonly paneId?: string;
  readonly generation?: number;
}

function omoAvailable(discovery: ProviderDiscoveryState): boolean {
  return discovery.status === "loaded"
    && discovery.providers.some((provider) => provider.id === "omo" && provider.available);
}

export function App() {
  const i18n = useAppConfig();
  const { t } = i18n;

  const [authed, setAuthed] = useState<boolean | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => window.matchMedia(MOBILE_QUERY).matches,
  );
  const [toast, setToast] = useState<Toast | null>(null);
  const splitEnabled = useMediaQuery(SPLIT_QUERY);
  const [newChatTarget, setNewChatTarget] = useState<NewChatTarget | null>(null);
  const { discovery: providerDiscovery, retry: retryProviders } = useProviderDiscovery(authed === true);

  const layout = useLayout(authed === true);

  const intentGeneration = useRef(0);
  const paneIntents = useRef(new Map<string, number>());
  const sessionIntents = useRef(new Map<string, number>());
  const toastId = useRef(0);
  const createChatInFlightRef = useRef(false);
  const notify = useCallback((msg: string, kind: ToastKind = "info") => {
    setToast({ id: ++toastId.current, msg, kind });
  }, []);
  const { confirm, dialog: confirmDialog } = useConfirm(t);
  const {
    workspaces, setWorkspaces, expanded, setExpanded, sessions,
    sessionLists, sessionPages, load, addCreatedSession, loadMoreSessions,
    ensureSessionsLoaded, setRecencyTargets, markSessionUsed, toggleExpanded, handleDeleteWorkspace,
    handleDeleteTerminal, handleRenameWorkspace, handleRenameTerminal,
    handleChatName,
  } = useWorkspaces({ notify, t, layout, confirm });

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), TOAST_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // Any 401 REST response or a confirmed-expired websocket upgrade flips the
  // app to the login page without a reload. Registered before the boot
  // checkAuth so the very first probe already routes through the handler.
  useEffect(() => {
    setUnauthorizedHandler(() => setAuthed(false));
    return () => setUnauthorizedHandler(undefined);
  }, []);

  useEffect(() => {
    void checkAuth().then((ok) => {
      setAuthed(ok);
      if (ok) void load();
    });
  }, [load]);

  const liveSessions = useLiveSessions(authed === true);

  const handleLogin = (): void => {
    setAuthed(true);
    void load();
  };

  const handleLogout = async (): Promise<void> => {
    try {
      await logout();
    } finally {
      setAuthed(false);
      setWorkspaces([]);
      setExpanded(new Set());
      setNewChatTarget(null);
    }
  };

  // The session shown in the focused pane (drives single mode + sidebar highlight).
  const focusedLeaf = findLeaf(layout.root, layout.focusedPaneId);
  const focusedSessionId =
    focusedLeaf && focusedLeaf.kind === "leaf" ? focusedLeaf.sessionId : null;
  const activeSession = focusedSessionId !== null ? sessions.get(focusedSessionId) : undefined;
  const defaultWorkspace = workspaces[0] ?? null;

  const captureTarget = (paneId = layout.focusedPaneId) => {
    const generation = ++intentGeneration.current;
    paneIntents.current.set(paneId, generation);
    return { paneId, generation };
  };
  const targetCurrent = (target: { readonly paneId: string; readonly generation: number }) =>
    layout.hasPane(target.paneId) && paneIntents.current.get(target.paneId) === target.generation;

  const selectTerminal = (ws: Workspace, tm: Terminal): void => {
    const target = captureTarget();
    sessionIntents.current.set(sessionOpenAttemptKey(ws.id, tm.id), target.generation);
    setExpanded((prev) => new Set(prev).add(ws.id));
    markSessionUsed(ws.id, tm.id);
    if (window.matchMedia(MOBILE_QUERY).matches) setSidebarCollapsed(true);
    layout.assignSession(target.paneId, tm.id);
  };

  const openSession = async (
    ws: Workspace,
    session: WorkspaceSession,
    force = false,
    paneId = layout.focusedPaneId,
  ): Promise<"opened" | "session-active"> => {
    const target = captureTarget(paneId);
    const sourceKey = sessionOpenAttemptKey(ws.id, session.id);
    sessionIntents.current.set(sourceKey, target.generation);
    layout.focusPane(target.paneId);
    try {
      // Stored union rows are already chat identities, even before ws.chats
      // contains them. Only discovered entries need the existing open request.
      const result = session.source === "stored"
        ? { state: "opened" as const, chat: ws.chats.find(chat => chat.id === session.id)
          ?? { id: session.id, name: session.name, provider: "omo" as const } }
        : await openWorkspaceSession(ws.id, session, force);
      if (result.state === "session-active") return result.state;
      const tm = result.chat;
      setWorkspaces((prev) => prev.map(workspace => workspace.id === ws.id
        ? { ...workspace, chats: workspace.chats.some(chat => chat.id === tm.id) ? workspace.chats : [...workspace.chats, tm] }
        : workspace));
      if (session.source === "discovered") addCreatedSession(ws.id, tm, session);
      const chatKey = sessionOpenAttemptKey(ws.id, tm.id);
      // Source intent protects concurrent opens before the canonical chat id
      // is known. Canonical intent also protects newer stored/alias placement
      // in another pane; per-pane generations alone cannot prevent that move.
      const latestSessionIntent = Math.max(sessionIntents.current.get(sourceKey) ?? 0, sessionIntents.current.get(chatKey) ?? 0);
      if (targetCurrent(target) && latestSessionIntent <= target.generation) {
        sessionIntents.current.set(chatKey, target.generation);
        setExpanded((prev) => new Set(prev).add(ws.id));
        markSessionUsed(ws.id, tm.id);
        layout.assignSession(target.paneId, tm.id, false);
        if (window.matchMedia(MOBILE_QUERY).matches) setSidebarCollapsed(true);
      }
      return "opened";
    } catch (error) {
      notify(t("toast.error"), "error");
      throw error;
    }
  };

  // The home empty state lists every live session - idle ones included, so
  // main-only work (active flag) appears here exactly as in the sidebar -
  // derived from the same shared poller and WS-override store, so this
  // consumer adds no network traffic. Cards activate through the same
  // select/open path the picker uses.
  const homePollSummaries = useLiveSessionSummaries(authed === true);
  const homeLiveSummaries = useMergedLiveSummaries(homePollSummaries);
  // Recency comes from the already-loaded catalog rows, raised by whatever
  // the sidebar's membership crawl learned and published; no extra fetch.
  const [liveShare, setLiveShare] = useState<LiveRecencyShare | null>(null);
  const liveShareRef = useRef<LiveRecencyShare | null>(null);
  const handleLiveRecencyChange = useCallback((share: LiveRecencyShare): void => {
    const previous = liveShareRef.current;
    if (previous !== null
      && sameRecencyMap(previous.recencyMs, share.recencyMs)
      && sameOwnerSet(previous.ownerWsIds, share.ownerWsIds)) return;
    liveShareRef.current = share;
    setLiveShare(share);
  }, []);
  const homeRecencyMs = useMemo(() => {
    const recency = new Map<string, number>();
    for (const listed of sessionLists.values()) {
      for (const session of listed) {
        recency.set(session.id, Math.max(recency.get(session.id) ?? 0, session.recencyMs));
      }
    }
    for (const [id, recencyMs] of liveShare?.recencyMs ?? []) {
      recency.set(id, Math.max(recency.get(id) ?? 0, recencyMs));
    }
    return recency;
  }, [sessionLists, liveShare]);
  const homeOrderedSummaries = useMemo(
    () => homeLiveSummaries.filter(isLiveSessionListed).sort((a, b) => compareLiveSessions(a, b, homeRecencyMs)),
    [homeLiveSummaries, homeRecencyMs],
  );
  const homeRunningCount = useMemo(
    () => homeOrderedSummaries.reduce((total, summary) => total + summary.runningCount, 0),
    [homeOrderedSummaries],
  );
  const homeSessionOpen = useSessionOpenAttempts(openSession);

  // Recency freshness: neither surface owns a timer. The sidebar publishes
  // the workspaces that own live sessions (resolved through its membership
  // crawl, catalog rows and chat lists), and the catalog scheduler in
  // useWorkspaces owns the single periodic cadence for exactly those
  // workspaces. Until the first publication arrives there is nothing to arm.
  // Tracks whether this effect has registered recency targets, so the
  // authentication-ended branch below clears exactly what it registered.
  const recencyRegisteredRef = useRef(false);
  useEffect(() => {
    if (authed !== true) {
      // Authentication ended (logout or the unauthorized handler): the hook
      // stays mounted on the login page, so explicitly clear the registered
      // targets - an empty list disarms the scheduler's cadence.
      if (recencyRegisteredRef.current) {
        recencyRegisteredRef.current = false;
        setRecencyTargets([]);
      }
      return;
    }
    if (liveShare === null) return;
    recencyRegisteredRef.current = true;
    setRecencyTargets([...liveShare.ownerWsIds]);
  }, [authed, liveShare, setRecencyTargets]);

  // The same live-session block the mobile empty state shows, offered to
  // SplitView so wide-layout empty panes render it above their session
  // picker instead of dropping the cards. Nothing renders when no session
  // is live.
  const homeRunningSessions = homeOrderedSummaries.length > 0 ? (
    <div className="th-home-live">
      <div className="th-home-live-label">
        {t("sidebar.sessions")}
        {homeRunningCount > 0 && (
          <span className="th-home-live-count" aria-label={t("overview.runningAria", { n: homeRunningCount })}>{homeRunningCount}</span>
        )}
      </div>
      <LiveSessionList
        summaries={homeOrderedSummaries}
        workspaces={workspaces}
        sessionLists={sessionLists}
        onSelect={selectTerminal}
        onOpen={homeSessionOpen.open}
        openAttempts={homeSessionOpen.attempts}
        showLastLine
        listClassName="th-home-live-list"
      />
    </div>
  ) : undefined;

  const createOmoChat = useCallback(async (target: NewChatTarget): Promise<void> => {
    if (createChatInFlightRef.current) return;
    createChatInFlightRef.current = true;
    setNewChatTarget(null);
    try {
      const tm = await createTerminal(target.wsId, "", "omo");
      setWorkspaces((prev) =>
        prev.map((workspace) =>
          workspace.id === target.wsId
            ? { ...workspace, chats: [...workspace.chats, tm] }
            : workspace,
        ),
      );
      addCreatedSession(target.wsId, tm);
      setExpanded((prev) => new Set(prev).add(target.wsId));
      if (target.paneId) {
        // A pane may close while the request is pending; the chat remains in the sidebar.
        if (layout.hasPane(target.paneId) && paneIntents.current.get(target.paneId) === target.generation) {
          layout.assignSession(target.paneId, tm.id, false);
          markSessionUsed(target.wsId, tm.id);
        }
      } else {
        layout.assignSession(layout.focusedPaneId, tm.id);
        markSessionUsed(target.wsId, tm.id);
      }
      notify(t("toast.terminalAdded"), "success");
    } catch (error) {
      notify(t("toast.error"), "error");
    } finally {
      createChatInFlightRef.current = false;
    }
  }, [addCreatedSession, layout, markSessionUsed, notify, setExpanded, setWorkspaces, t]);

  const requestNewChat = useCallback((target: NewChatTarget): void => {
    if (createChatInFlightRef.current) return;
    const captured = { ...target, ...captureTarget(target.paneId) };
    if (omoAvailable(providerDiscovery)) {
      void createOmoChat(captured);
      return;
    }
    setNewChatTarget(captured);
  }, [createOmoChat, providerDiscovery, layout.focusedPaneId]);

  useEffect(() => {
    if (!newChatTarget || !omoAvailable(providerDiscovery)) return;
    void createOmoChat(newChatTarget);
  }, [createOmoChat, newChatTarget, providerDiscovery]);

  const createTerminalInPane = useCallback((paneId: string, wsId: string) => {
    requestNewChat({ paneId, wsId });
  }, [requestNewChat]);

  const openNewChat = useCallback(() => {
    if (defaultWorkspace) requestNewChat({ wsId: defaultWorkspace.id });
  }, [defaultWorkspace, requestNewChat]);

  const splitActions: SplitActions = {
    onFocusPane: layout.focusPane,
    onOpenSession: (paneId, ws, session, force) => openSession(ws, session, force, paneId),
    onLoadMoreSessions: loadMoreSessions,
    onCreateTerminal: createTerminalInPane,
    onSplit: layout.split,
    onClosePane: layout.closePane,
    onRatioChange: layout.changeRatio,
    onOpenSidebar: () => setSidebarCollapsed(false),
    notify,
  };

  return (
    <I18nContext.Provider value={i18n}>
      {authed === false && (
        <LoginPage onLogin={handleLogin} />
      )}
      {authed === true && (
        <SessionDraftProvider sessions={sessions}>
        <div className="th-app">
          <Sidebar
            collapsed={sidebarCollapsed}
            onToggleCollapse={() => setSidebarCollapsed((v) => !v)}
            workspaces={workspaces}
            activeTerminalId={focusedSessionId}
            placedSessions={layout.placed}
            liveSessions={liveSessions}
            expanded={expanded}
            sessionLists={sessionLists}
            sessionPages={sessionPages}
            onToggleExpanded={toggleExpanded}
            onLoadMoreSessions={loadMoreSessions}
            onSelectTerminal={selectTerminal}
            onOpenSession={openSession}
            onAddWorkspace={() => setWizardOpen(true)}
            onAddTerminal={(ws) => requestNewChat({ wsId: ws.id })}
            onDeleteWorkspace={(ws) => void handleDeleteWorkspace(ws)}
            onDeleteTerminal={(ws, tm) => void handleDeleteTerminal(ws, tm)}
            onRenameWorkspace={handleRenameWorkspace}
            onRenameTerminal={handleRenameTerminal}
            onLogout={() => void handleLogout()}
            notify={notify}
            onLiveRecencyChange={handleLiveRecencyChange}
          />
          <main className="th-main">
            {toast && (
              <div key={toast.id} className={`th-toast th-toast--${toast.kind}`} role="status">
                {toast.msg}
              </div>
            )}
            {splitEnabled ? (
              <SplitView
                node={layout.root}
                workspaces={workspaces}
                placed={layout.placed}
                sessions={sessions}
                sessionLists={sessionLists}
                sessionPages={sessionPages}
                onEnsureSessions={ensureSessionsLoaded}
                focusedPaneId={layout.focusedPaneId}
                splitEnabled={splitEnabled}
                actions={splitActions}
                onChatName={handleChatName}
                runningSessions={homeRunningSessions}
              />
            ) : activeSession ? (
              <ChatPane
                key={activeSession.id}
                chatSession={activeSession}
                focused
                splitEnabled={false}
                onFocus={() => undefined}
                onSplit={() => undefined}
                onClose={() => activeSession && layout.unplaceSession(activeSession.id)}
                onOpenSidebar={() => setSidebarCollapsed(false)}
                onNewChat={() => requestNewChat({ paneId: layout.focusedPaneId, wsId: activeSession.wsId })}
                connect={connectChat}
                notify={notify}
                onChatName={(name) => handleChatName(activeSession.wsId, activeSession.id, name)}
              />
            ) : (
              <ChatEmptyState
                mobile={window.matchMedia(MOBILE_QUERY).matches}
                workspaces={workspaces}
                onOpenSidebar={() => setSidebarCollapsed(false)}
                onNewWorkspace={() => setWizardOpen(true)}
                onNewChat={openNewChat}
                runningSessions={homeRunningSessions}
                sessionPicker={workspaces.length > 0 ? (
                  <SessionPicker workspaces={workspaces} sessionLists={sessionLists} sessionPages={sessionPages}
                    onEnsureSessions={ensureSessionsLoaded} onLoadMoreSessions={loadMoreSessions}
                    onOpenSession={openSession} onNewChat={wsId => requestNewChat({ wsId })} />
                ) : undefined}
              />
            )}
          </main>
          <NewChatDialog
            open={newChatTarget !== null}
            providerDiscovery={providerDiscovery}
            onRetryProviders={retryProviders}
            onClose={() => setNewChatTarget(null)}
          />
          <WorkspaceWizard
            open={wizardOpen}
            onClose={() => setWizardOpen(false)}
            onCreated={(ws) => {
              setWorkspaces((prev) => [...prev, ws]);
              setExpanded((prev) => new Set(prev).add(ws.id));
              notify(t("toast.workspaceAdded"), "success");
            }}
          />
        </div>
        </SessionDraftProvider>
      )}
      {confirmDialog}
    </I18nContext.Provider>
  );
}
