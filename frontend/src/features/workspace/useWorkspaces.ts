import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ToastKind } from "../../components/SessionTree";
import type { Translate } from "../../i18n";
import type { LayoutApi } from "../split/useLayout";
import { deleteTerminal, renameTerminal } from "../terminal/terminal";
import { deleteWorkspace, listWorkspaceSessions, listWorkspaces, renameWorkspace } from "./workspace";
import type { ChatSessionRef, Terminal, Workspace, WorkspaceSession } from "./workspace";
import type { ConfirmOptions } from "../../components/ConfirmDialog";

type Notify = (msg: string, kind?: ToastKind) => void;

export interface UseWorkspacesOptions {
  readonly notify: Notify;
  readonly t: Translate;
  readonly layout: LayoutApi;
  readonly confirm: (opts: ConfirmOptions) => Promise<boolean>;
}

/** Per-workspace session-history pagination state for the sidebar tree. */
export interface WorkspaceSessionPaging {
  /** The first page has been applied to the workspace's chat list. */
  readonly ready: boolean;
  /** A page fetch is currently in flight. */
  readonly loading: boolean;
  /** The backend reported another page beyond the loaded ones. */
  readonly hasMore: boolean;
  /** Cursor for the next page; empty once the last page has loaded. */
  readonly nextCursor: string;
}

export interface UseWorkspacesResult {
  readonly workspaces: readonly Workspace[];
  readonly setWorkspaces: Dispatch<SetStateAction<readonly Workspace[]>>;
  readonly expanded: ReadonlySet<string>;
  readonly setExpanded: Dispatch<SetStateAction<ReadonlySet<string>>>;
  readonly sessions: ReadonlyMap<string, ChatSessionRef>;
  readonly sessionLists: ReadonlyMap<string, readonly WorkspaceSession[]>;
  readonly sessionPages: ReadonlyMap<string, WorkspaceSessionPaging>;
  readonly load: () => Promise<void>;
  readonly addCreatedSession: (wsId: string, tm: Terminal, inPlaceSource?: WorkspaceSession) => void;
  readonly loadMoreSessions: (wsId: string) => Promise<void>;
  /** Kicks off the first session page for a workspace unless it is ready or already in flight. */
  readonly ensureSessionsLoaded: (wsId: string) => void;
  /** Hoists an opened session to the head of its workspace's session list (local state only). */
  readonly markSessionUsed: (wsId: string, id: string) => void;
  readonly toggleExpanded: (wsId: string) => void;
  readonly handleDeleteWorkspace: (ws: Workspace) => Promise<void>;
  readonly handleDeleteTerminal: (ws: Workspace, tm: Terminal) => Promise<void>;
  readonly handleRenameWorkspace: (ws: Workspace, name: string) => Promise<void>;
  readonly handleRenameTerminal: (ws: Workspace, tm: Terminal, name: string) => Promise<void>;
  readonly handleChatName: (wsId: string, chatId: string, name: string) => void;
}

export function applyChatNameToWorkspaces(
  workspaces: readonly Workspace[],
  wsId: string,
  chatId: string,
  name: string,
): readonly Workspace[] {
  return workspaces.map((workspace) =>
    workspace.id === wsId
      ? { ...workspace, chats: workspace.chats.map((chat) => (chat.id === chatId ? { ...chat, name } : chat)) }
      : workspace,
  );
}

// Observed engine behavior: a freshly written session is held out of the
// discovered catalog behind a short stabilization window, so a ready first
// page can be missing a session that only becomes visible shortly after.
// Once a page becomes ready, schedule exactly one refetch past that horizon;
// the scheduled refresh never re-arms itself, so the picker never turns into
// a polling loop.
export const CATALOG_REFRESH_DELAY_MS = 120_000;

const WORKSPACE_EXPANDED_STORAGE_KEY = "th-ws-expanded";

function readExpandedWorkspaces(): ReadonlySet<string> {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(WORKSPACE_EXPANDED_STORAGE_KEY) ?? "null");
    return new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function persistExpandedWorkspaces(expanded: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(WORKSPACE_EXPANDED_STORAGE_KEY, JSON.stringify([...expanded]));
  } catch {
    // Private modes may throw; the choice simply will not persist.
  }
}

export function useWorkspaces({ notify, t, layout, confirm }: UseWorkspacesOptions): UseWorkspacesResult {
  const [workspaces, setWorkspaces] = useState<readonly Workspace[]>([]);
  const [expanded, setExpandedState] = useState<ReadonlySet<string>>(readExpandedWorkspaces);
  const setExpanded: Dispatch<SetStateAction<ReadonlySet<string>>> = useCallback((update) => {
    setExpandedState((previous) => {
      const next = typeof update === "function" ? update(previous) : update;
      persistExpandedWorkspaces(next);
      return next;
    });
  }, []);
  const sessionListsRef = useRef<ReadonlyMap<string, readonly WorkspaceSession[]>>(new Map());
  const [sessionLists, setSessionLists] = useState<ReadonlyMap<string, readonly WorkspaceSession[]>>(
    sessionListsRef.current,
  );
  // Ref mirror lets fetch guards and continuation decisions read the latest
  // paging without waiting for a render commit.
  const sessionPagesRef = useRef<ReadonlyMap<string, WorkspaceSessionPaging>>(new Map());
  const [sessionPages, setSessionPages] = useState<ReadonlyMap<string, WorkspaceSessionPaging>>(sessionPagesRef.current);
  // Creations can race an older first-page snapshot. Keep them separate until
  // that snapshot is applied so they remain ahead of its continuation cursor.
  const pendingCreatedSessionsRef = useRef<Map<string, readonly WorkspaceSession[]>>(new Map());
  // The catalog's stored row has a web chat id while its discovered source has
  // the durable id/path. Retain that binding across canonical page refreshes
  // so a stale server page cannot briefly project both rows.
  const inPlaceBindingsRef = useRef<Map<string, Map<string, { readonly chatId: string; readonly path: string }>>>(new Map());

  // Observed engine behavior: a recorded durable id is authoritative — the
  // same resume path under a different id is a distinct replacement session
  // that must stay visible. The fold therefore matches the exact source
  // identity and falls back to the path only when the adopted source recorded
  // no durable id at all.
  const suppressBoundSources = (wsId: string, items: readonly WorkspaceSession[]): readonly WorkspaceSession[] => {
    const bindings = inPlaceBindingsRef.current.get(wsId);
    if (!bindings) return items;
    return items.filter((item) => item.source !== "discovered"
      || ![...bindings.entries()].some(([durableId, binding]) =>
        durableId !== ""
          ? item.id === durableId
          : binding.path !== "" && item.resumeIdentity === binding.path));
  };

  // One armed eventual refresh per workspace: a bound timer means the ready
  // first page still owes its single post-stabilization refetch.
  const catalogRefreshTimersRef = useRef<Map<string, number>>(new Map());
  // A stale refresh whose timer fired while another page was loading is
  // deferred here (never dropped) and rerun once that load settles.
  const pendingStaleRefreshRef = useRef<Set<string>>(new Set());

  const disarmCatalogRefresh = useCallback((wsId: string): void => {
    const timer = catalogRefreshTimersRef.current.get(wsId);
    if (timer !== undefined) {
      catalogRefreshTimersRef.current.delete(wsId);
      window.clearTimeout(timer);
    }
    pendingStaleRefreshRef.current.delete(wsId);
  }, []);

  const disarmAllCatalogRefreshes = useCallback((): void => {
    for (const timer of catalogRefreshTimersRef.current.values()) window.clearTimeout(timer);
    catalogRefreshTimersRef.current.clear();
    pendingStaleRefreshRef.current.clear();
  }, []);

  const removePendingCreatedSession = (wsId: string, chatId: string): void => {
    const pending = pendingCreatedSessionsRef.current.get(wsId);
    if (!pending) return;
    const remaining = pending.filter((item) => item.id !== chatId);
    if (remaining.length === 0) pendingCreatedSessionsRef.current.delete(wsId);
    else pendingCreatedSessionsRef.current.set(wsId, remaining);
  };

  const renamePendingCreatedSession = (wsId: string, chatId: string, name: string): void => {
    const pending = pendingCreatedSessionsRef.current.get(wsId);
    if (!pending) return;
    pendingCreatedSessionsRef.current.set(
      wsId,
      pending.map((item) => (item.id === chatId ? { ...item, name } : item)),
    );
  };

  const replaceSessionLists = useCallback(
    (next: ReadonlyMap<string, readonly WorkspaceSession[]>): void => {
      sessionListsRef.current = next;
      setSessionLists(next);
    },
    [],
  );

  const replaceSessionPages = useCallback((next: ReadonlyMap<string, WorkspaceSessionPaging>): void => {
    sessionPagesRef.current = next;
    setSessionPages(next);
  }, []);

  const patchSessionPaging = useCallback(
    (wsId: string, paging: WorkspaceSessionPaging): void => {
      const next = new Map(sessionPagesRef.current);
      next.set(wsId, paging);
      replaceSessionPages(next);
    },
    [replaceSessionPages],
  );

  const fetchSessionPage: (wsId: string, cursor: string, append: boolean, scheduled?: boolean) => Promise<void> = useCallback(
    async (wsId, cursor, append, scheduled = false): Promise<void> => {
      const before = sessionPagesRef.current.get(wsId);
      if (before?.loading) {
        // A stale refresh landing mid-load is queued, not dropped: it reruns
        // right after the in-flight page settles.
        if (scheduled) pendingStaleRefreshRef.current.add(wsId);
        return;
      }
      patchSessionPaging(wsId, {
        ready: before?.ready ?? false,
        loading: true,
        hasMore: before?.hasMore ?? false,
        nextCursor: cursor,
      });
      try {
        const page = await listWorkspaceSessions(wsId, cursor);
        const canonicalItems = suppressBoundSources(wsId, page.items);
        const previousItems = sessionListsRef.current.get(wsId) ?? [];
        const pendingCreated = append ? [] : (pendingCreatedSessionsRef.current.get(wsId) ?? []);
        const leadingItems = append ? previousItems : pendingCreated;
        const fresh = canonicalItems.filter((item) => !leadingItems.some((listed) => listed.id === item.id));
        // A stale page-one refresh must not discard already-loaded
        // continuation rows: retain anything previously listed that the fresh
        // page did not return. A later load-more re-requests those pages and
        // dedupes against them.
        const retained = append
          ? []
          : previousItems.filter((item) =>
              !fresh.some((freshItem) => freshItem.id === item.id)
              && !leadingItems.some((listed) => listed.id === item.id));
        const items = [...leadingItems, ...fresh, ...retained];
        const nextLists = new Map(sessionListsRef.current);
        nextLists.set(wsId, items);
        replaceSessionLists(nextLists);
        if (!append) pendingCreatedSessionsRef.current.delete(wsId);
        patchSessionPaging(wsId, {
          ready: true,
          loading: false,
          hasMore: page.nextCursor !== "",
          nextCursor: page.nextCursor,
        });
        if (!append && !scheduled) {
          disarmCatalogRefresh(wsId);
          // One bounded refresh per staleness signal: arm exactly once per
          // first-page readiness; the scheduled pass below never re-arms.
          const timer = window.setTimeout(() => {
            catalogRefreshTimersRef.current.delete(wsId);
            void fetchSessionPage(wsId, "", false, true);
          }, CATALOG_REFRESH_DELAY_MS);
          catalogRefreshTimersRef.current.set(wsId, timer);
        }
        if (pendingStaleRefreshRef.current.delete(wsId)) {
          void fetchSessionPage(wsId, "", false, true);
        }
      } catch {
        // Restore the pre-fetch state so a failed page can be retried.
        patchSessionPaging(wsId, {
          ready: before?.ready ?? false,
          loading: false,
          hasMore: before?.hasMore ?? false,
          nextCursor: before?.nextCursor ?? "",
        });
        if (pendingStaleRefreshRef.current.delete(wsId)) {
          void fetchSessionPage(wsId, "", false, true);
        }
      }
    },
    [disarmCatalogRefresh, patchSessionPaging, replaceSessionLists],
  );

  // Pending eventual refreshes die with the hook.
  useEffect(() => () => disarmAllCatalogRefreshes(), [disarmAllCatalogRefreshes]);

  const load = useCallback(async (): Promise<void> => {
    try {
      const loadedWorkspaces = await listWorkspaces();
      setWorkspaces(loadedWorkspaces);
      const loadedIds = new Set(loadedWorkspaces.map((workspace) => workspace.id));
      setExpanded((previous) => new Set([...previous].filter((id) => loadedIds.has(id))));
      // A fresh canonical list invalidates the independently paged sidebar view.
      disarmAllCatalogRefreshes();
      replaceSessionLists(new Map());
      replaceSessionPages(new Map());
    } catch {
      /* transient failure — tree stays empty until next mutation */
    }
  }, [disarmAllCatalogRefreshes, replaceSessionLists, replaceSessionPages, setExpanded]);

  // The first page loads whenever a loaded workspace becomes expanded,
  // whichever action (chevron toggle, session select, chat creation) expanded it.
  useEffect(() => {
    for (const workspace of workspaces) {
      if (!expanded.has(workspace.id)) continue;
      const paging = sessionPagesRef.current.get(workspace.id);
      if (!paging?.ready && !paging?.loading) void fetchSessionPage(workspace.id, "", false);
    }
  }, [expanded, fetchSessionPage, workspaces]);

  const addCreatedSession = useCallback((wsId: string, tm: Terminal, inPlaceSource?: WorkspaceSession): void => {
    if (inPlaceSource !== undefined) {
      const bindings = new Map(inPlaceBindingsRef.current.get(wsId));
      bindings.set(inPlaceSource.id, { chatId: tm.id, path: inPlaceSource.resumeIdentity ?? "" });
      inPlaceBindingsRef.current.set(wsId, bindings);
    }
    const created = { id: tm.id, name: tm.name, source: "stored" as const, recencyMs: Date.now() };
    const mergeCreated = (items: readonly WorkspaceSession[]): readonly WorkspaceSession[] => [
      created,
      ...suppressBoundSources(wsId, items).filter((item) => item.id !== tm.id),
    ];
    if (!sessionPagesRef.current.get(wsId)?.ready) {
      const pending = pendingCreatedSessionsRef.current.get(wsId) ?? [];
      pendingCreatedSessionsRef.current.set(wsId, mergeCreated(pending));
      return;
    }
    const listed = sessionListsRef.current.get(wsId) ?? [];
    const next = new Map(sessionListsRef.current);
    next.set(wsId, mergeCreated(listed));
    replaceSessionLists(next);
  }, [replaceSessionLists]);

  const loadMoreSessions = async (wsId: string): Promise<void> => {
    const paging = sessionPagesRef.current.get(wsId);
    if (!paging || !paging.ready || paging.loading || !paging.hasMore) return;
    await fetchSessionPage(wsId, paging.nextCursor, true);
  };

  // The empty-pane picker renders from the same paged source as the sidebar.
  // Mirrors the expand-effect guard so repeated calls (re-renders, workspace
  // switches) can never loop: ready or in-flight pages are left alone.
  const ensureSessionsLoaded = useCallback(
    (wsId: string): void => {
      const paging = sessionPagesRef.current.get(wsId);
      if (paging?.ready || paging?.loading) return;
      void fetchSessionPage(wsId, "", false);
    },
    [fetchSessionPage],
  );

  // Opening a session is a recency event: hoist it to the head of its
  // workspace's session list with the same dedupe semantics as creations.
  // Purely local state — the server already keeps both lists MRU-sorted.
  const markSessionUsed = useCallback(
    (wsId: string, id: string): void => {
      const listed = sessionListsRef.current.get(wsId);
      if (!listed) return;
      const entry = listed.find((item) => item.id === id);
      if (!entry) return;
      const next = new Map(sessionListsRef.current);
      next.set(wsId, [entry, ...listed.filter((item) => item.id !== id)]);
      replaceSessionLists(next);
    },
    [replaceSessionLists],
  );

  const sessions = useMemo(() => {
    const map = new Map<string, ChatSessionRef>();
    for (const ws of workspaces) {
      for (const tm of ws.chats) {
        map.set(tm.id, {
          id: tm.id,
          name: tm.name,
          wsId: ws.id,
          cwd: ws.path,
          provider: tm.provider,
        });
      }
      // v2 union rows: chats the sessions REST lists but the legacy chat list
      // does not carry. Register them so activation opens the same pane flow.
      for (const item of sessionLists.get(ws.id) ?? []) {
        if (item.source !== "stored" || item.dangling === true || map.has(item.id)) continue;
        map.set(item.id, {
          id: item.id,
          name: item.name,
          wsId: ws.id,
          cwd: ws.path,
          provider: "omo",
        });
      }
    }
    return map;
  }, [workspaces, sessionLists]);

  const toggleExpanded = (wsId: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(wsId)) next.delete(wsId);
      else next.add(wsId);
      return next;
    });
  };

  const handleDeleteWorkspace = async (ws: Workspace): Promise<void> => {
    const ok = await confirm({
      title: t("sidebar.ws.delete"),
      message: t("sidebar.confirmDeleteWs", { name: ws.name }),
      confirmLabel: t("sidebar.ws.delete"),
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteWorkspace(ws.id);
      for (const tm of ws.chats) layout.unplaceSession(tm.id);
      setWorkspaces((prev) => prev.filter((w) => w.id !== ws.id));
      setExpanded((previous) => {
        const next = new Set(previous);
        next.delete(ws.id);
        return next;
      });
      if (sessionListsRef.current.has(ws.id)) {
        const next = new Map(sessionListsRef.current);
        next.delete(ws.id);
        replaceSessionLists(next);
      }
      if (sessionPagesRef.current.has(ws.id)) {
        const next = new Map(sessionPagesRef.current);
        next.delete(ws.id);
        replaceSessionPages(next);
      }
      pendingCreatedSessionsRef.current.delete(ws.id);
      disarmCatalogRefresh(ws.id);
      inPlaceBindingsRef.current.delete(ws.id);
      notify(t("toast.workspaceDeleted"), "success");
    } catch {
      notify(t("toast.error"), "error");
    }
  };

  const handleDeleteTerminal = async (ws: Workspace, tm: Terminal): Promise<void> => {
    const ok = await confirm({
      title: t("sidebar.tm.delete"),
      message: t("sidebar.confirmDeleteTm", { name: tm.name }),
      confirmLabel: t("sidebar.tm.delete"),
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteTerminal(ws.id, tm.id);
      setWorkspaces((prev) =>
        prev.map((w) =>
          w.id === ws.id ? { ...w, chats: w.chats.filter((x) => x.id !== tm.id) } : w,
        ),
      );
      const listed = sessionListsRef.current.get(ws.id);
      if (listed) {
        const next = new Map(sessionListsRef.current);
        next.set(ws.id, listed.filter((item) => item.id !== tm.id));
        replaceSessionLists(next);
      }
      removePendingCreatedSession(ws.id, tm.id);
      const bindings = inPlaceBindingsRef.current.get(ws.id);
      if (bindings) {
        for (const [durableId, binding] of bindings) {
          if (binding.chatId === tm.id) bindings.delete(durableId);
        }
        if (bindings.size === 0) inPlaceBindingsRef.current.delete(ws.id);
      }
      layout.unplaceSession(tm.id);
      notify(t("toast.terminalDeleted"), "success");
    } catch {
      notify(t("toast.error"), "error");
    }
  };

  const handleRenameWorkspace = async (ws: Workspace, name: string): Promise<void> => {
    const updated = await renameWorkspace(ws.id, name);
    // Keep the loaded session pages: the patch response carries the full
    // stored chat list, which would silently discard the pagination.
    setWorkspaces((prev) => prev.map((w) => (w.id === updated.id ? { ...updated, chats: w.chats } : w)));
    notify(t("toast.workspaceRenamed"), "success");
  };

  const handleRenameTerminal = async (ws: Workspace, tm: Terminal, name: string): Promise<void> => {
    const updated = await renameTerminal(ws.id, tm.id, name);
    setWorkspaces((prev) =>
      prev.map((w) =>
        w.id === ws.id
          ? { ...w, chats: w.chats.map((x) => (x.id === updated.id ? updated : x)) }
          : w,
      ),
    );
    const listed = sessionListsRef.current.get(ws.id);
    if (listed) {
      const next = new Map(sessionListsRef.current);
      next.set(ws.id, listed.map((item) => (item.id === updated.id ? { ...item, name: updated.name } : item)));
      replaceSessionLists(next);
    }
    renamePendingCreatedSession(ws.id, updated.id, updated.name);
    notify(t("toast.terminalRenamed"), "success");
  };

  const handleChatName = (wsId: string, chatId: string, name: string): void => {
    setWorkspaces((prev) => applyChatNameToWorkspaces(prev, wsId, chatId, name));
    const listed = sessionListsRef.current.get(wsId);
    if (listed) {
      const next = new Map(sessionListsRef.current);
      next.set(wsId, listed.map((item) => (item.id === chatId ? { ...item, name } : item)));
      replaceSessionLists(next);
    }
    renamePendingCreatedSession(wsId, chatId, name);
  };

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
    loadMoreSessions,
    ensureSessionsLoaded,
    markSessionUsed,
    toggleExpanded,
    handleDeleteWorkspace,
    handleDeleteTerminal,
    handleRenameWorkspace,
    handleRenameTerminal,
    handleChatName,
  };
}
