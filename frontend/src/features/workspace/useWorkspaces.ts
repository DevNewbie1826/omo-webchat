import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ToastKind } from "../../components/SessionTree";
import type { Translate } from "../../i18n";
import type { LayoutApi } from "../split/useLayout";
import { deleteTerminal, renameTerminal } from "../terminal/terminal";
import { deleteWorkspace, listWorkspaceSessions, listWorkspaces, mergeWorkspaceSessions, renameWorkspace, touchWorkspaceSession } from "./workspace";
import type { ChatSessionRef, Terminal, Workspace, WorkspaceSession } from "./workspace";
import type { ConfirmOptions } from "../../components/ConfirmDialog";

type Notify = (msg: string, kind?: ToastKind) => void;

// Mutable reconciliation state, stable for one live workspace/chat incarnation.
type SessionRecency = {
  confirmedMs: number;
  pendingUse: { readonly recencyMs: number } | undefined;
  creationFallbackMs: number;
};

export interface UseWorkspacesOptions {
  readonly notify: Notify;
  readonly t: Translate;
  readonly layout: LayoutApi;
  readonly confirm: (opts: ConfirmOptions) => Promise<boolean>;
  /** Arms event-driven discovery. The hook itself cannot know authentication
   * state; App passes `authed === true` so an unauthenticated mount never
   * fetches. While enabled the hook adds the tab-visibility fallback and
   * honours `requestDiscovery`; it owns no periodic discovery timer. */
  readonly discoveryEnabled?: boolean;
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
  /** The last page request failed; cleared by the next explicit attempt. */
  readonly error?: boolean;
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
  readonly addCreatedSession: (wsId: string, tm: Terminal) => void;
  readonly loadMoreSessions: (wsId: string) => Promise<void>;
  /** Kicks off the first session page for a workspace unless it is ready or already in flight. */
  readonly ensureSessionsLoaded: (wsId: string) => void;
  /** Requests one additive discovery merge of the workspace catalog. The
   * caller is the live-session trigger: a live id the catalog does not own is
   * proof the catalog has a row this tab has not loaded yet. Stable identity;
   * a no-op while discovery is disabled, at most one merge runs at a time
   * (a request during flight coalesces into exactly one rerun), and a request
   * before the first `load()` settles is queued and run once it does. A merge
   * that failed or was discarded by the generation guard walks the bounded
   * retry ladder; a successful merge resets it. */
  readonly requestDiscovery: () => void;
  /** Declares the workspaces that currently own live sessions. The hook's
   * catalog scheduler owns the single periodic recency cadence and refreshes
   * exactly these workspaces through the scheduled fetch path. Passing equal
   * membership (even with a fresh array identity) leaves the armed timer
   * untouched; an empty list disarms it. */
  readonly setRecencyTargets: (wsIds: readonly string[]) => void;
  /** Records explicit activation, optimistically reorders, then applies server-owned recency. */
  readonly markSessionUsed: (wsId: string, id: string) => void;
  readonly toggleExpanded: (wsId: string) => void;
  readonly handleDeleteWorkspace: (ws: Workspace) => Promise<void>;
  readonly handleDeleteTerminal: (ws: Workspace, tm: Terminal) => Promise<void>;
  readonly handleRenameWorkspace: (ws: Workspace, name: string) => Promise<void>;
  readonly handleRenameTerminal: (ws: Workspace, tm: Terminal, name: string) => Promise<void>;
  readonly handleChatName: (wsId: string, chatId: string, name: string) => void;
}

/** Pure additive merge of one discovery response into a catalog snapshot: the
 * rows to keep plus the ids to expand and whose chat list grew. Strictly
 * additive and identity-preserving per row, so applying it through a
 * functional state update can never drop rows a newer merge committed. */
function mergeDiscoveredWorkspaces(
  current: readonly Workspace[],
  discovered: readonly Workspace[],
): {
  readonly workspaces: readonly Workspace[];
  readonly newlyExpanded: readonly string[];
  readonly chatGrew: readonly string[];
} {
  const currentById = new Map(current.map((workspace) => [workspace.id, workspace]));
  const next = [...current];
  const newlyExpanded: string[] = [];
  const chatGrew: string[] = [];
  for (const incoming of discovered) {
    const existing = currentById.get(incoming.id);
    if (existing === undefined) {
      next.push(incoming);
      // First sighting: expand so the enrolled chat rows are visible
      // without a click. Later ticks never fight the user's collapse.
      newlyExpanded.push(incoming.id);
      continue;
    }
    const knownChatIds = new Set(existing.chats.map((chat) => chat.id));
    const missingChats = incoming.chats.filter((chat) => !knownChatIds.has(chat.id));
    if (missingChats.length === 0) continue;
    next[next.findIndex((workspace) => workspace.id === existing.id)] = {
      ...existing,
      chats: [...existing.chats, ...missingChats],
    };
    chatGrew.push(existing.id);
  }
  return { workspaces: next, newlyExpanded, chatGrew };
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

// Cadence of the periodic recency refresh for workspaces that own live
// sessions. Owned here, by the catalog scheduler: consumers only declare
// which workspaces are live owners via setRecencyTargets, so live-tick
// render churn can never clear, postpone, or duplicate the timer.
export const RECENCY_REFRESH_INTERVAL_MS = 15_000;

// Discovery is event driven, not periodic: the server pushes a live frame
// (sessions.activity, or the 4s REST live tick while the socket is down) as
// soon as a session is enrolled, and a live id no loaded workspace owns means
// the catalog has a row this tab has not merged yet. App derives that id set
// from liveSessions minus workspaces[].chats[].id and calls requestDiscovery.
// No fixed cadence exists - an idle tab issues zero catalog requests.
//
// Fallback: regaining visibility performs one merge. It covers the only
// discoverable changes that emit no live frame - a chat or workspace created
// through REST on another tab or device and never run (no daemon session, so
// no push). Out-of-root sessions need no fallback: the server skips them for
// both the push and the catalog, so there is nothing to discover.
//
// Retry ladder for a merge whose fetch failed or whose response the generation
// guard discarded (a delete raced the fetch): bounded, reset by any success,
// because the removed interval used to be the only self-heal.
export const DISCOVERY_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000];

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

export function useWorkspaces({ notify, t, layout, confirm, discoveryEnabled = false }: UseWorkspacesOptions): UseWorkspacesResult {
  const [workspaces, setWorkspaces] = useState<readonly Workspace[]>([]);
  // Ref mirror for the discovery cycle's merge: interval callbacks must read
  // the latest committed list without waiting for a render.
  const workspacesRef = useRef<readonly Workspace[]>([]);
  workspacesRef.current = workspaces;
  const [expanded, setExpandedState] = useState<ReadonlySet<string>>(readExpandedWorkspaces);
  const setExpanded: Dispatch<SetStateAction<ReadonlySet<string>>> = useCallback((update) => {
    setExpandedState((previous) => {
      const next = typeof update === "function" ? update(previous) : update;
      persistExpandedWorkspaces(next);
      return next;
    });
  }, []);
  const pageRequestsRef = useRef(new Map<string, object>());
  const deletedSessionsRef = useRef(new Map<string, Set<string>>());
  const recenciesRef = useRef(new Map<string, Map<string, SessionRecency>>());
  const loadGenerationRef = useRef(0);
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

  // One armed eventual refresh per workspace: a bound timer means the ready
  // first page still owes its single post-stabilization refetch.
  const catalogRefreshTimersRef = useRef<Map<string, number>>(new Map());
  // A stale refresh whose timer fired while another page was loading is
  // deferred here (never dropped) and rerun once that load settles.
  const pendingStaleRefreshRef = useRef<Set<string>>(new Set());

  // Live-session recency ownership: the consumer declares target workspace
  // ids; the single interval below is the only periodic recency timer and is
  // never recreated by live-tick data changes.
  const recencyTargetsRef = useRef<ReadonlySet<string>>(new Set());
  const recencyTimerRef = useRef<number | undefined>(undefined);

  // Event-driven discovery bookkeeping: the enable gate, the first-load gate,
  // the in-flight/rerun pair, and the retry ladder. All of it dies with the
  // hook and with discoveryEnabled.
  const discoveryLiveRef = useRef(discoveryEnabled);
  const discoveryLoadedRef = useRef(false);
  const discoveryQueuedBeforeLoadRef = useRef(false);
  const discoveryInFlightRef = useRef(false);
  const discoveryRerunRef = useRef(false);
  const discoveryRetryCountRef = useRef(0);
  const discoveryRetryTimerRef = useRef<number | undefined>(undefined);
  // The gated entry point, re-read from a timer callback so the retry can
  // never bypass the single-flight gate it was armed behind.
  const discoveryStartRef = useRef<() => void>(() => undefined);
  // Canonical-load ladder: a failed load() leaves an empty tree that no live
  // frame will ever repopulate, so the load itself retries on the same bounded
  // cadence until it succeeds, is superseded, or the session ends.
  const loadRetryCountRef = useRef(0);
  const loadRetryTimerRef = useRef<number | undefined>(undefined);
  const loadRef = useRef<() => Promise<void>>(async () => undefined);

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
      const request = {};
      pageRequestsRef.current.set(wsId, request);
      patchSessionPaging(wsId, {
        ready: before?.ready ?? false,
        loading: true,
        hasMore: before?.hasMore ?? false,
        nextCursor: cursor,
      });
      try {
        const page = await listWorkspaceSessions(wsId, cursor);
        if (pageRequestsRef.current.get(wsId) !== request) return;
        const canonicalItems = page.items;
        for (const item of canonicalItems) {
          const recency = recenciesRef.current.get(wsId)?.get(item.id);
          if (recency) {
            recency.confirmedMs = Math.max(recency.confirmedMs, item.recencyMs);
            recency.creationFallbackMs = 0;
          }
        }
        // Retain loaded continuation rows, update overlaps, then sort the union.
        const items = mergeWorkspaceSessions([
          ...(sessionListsRef.current.get(wsId) ?? []),
          ...canonicalItems,
          ...(pendingCreatedSessionsRef.current.get(wsId) ?? []),
        ].filter(item => !deletedSessionsRef.current.get(wsId)?.has(item.id)).map(item => {
          const recency = recenciesRef.current.get(wsId)?.get(item.id);
          // Retire provisional row values before max-merging loaded snapshots.
          return recency ? {
            ...item,
            recencyMs: Math.max(recency.confirmedMs, recency.pendingUse?.recencyMs ?? 0, recency.creationFallbackMs),
          } : item;
        }));
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
        if (pageRequestsRef.current.get(wsId) !== request) return;
        // Restore the pre-fetch state so a failed page can be retried.
        patchSessionPaging(wsId, {
          ready: before?.ready ?? false,
          loading: false,
          hasMore: before?.hasMore ?? false,
          nextCursor: before?.nextCursor ?? "",
          error: true,
        });
        if (pendingStaleRefreshRef.current.delete(wsId)) {
          void fetchSessionPage(wsId, "", false, true);
        }
      }
    },
    [disarmCatalogRefresh, patchSessionPaging, replaceSessionLists],
  );

  const disarmRecencyRefresh = useCallback((): void => {
    if (recencyTimerRef.current !== undefined) {
      window.clearInterval(recencyTimerRef.current);
      recencyTimerRef.current = undefined;
    }
  }, []);

  // Sole owner of the periodic recency cadence. The timer's identity depends
  // only on target membership changes, never on live-tick data: re-publishing
  // equal targets leaves the armed interval running on its original cadence.
  const setRecencyTargets = useCallback(
    (wsIds: readonly string[]): void => {
      const next: ReadonlySet<string> = new Set(wsIds);
      recencyTargetsRef.current = next;
      if (next.size === 0) {
        disarmRecencyRefresh();
        return;
      }
      // Arm once per nonempty run: membership changes (including another
      // owner joining or leaving) only update the set the armed interval
      // reads - they never reset its deadline, so a continuously live
      // workspace is refreshed on every cadence.
      if (recencyTimerRef.current !== undefined) return;
      recencyTimerRef.current = window.setInterval(() => {
        for (const wsId of recencyTargetsRef.current) {
          // Unready workspaces have no recency to refresh; in-flight pages
          // queue via the scheduled path.
          if (!sessionPagesRef.current.get(wsId)?.ready) continue;
          void fetchSessionPage(wsId, "", false, true);
        }
      }, RECENCY_REFRESH_INTERVAL_MS);
    },
    [disarmRecencyRefresh, fetchSessionPage],
  );

  // Pending eventual refreshes die with the hook.
  useEffect(() => () => {
    disarmAllCatalogRefreshes();
    disarmRecencyRefresh();
    recencyTargetsRef.current = new Set();
    pageRequestsRef.current.clear();
    recenciesRef.current.clear();
    if (loadRetryTimerRef.current !== undefined) {
      window.clearTimeout(loadRetryTimerRef.current);
      loadRetryTimerRef.current = undefined;
    }
    loadGenerationRef.current++;
  }, [disarmAllCatalogRefreshes, disarmRecencyRefresh]);

  // One discovery merge: re-fetches the workspace catalog and merges newly
  // auto-enrolled workspaces — and new chats of already-known workspaces —
  // into state. Strictly additive and identity-preserving: a catalog that
  // reports nothing new leaves every array untouched, optimistic local edits
  // (renames, pending creations) are never overwritten, and removals still
  // flow only through the explicit delete flows and load(). Reports whether
  // the response was applied: a failed fetch or a response the generation
  // guard discarded returns false so requestDiscovery can retry.
  const runDiscoveryMerge = useCallback(async (): Promise<boolean> => {
    // Snapshot the load generation before the request: a delete or reload that
    // lands while the catalog fetch is in flight bumps it, and the stale
    // response must be discarded instead of resurrecting what the user
    // removed.
    const generation = loadGenerationRef.current;
    let discovered: readonly Workspace[];
    try {
      discovered = await listWorkspaces();
    } catch {
      // Transient failure: requestDiscovery's bounded ladder retries.
      return false;
    }
    if (loadGenerationRef.current !== generation) return false;
    const { newlyExpanded, chatGrew } = mergeDiscoveredWorkspaces(workspacesRef.current, discovered);
    if (newlyExpanded.length > 0) {
      setExpanded((previous) => {
        const merged = new Set(previous);
        for (const id of newlyExpanded) merged.add(id);
        return merged;
      });
    }
    if (newlyExpanded.length > 0 || chatGrew.length > 0) {
      // Functional update: merge into whatever is committed when React runs
      // it, so a response that resolved against an older snapshot can never
      // overwrite rows a newer merge added.
      setWorkspaces((previous) => {
        const merged = mergeDiscoveredWorkspaces(previous, discovered);
        return merged.newlyExpanded.length > 0 || merged.chatGrew.length > 0 ? merged.workspaces : previous;
      });
    }
    // A known workspace whose server chats grew (an enrolled session bound to
    // an already-loaded workspace) refreshes its ready first page through the
    // scheduled path so the new row renders on this same cadence. New
    // workspaces need no help: the expand-effect fetches their first page.
    for (const wsId of chatGrew) {
      if (sessionPagesRef.current.get(wsId)?.ready) void fetchSessionPage(wsId, "", false, true);
    }
    return true;
  }, [fetchSessionPage, setExpanded]);

  // The single entry point of the event-driven design. Every trigger funnels
  // through here - App's live-id effect, the visibility fallback, and the
  // retry ladder below - so exactly one merge is ever in flight: a request (or
  // a retry that comes due) while a merge runs coalesces into one rerun
  // instead of starting a second concurrent fetch.
  const requestDiscovery = useCallback((): void => {
    if (!discoveryLiveRef.current) return;
    if (!discoveryLoadedRef.current) {
      // Nothing merges before the first load() settles: against the empty
      // pre-load list every catalog workspace looks newly sighted, and the
      // merge would expand all of them.
      discoveryQueuedBeforeLoadRef.current = true;
      return;
    }
    if (discoveryInFlightRef.current) {
      discoveryRerunRef.current = true;
      return;
    }
    discoveryInFlightRef.current = true;
    void runDiscoveryMerge().then((merged) => {
      discoveryInFlightRef.current = false;
      if (!discoveryLiveRef.current) return;
      if (merged) {
        discoveryRetryCountRef.current = 0;
        if (discoveryRetryTimerRef.current !== undefined) {
          window.clearTimeout(discoveryRetryTimerRef.current);
          discoveryRetryTimerRef.current = undefined;
        }
      } else if (discoveryRetryTimerRef.current === undefined
        && discoveryRetryCountRef.current < DISCOVERY_RETRY_DELAYS_MS.length) {
        const delay = DISCOVERY_RETRY_DELAYS_MS[discoveryRetryCountRef.current] ?? 0;
        discoveryRetryCountRef.current += 1;
        discoveryRetryTimerRef.current = window.setTimeout(() => {
          discoveryRetryTimerRef.current = undefined;
          // Back through the gate, never around it: a retry that comes due
          // while another merge is in flight coalesces instead of racing it.
          discoveryStartRef.current();
        }, delay);
      }
      if (discoveryRerunRef.current) {
        discoveryRerunRef.current = false;
        discoveryStartRef.current();
      }
    });
  }, [runDiscoveryMerge]);
  discoveryStartRef.current = requestDiscovery;

  // Visibility fallback: only a REST-created chat or workspace that was never
  // run reaches the catalog without a live frame, and a returning tab is
  // exactly when such a change has had time to happen elsewhere.
  useEffect(() => {
    if (!discoveryEnabled) return;
    const onVisibilityChange = (): void => {
      if (document.visibilityState === "visible") requestDiscovery();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [discoveryEnabled, requestDiscovery]);

  // Discovery lives exactly as long as discoveryEnabled: disabling (logout)
  // drops the coalesced rerun and any pending retry, and an in-flight response
  // that lands afterwards finds the gate closed.
  useEffect(() => {
    discoveryLiveRef.current = discoveryEnabled;
    if (discoveryEnabled) return;
    discoveryQueuedBeforeLoadRef.current = false;
    discoveryRerunRef.current = false;
    discoveryRetryCountRef.current = 0;
    if (discoveryRetryTimerRef.current !== undefined) {
      window.clearTimeout(discoveryRetryTimerRef.current);
      discoveryRetryTimerRef.current = undefined;
    }
    // A pending canonical-load retry dies with the session too: logout must
    // not keep probing the catalog on the way out.
    loadRetryCountRef.current = 0;
    if (loadRetryTimerRef.current !== undefined) {
      window.clearTimeout(loadRetryTimerRef.current);
      loadRetryTimerRef.current = undefined;
    }
  }, [discoveryEnabled]);

  useEffect(() => () => {
    discoveryLiveRef.current = false;
    discoveryQueuedBeforeLoadRef.current = false;
    discoveryRerunRef.current = false;
    if (discoveryRetryTimerRef.current !== undefined) {
      window.clearTimeout(discoveryRetryTimerRef.current);
      discoveryRetryTimerRef.current = undefined;
    }
  }, []);

  const load = useCallback(async (): Promise<void> => {
    const generation = ++loadGenerationRef.current;
    // A fresh load supersedes any pending ladder retry.
    if (loadRetryTimerRef.current !== undefined) {
      window.clearTimeout(loadRetryTimerRef.current);
      loadRetryTimerRef.current = undefined;
    }
    try {
      const loadedWorkspaces = await listWorkspaces();
      if (loadGenerationRef.current !== generation) return;
      setWorkspaces(loadedWorkspaces);
      // Mirror eagerly: the queued discovery request below may run before the
      // render that would normally refresh the ref, and merging against the
      // stale pre-load list would treat every catalog workspace as new.
      workspacesRef.current = loadedWorkspaces;
      const loadedIds = new Set(loadedWorkspaces.map((workspace) => workspace.id));
      setExpanded((previous) => new Set([...previous].filter((id) => loadedIds.has(id))));
      // A fresh canonical list invalidates the independently paged sidebar view.
      disarmAllCatalogRefreshes();
      pageRequestsRef.current.clear();
      replaceSessionLists(new Map([...sessionListsRef.current].filter(([id]) => loadedIds.has(id))));
      replaceSessionPages(new Map());
      for (const id of recenciesRef.current.keys()) if (!loadedIds.has(id)) recenciesRef.current.delete(id);
      loadRetryCountRef.current = 0;
    } catch {
      // A transient failure leaves an empty tree, and with no live id App never
      // requests discovery - the removed 20s poll used to be the only self
      // heal. Retry the canonical load on the bounded ladder instead: a newer
      // load, a delete, logout and unmount all cancel it.
      if (loadGenerationRef.current === generation
        && loadRetryTimerRef.current === undefined
        && loadRetryCountRef.current < DISCOVERY_RETRY_DELAYS_MS.length) {
        const delay = DISCOVERY_RETRY_DELAYS_MS[loadRetryCountRef.current] ?? 0;
        loadRetryCountRef.current += 1;
        loadRetryTimerRef.current = window.setTimeout(() => {
          loadRetryTimerRef.current = undefined;
          // Superseded by a newer load or a delete: stand down.
          if (loadGenerationRef.current !== generation) return;
          void loadRef.current();
        }, delay);
      }
    } finally {
      // The first settled load is what makes discovery safe (see
      // requestDiscovery); a request that arrived before it runs now, once.
      if (loadGenerationRef.current === generation) {
        discoveryLoadedRef.current = true;
        if (discoveryQueuedBeforeLoadRef.current) {
          discoveryQueuedBeforeLoadRef.current = false;
          requestDiscovery();
        }
      }
    }
  }, [disarmAllCatalogRefreshes, replaceSessionLists, replaceSessionPages, requestDiscovery, setExpanded]);
  loadRef.current = load;

  // The first page loads whenever a loaded workspace becomes expanded,
  // whichever action (chevron toggle, session select, chat creation) expanded it.
  useEffect(() => {
    for (const workspace of workspaces) {
      if (!expanded.has(workspace.id)) continue;
      const paging = sessionPagesRef.current.get(workspace.id);
      if (!paging?.ready && !paging?.loading) void fetchSessionPage(workspace.id, "", false);
    }
  }, [expanded, fetchSessionPage, workspaces]);

  const addCreatedSession = useCallback((wsId: string, tm: Terminal): void => {
    deletedSessionsRef.current.get(wsId)?.delete(tm.id);
    const recencies = recenciesRef.current.get(wsId) ?? new Map<string, SessionRecency>();
    const confirmedMs = recencies.get(tm.id)?.confirmedMs
      ?? sessionListsRef.current.get(wsId)?.find(item => item.id === tm.id)?.recencyMs ?? 0;
    const recency: SessionRecency = recencies.get(tm.id) ?? {
      confirmedMs, pendingUse: undefined, creationFallbackMs: confirmedMs > 0 ? 0 : Date.now(),
    };
    recency.confirmedMs = confirmedMs;
    recencies.set(tm.id, recency);
    recenciesRef.current.set(wsId, recencies);
    const created = {
      id: tm.id, name: tm.name, source: "stored" as const,
      recencyMs: Math.max(recency.confirmedMs, recency.pendingUse?.recencyMs ?? 0, recency.creationFallbackMs),
    };
    const mergeCreated = (items: readonly WorkspaceSession[]): readonly WorkspaceSession[] =>
      mergeWorkspaceSessions([...items, created]);
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

  // This boundary is called only by explicit App activation, never by WS lifecycle.
  const markSessionUsed = useCallback((wsId: string, id: string): void => {
    const listed = sessionListsRef.current.get(wsId) ?? [];
    const chat = workspaces.find(ws => ws.id === wsId)?.chats.find(row => row.id === id);
    const entry = listed.find(item => item.id === id)
      ?? pendingCreatedSessionsRef.current.get(wsId)?.find(item => item.id === id)
      ?? (chat ? { id, name: chat.name, source: "stored" as const, recencyMs: 0 } : undefined);
    if (!entry || deletedSessionsRef.current.get(wsId)?.has(id)) return;
    const recencies = recenciesRef.current.get(wsId) ?? new Map<string, SessionRecency>();
    const recency: SessionRecency = recencies.get(id) ?? {
      confirmedMs: entry.recencyMs, pendingUse: undefined, creationFallbackMs: 0,
    };
    const stamp = { recencyMs: Math.max(Date.now(), entry.recencyMs) };
    recency.pendingUse = stamp;
    recency.creationFallbackMs = 0;
    recencies.set(id, recency);
    recenciesRef.current.set(wsId, recencies);
    const apply = (recencyMs: number): void => {
      const current = sessionListsRef.current.get(wsId) ?? [];
      const updated = { ...(current.find(item => item.id === id) ?? entry), recencyMs };
      const next = new Map(sessionListsRef.current);
      next.set(wsId, mergeWorkspaceSessions([...current.filter(item => item.id !== id), updated]));
      replaceSessionLists(next);
      const pending = pendingCreatedSessionsRef.current.get(wsId);
      if (pending) pendingCreatedSessionsRef.current.set(wsId, pending.map(item => item.id === id ? updated : item));
    };
    apply(stamp.recencyMs);
    const settle = (recencyMs: number): void => {
      if (recenciesRef.current.get(wsId)?.get(id) !== recency) return;
      recency.confirmedMs = Math.max(recency.confirmedMs, recencyMs);
      if (recency.pendingUse === stamp) recency.pendingUse = undefined;
      apply(Math.max(recency.confirmedMs, recency.pendingUse?.recencyMs ?? 0));
    };
    void touchWorkspaceSession(wsId, id).then(settle).catch((error: unknown) => {
      if (!(error instanceof Error)) throw error;
      if (recenciesRef.current.get(wsId)?.get(id) !== recency || recency.pendingUse !== stamp) return;
      settle(0);
      notify(t("toast.error"), "error");
    });
  }, [notify, replaceSessionLists, t, workspaces]);

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
        if (item.dangling === true || map.has(item.id)) continue;
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
      loadGenerationRef.current++;
      pageRequestsRef.current.delete(ws.id);
      recenciesRef.current.delete(ws.id);
      deletedSessionsRef.current.delete(ws.id);
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
      loadGenerationRef.current++;
      const deleted = deletedSessionsRef.current.get(ws.id) ?? new Set<string>();
      deleted.add(tm.id);
      deletedSessionsRef.current.set(ws.id, deleted);
      recenciesRef.current.get(ws.id)?.delete(tm.id);
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
    setRecencyTargets,
    markSessionUsed,
    toggleExpanded,
    handleDeleteWorkspace,
    handleDeleteTerminal,
    handleRenameWorkspace,
    handleRenameTerminal,
    handleChatName,
    requestDiscovery,
  };
}
