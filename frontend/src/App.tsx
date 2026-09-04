import { useCallback, useEffect, useRef, useState } from "react";
import { I18nContext } from "./i18n";
import { useAppConfig } from "./app-config";
import { useMediaQuery } from "./lib/useMediaQuery";
import { checkAuth, logout } from "./features/auth/auth";
import { setUnauthorizedHandler } from "./lib/api";
import { LoginPage } from "./features/auth/LoginPage";
import { MOBILE_QUERY, Sidebar } from "./components/Sidebar";
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
import { useProviderDiscovery } from "./features/workspace/useProviderDiscovery";
import { useConfirm } from "./components/ConfirmDialog";
import { NewChatDialog } from "./components/NewChatDialog";
import { ChatEmptyState } from "./components/ChatEmptyState";

const SPLIT_QUERY = "(min-width: 1024px)";

const TOAST_DISMISS_MS = 2600;

interface Toast {
  readonly id: number;
  readonly msg: string;
  readonly kind: ToastKind;
}

interface NewChatTarget {
  readonly wsId: string;
  readonly paneId?: string;
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

  const toastId = useRef(0);
  const createChatInFlightRef = useRef(false);
  const notify = useCallback((msg: string, kind: ToastKind = "info") => {
    setToast({ id: ++toastId.current, msg, kind });
  }, []);
  const { confirm, dialog: confirmDialog } = useConfirm(t);
  const {
    workspaces, setWorkspaces, expanded, setExpanded, sessions,
    sessionLists, sessionPages, load, addCreatedSession, loadMoreSessions,
    ensureSessionsLoaded, markSessionUsed, toggleExpanded, handleDeleteWorkspace,
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

  const selectTerminal = (ws: Workspace, tm: Terminal): void => {
    setExpanded((prev) => new Set(prev).add(ws.id));
    // Opening a session is a recency event for both the sidebar and the picker.
    markSessionUsed(ws.id, tm.id);
    if (window.matchMedia(MOBILE_QUERY).matches) setSidebarCollapsed(true);
    if (!layout.focusSession(tm.id)) {
      layout.assignSession(layout.focusedPaneId, tm.id);
    }
  };

  const openDiscoveredSession = async (
    ws: Workspace,
    session: WorkspaceSession,
    force = false,
  ): Promise<"opened" | "session-active"> => {
    try {
      const result = await openWorkspaceSession(ws.id, session, force);
      if (result.state === "session-active") return result.state;
      const tm = result.chat;
      setWorkspaces((prev) =>
        prev.map((workspace) =>
          workspace.id === ws.id
            ? {
                ...workspace,
                chats: workspace.chats.some((chat) => chat.id === tm.id)
                  ? workspace.chats
                  : [...workspace.chats, tm],
              }
            : workspace,
        ),
      );
      addCreatedSession(ws.id, tm, session);
      selectTerminal(ws, tm);
      return "opened";
    } catch (error) {
      notify(t("toast.error"), "error");
      throw error;
    }
  };

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
        if (layout.hasPane(target.paneId)) layout.assignSession(target.paneId, tm.id);
      } else {
        layout.assignSession(layout.focusedPaneId, tm.id);
      }
      notify(t("toast.terminalAdded"), "success");
    } catch (error) {
      notify(t("toast.error"), "error");
    } finally {
      createChatInFlightRef.current = false;
    }
  }, [addCreatedSession, layout, notify, setExpanded, setWorkspaces, t]);

  const requestNewChat = useCallback((target: NewChatTarget): void => {
    if (createChatInFlightRef.current) return;
    if (omoAvailable(providerDiscovery)) {
      void createOmoChat(target);
      return;
    }
    setNewChatTarget(target);
  }, [createOmoChat, providerDiscovery]);

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
    onAssign: (paneId, tmId, wsId) => {
      layout.assignSession(paneId, tmId);
      if (wsId) markSessionUsed(wsId, tmId);
    },
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
            onOpenSession={openDiscoveredSession}
            onAddWorkspace={() => setWizardOpen(true)}
            onAddTerminal={(ws) => requestNewChat({ wsId: ws.id })}
            onDeleteWorkspace={(ws) => void handleDeleteWorkspace(ws)}
            onDeleteTerminal={(ws, tm) => void handleDeleteTerminal(ws, tm)}
            onRenameWorkspace={handleRenameWorkspace}
            onRenameTerminal={handleRenameTerminal}
            onLogout={() => void handleLogout()}
            notify={notify}
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
      )}
      {confirmDialog}
    </I18nContext.Provider>
  );
}
