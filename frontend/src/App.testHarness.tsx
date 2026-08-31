import { act, useCallback, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vitest";
import type { WorkspaceSessionPaging } from "./features/workspace/useWorkspaces";
import type {
  ChatSessionRef,
  ProviderDiscoveryState,
  ProviderStatus,
  Terminal,
  Workspace,
  WorkspaceSession,
} from "./features/workspace/workspace";

export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

export const emptyState = {
  workspaces: [] as Workspace[],
  splitEnabled: false,
  focusedSessionId: null as string | null,
  expanded: new Set<string>(),
  sessions: new Map<string, ChatSessionRef>(),
  sessionPages: new Map<string, WorkspaceSessionPaging>(),
  createdWorkspace: {
    id: "ws-created",
    name: "Created workspace",
    path: "/created",
    chats: [],
  } as Workspace,
  assignSession: vi.fn(),
  hasPane: vi.fn(() => true),
  createTerminal: vi.fn(),
  apiJson: vi.fn(),
  setUnauthorizedHandler: vi.fn(),
  checkAuth: vi.fn(),
  logout: vi.fn(),
};

export const authMock = { checkAuth: emptyState.checkAuth, logout: emptyState.logout };
export const apiMock = { apiJson: emptyState.apiJson, setUnauthorizedHandler: emptyState.setUnauthorizedHandler };
export const chatWsMock = { connectChat: vi.fn() };
export const paneTreeMock = {
  findLeaf: vi.fn(() => emptyState.focusedSessionId === null
    ? null
    : { kind: "leaf" as const, id: "pane-1", sessionId: emptyState.focusedSessionId }),
};
export const terminalMock = { createTerminal: emptyState.createTerminal };
export const chatPaneMock = {
  ChatPane: ({ chatSession }: { chatSession: ChatSessionRef }) => (
    <div data-testid="chat-pane" data-session-id={chatSession.id} />
  ),
};
export const useMediaQueryMock = {
  useMediaQuery: vi.fn((query: string) => query === "(min-width: 1024px)" && emptyState.splitEnabled),
};

export const useLayoutMock = {
  useLayout: () => ({
    root: { kind: "leaf" as const, sessionId: null },
    focusedPaneId: "pane-1",
    placed: new Set<string>(),
    focusSession: vi.fn(() => false),
    assignSession: emptyState.assignSession,
    focusPane: vi.fn(),
    split: vi.fn(),
    closePane: vi.fn(),
    changeRatio: vi.fn(),
    hasPane: emptyState.hasPane,
  }),
};

export const splitViewMock = {
  SplitView: ({ actions }: {
    actions: { onCreateTerminal: (paneId: string, wsId: string) => void };
  }) => (
    <div data-testid="split-view">
      <button type="button" onClick={() => actions.onCreateTerminal("pane-2", "ws-2")}>
        Add split chat
      </button>
    </div>
  ),
};

export const sidebarMock = {
  MOBILE_QUERY: "(max-width: 768px)",
  Sidebar: ({ collapsed, workspaces, sessionLists, onAddTerminal }: {
    collapsed: boolean;
    workspaces: readonly Workspace[];
    sessionLists: ReadonlyMap<string, readonly WorkspaceSession[]>;
    onAddTerminal: (workspace: Workspace) => void;
  }) => (
    <aside data-testid="sidebar" data-collapsed={String(collapsed)} data-workspaces={workspaces.length}>
      {workspaces.map((workspace) => (
        <div key={workspace.id}>
          <button type="button" onClick={() => onAddTerminal(workspace)}>
            Add chat {workspace.id}
          </button>
          {(sessionLists.get(workspace.id) ?? []).map((session) => (
            <span key={`${session.source}:${session.id}`} data-testid={`sidebar-session-${session.id}`}>
              {session.name}
            </span>
          ))}
        </div>
      ))}
    </aside>
  ),
};

export const workspaceWizardMock = {
  WorkspaceWizard: ({ open, onClose, onCreated }: {
    open: boolean;
    onClose: () => void;
    onCreated: (ws: Workspace) => void;
  }) => (
    open ? (
      <div data-testid="workspace-wizard">
        <button
          type="button"
          onClick={() => {
            onCreated(emptyState.createdWorkspace);
            onClose();
          }}
        >
          Create workspace
        </button>
        <button type="button" onClick={onClose}>Cancel workspace</button>
      </div>
    ) : null
  ),
};

export const newChatDialogMock = {
  NewChatDialog: ({ open, providerDiscovery, onRetryProviders, onClose }: {
    open: boolean;
    providerDiscovery: ProviderDiscoveryState;
    onRetryProviders: () => void;
    onClose: () => void;
  }) => (
    open ? (
      <div
        data-testid="new-chat-dialog"
        data-status={providerDiscovery.status}
        data-available={providerDiscovery.status === "loaded"
          ? String(providerDiscovery.providers.some((provider) => provider.id === "omo" && provider.available))
          : "false"}
      >
        <button type="button" onClick={onClose}>Cancel chat</button>
        <button type="button" onClick={onRetryProviders}>Retry providers</button>
      </div>
    ) : null
  ),
};

export const useWorkspacesMock = {
  useWorkspaces: () => {
    const [workspaces, setWorkspaces] = useState<readonly Workspace[]>(emptyState.workspaces);
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(
      () => new Set(emptyState.expanded),
    );
    const [sessions] = useState(() => new Map(emptyState.sessions));
    const [sessionLists, setSessionLists] = useState<ReadonlyMap<string, readonly WorkspaceSession[]>>(
      new Map(),
    );
    const [sessionPages] = useState<ReadonlyMap<string, WorkspaceSessionPaging>>(
      () => new Map(emptyState.sessionPages),
    );
    const load = useCallback(() => undefined, []);
    const addCreatedSession = useCallback((wsId: string, tm: Terminal) => {
      if (!sessionPages.get(wsId)?.ready) return;
      setSessionLists((previous) => {
        const next = new Map(previous);
        next.set(wsId, [
          { id: tm.id, name: tm.name, source: "stored", recencyMs: Date.now() },
          ...(previous.get(wsId) ?? []).filter((item) => item.id !== tm.id),
        ]);
        return next;
      });
    }, [sessionPages]);
    const toggleExpanded = useCallback(() => undefined, []);
    const noopAsync = useCallback(async () => undefined, []);
    return {
      workspaces,
      setWorkspaces,
      expanded,
      setExpanded,
      sessions,
      sessionLists,
      sessionPages,
      load,
      addCreatedSession,
      loadMoreSessions: noopAsync,
      toggleExpanded,
      handleDeleteWorkspace: noopAsync,
      handleDeleteTerminal: noopAsync,
      handleRenameWorkspace: noopAsync,
      handleRenameTerminal: noopAsync,
      handleChatName: () => undefined,
    };
  },
};

function installMatchMedia(mobile: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(max-width: 768px)" ? mobile : false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

export type AppEmptyStateMount = {
  readonly container: HTMLDivElement;
  readonly root: Root;
};

export function prepareAppEmptyState(): AppEmptyStateMount {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  installMatchMedia(true);
  emptyState.workspaces = [];
  emptyState.splitEnabled = false;
  emptyState.focusedSessionId = null;
  emptyState.expanded = new Set();
  emptyState.sessions = new Map();
  emptyState.sessionPages = new Map();
  emptyState.createdWorkspace = {
    id: "ws-created",
    name: "Created workspace",
    path: "/created",
    chats: [],
  };
  window.localStorage.setItem("th-lang", "en");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  emptyState.checkAuth.mockResolvedValue(true);
  emptyState.apiJson.mockImplementation(async (path: string) => {
    if (path === "/api/providers") {
      return [{ id: "omo", label: "omo", binary: "omo", available: true }] as readonly ProviderStatus[];
    }
    if (path === "/api/sessions/live") {
      return { sessions: [] as readonly string[] };
    }
    return [];
  });
  return { container, root };
}

export function teardownAppEmptyState(mount: AppEmptyStateMount): void {
  act(() => mount.root.unmount());
  mount.container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
}

export async function renderApp(root: Root, node: ReactElement): Promise<void> {
  await act(async () => {
    root.render(node);
  });
}
